import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { emitEvent } from "./events.ts";
import type { IntentRow } from "./intents.ts";
import { getInvoice, invoicePayments, serializeInvoice } from "./invoices.ts";
import { serializeSession, type SessionRow } from "./sessions.ts";

/** Expires unpaid checkout sessions. A payment inside the grace window still settles as late_settlement. */
export async function expireSessions(db: Db, config: Config) {
  const expired = await db.query<SessionRow & { intent_expires_at: Date }>(
    `SELECT s.*, i.expires_at AS intent_expires_at FROM checkout_sessions s
     JOIN payment_intents i ON i.id = s.intent_id
     WHERE s.status = 'open' AND i.expires_at < now() AND i.status = 'requires_payment_method'`,
  );

  for (const row of expired) {
    await db.tx(async (q) => {
      const moved = await q.query<SessionRow>(
        "UPDATE checkout_sessions SET status = 'expired' WHERE id = $1 AND status = 'open' RETURNING *",
        [row.id],
      );
      if (moved.length === 0) return;
      const [intent] = await q.query<IntentRow>(
        "UPDATE payment_intents SET status = 'canceled' WHERE id = $1 AND status = 'requires_payment_method' RETURNING *",
        [row.intent_id],
      );
      if (!intent) return;
      await emitEvent(q, row.merchant_id, "checkout.session.expired", serializeSession(moved[0]!, intent, config));
    });
  }
}

/** Subscription sessions have no intent, so they expire on their own timer. */
export async function expireSubscriptionSessions(db: Db) {
  await db.query(
    "UPDATE checkout_sessions SET status = 'expired' WHERE mode = 'subscription' AND status = 'open' AND expires_at < now()",
  );
}

/** Marks sent invoices overdue once their due date passes. */
export async function markInvoicesOverdue(db: Db, config: Config) {
  const due = await db.query<{ id: string }>(
    `SELECT id FROM invoices WHERE status IN ('open', 'partially_paid') AND due_date < now()`,
  );

  for (const { id } of due) {
    await db.tx(async (q) => {
      const moved = await q.query(
        "UPDATE invoices SET status = 'overdue' WHERE id = $1 AND status IN ('open', 'partially_paid') RETURNING id",
        [id],
      );
      if (moved.length === 0) return;
      const invoice = (await getInvoice(q, id))!;
      await emitEvent(
        q,
        invoice.merchant_id,
        "invoice.overdue",
        serializeInvoice(invoice, await invoicePayments(q, id), config),
      );
    });
  }
}
