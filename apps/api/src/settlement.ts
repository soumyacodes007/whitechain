import type { Config } from "./config.ts";
import type { Queryable } from "./db.ts";
import { emitEvent, type EventSource } from "./events.ts";
import type { IntentRow } from "./intents.ts";
import { recordInvoicePayment } from "./invoices.ts";
import { serializeSession, type SessionRow } from "./sessions.ts";

/** Everything a confirmed payment changes beyond its intent. Runs in the indexer's transaction. */
export async function applySettlement(
  q: Queryable,
  config: Config,
  intent: IntentRow & { status: string; tx_hash: string; payer: string },
  source: EventSource,
) {
  const [session] = await q.query<SessionRow>(
    "UPDATE checkout_sessions SET status = 'complete' WHERE intent_id = $1 RETURNING *",
    [intent.id],
  );
  if (session) {
    await emitEvent(
      q,
      intent.merchant_id,
      "checkout.session.completed",
      serializeSession(session, intent, config),
      source,
    );
    if (session.payment_link_id) {
      await q.query("UPDATE payment_links SET times_paid = times_paid + 1 WHERE id = $1", [session.payment_link_id]);
    }
  }

  if (intent.invoice_id) {
    await recordInvoicePayment(q, config, intent.invoice_id, Number(intent.amount), source);
  }
}
