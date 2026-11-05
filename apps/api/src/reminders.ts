import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { queueReminder } from "./emails.ts";
import { newId } from "./ids.ts";
import { amountDue, getInvoice, type InvoiceRow } from "./invoices.ts";

const DAY = 86_400_000;

/** Which scheduled reminder an invoice is due for right now. The latest stage wins. */
export function reminderKind(dueDate: Date, now = new Date()) {
  const daysUntilDue = (dueDate.getTime() - now.getTime()) / DAY;
  if (daysUntilDue <= -3) return "overdue";
  if (daysUntilDue <= 0) return "due_today";
  if (daysUntilDue <= 3) return "before_due";
  return null;
}

export async function recordAndSendReminder(db: Db, config: Config, invoice: InvoiceRow, kind: string) {
  if (!invoice.customer_email) return false;

  return db.tx(async (q) => {
    const inserted = await q.query(
      `INSERT INTO reminders (id, invoice_id, kind) VALUES ($1, $2, $3)
       ON CONFLICT (invoice_id, kind) WHERE kind <> 'manual' DO NOTHING
       RETURNING id`,
      [newId("rem"), invoice.id, kind],
    );
    if (inserted.length === 0) return false;

    await queueReminder(q, config, {
      merchantId: invoice.merchant_id,
      to: invoice.customer_email!,
      invoiceId: invoice.id,
      number: invoice.number,
      remaining: amountDue(invoice) - Number(invoice.amount_paid),
      dueDate: invoice.due_date,
      kind,
    });
    return true;
  });
}

export async function sendDueReminders(db: Db, config: Config) {
  const invoices = await db.query<{ id: string }>(
    `SELECT i.id FROM invoices i JOIN merchants m ON m.id = i.merchant_id
     WHERE i.status IN ('open', 'partially_paid', 'overdue')
       AND i.reminders AND m.reminders_enabled AND i.due_date IS NOT NULL
       AND i.due_date < now() + interval '3 days'`,
  );

  for (const { id } of invoices) {
    const invoice = (await getInvoice(db, id))!;
    const kind = reminderKind(invoice.due_date!);
    if (kind) await recordAndSendReminder(db, config, invoice, kind);
  }
}
