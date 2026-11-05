import type { Config } from "./config.ts";
import { addWallet, customerForWallet } from "./customers.ts";
import type { Queryable } from "./db.ts";
import { queueReceipt } from "./emails.ts";
import { emitEvent, type EventSource } from "./events.ts";
import type { IntentRow } from "./intents.ts";
import { recordInvoicePayment } from "./invoices.ts";
import { serializeSession, type SessionRow } from "./sessions.ts";

/** Everything a confirmed payment changes beyond its intent. Runs in the indexer's transaction. */
export async function applySettlement(
  q: Queryable,
  config: Config,
  intent: IntentRow & { status: string; tx_hash: string; payer: string },
  paymentId: string,
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

  const email = intent.customer_email ?? session?.customer_email;
  if (intent.customer_id) {
    await addWallet(q, intent.customer_id, intent.payer);
  } else {
    const customerId = await customerForWallet(q, intent.merchant_id, intent.payer, email);
    await q.query("UPDATE payment_intents SET customer_id = $2 WHERE id = $1", [intent.id, customerId]);
  }

  const [contact] = await q.query<{ email: string | null }>(
    "SELECT c.email FROM customers c JOIN payment_intents i ON i.customer_id = c.id WHERE i.id = $1",
    [intent.id],
  );
  const to = email ?? contact?.email;
  if (to) {
    await queueReceipt(q, config, {
      merchantId: intent.merchant_id,
      to,
      paymentId,
      amount: Number(intent.amount),
      txHash: intent.tx_hash,
    });
  }
}
