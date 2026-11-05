import type { Config } from "./config.ts";
import type { Queryable } from "./db.ts";
import { emitEvent, type EventSource } from "./events.ts";
import { newId } from "./ids.ts";

export type InvoiceLine = { description: string; quantity: number; unit_amount: number };
export type LateFee = { type: "percent" | "fixed"; value: number };

export type InvoiceRow = {
  id: string;
  merchant_id: string;
  number: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  line_items: InvoiceLine[];
  due_date: Date | null;
  late_fee: LateFee | null;
  allow_partial: boolean;
  status: string;
  amount_paid: string | number;
  total: string | number;
  currency: string;
  notes: string | null;
  reminders: boolean;
  issued_at: Date | null;
  created_at: Date;
};

export type InvoicePayment = {
  id: string;
  amount: string | number;
  tx_hash: string;
  confirmed_at: Date;
};

const SELECT_INVOICE = `
  SELECT i.*, c.name AS customer_name, c.email AS customer_email
  FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id`;

/** A percent late fee is whole percent, a fixed one is cents. It only applies once the due date has passed. */
export function lateFeeAmount(invoice: Pick<InvoiceRow, "late_fee" | "due_date" | "total">, now = new Date()) {
  const { late_fee: fee, due_date: due } = invoice;
  if (!fee || !due || now <= due) return 0;
  return fee.type === "fixed" ? fee.value : Math.round((Number(invoice.total) * fee.value) / 100);
}

export const amountDue = (invoice: Pick<InvoiceRow, "late_fee" | "due_date" | "total">, now = new Date()) =>
  Number(invoice.total) + lateFeeAmount(invoice, now);

export async function createInvoice(
  q: Queryable,
  merchantId: string,
  input: {
    customer: { name: string; email?: string };
    lineItems: InvoiceLine[];
    dueDate?: Date;
    lateFee?: LateFee;
    allowPartial: boolean;
    reminders?: boolean;
    notes?: string;
    currency: string;
  },
) {
  // The row lock from this UPDATE keeps concurrent invoices from sharing a number.
  const [merchant] = await q.query<{ invoice_prefix: string; invoice_seq: number }>(
    "UPDATE merchants SET invoice_seq = invoice_seq + 1 WHERE id = $1 RETURNING invoice_prefix, invoice_seq",
    [merchantId],
  );
  const year = new Date().getUTCFullYear();
  const number = `${merchant!.invoice_prefix}-${year}-${String(merchant!.invoice_seq).padStart(4, "0")}`;
  const total = input.lineItems.reduce((sum, line) => sum + line.quantity * line.unit_amount, 0);

  const customerId = newId("cus");
  await q.query("INSERT INTO customers (id, merchant_id, name, email) VALUES ($1, $2, $3, $4)", [
    customerId,
    merchantId,
    input.customer.name,
    input.customer.email ?? null,
  ]);

  const id = newId("in");
  await q.query(
    `INSERT INTO invoices
       (id, merchant_id, number, customer_id, line_items, due_date, late_fee, allow_partial, total, currency, notes, reminders)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, $10, $11, $12)`,
    [
      id,
      merchantId,
      number,
      customerId,
      JSON.stringify(input.lineItems),
      input.dueDate ?? null,
      input.lateFee ? JSON.stringify(input.lateFee) : null,
      input.allowPartial,
      total,
      input.currency,
      input.notes ?? null,
      input.reminders ?? true,
    ],
  );
  return (await getInvoice(q, id))!;
}

export async function getInvoice(q: Queryable, id: string, merchantId?: string) {
  const rows = await q.query<InvoiceRow>(
    `${SELECT_INVOICE} WHERE i.id = $1 ${merchantId ? "AND i.merchant_id = $2" : ""}`,
    merchantId ? [id, merchantId] : [id],
  );
  return rows[0];
}

export async function listInvoices(q: Queryable, merchantId: string, status: string | undefined, limit: number) {
  return q.query<InvoiceRow>(
    `${SELECT_INVOICE} WHERE i.merchant_id = $1 ${status ? "AND i.status = $3" : ""}
     ORDER BY i.created_at DESC, i.id LIMIT $2`,
    status ? [merchantId, limit, status] : [merchantId, limit],
  );
}

export const invoicePayments = (q: Queryable, invoiceId: string) =>
  q.query<InvoicePayment>(
    "SELECT id, amount, tx_hash, confirmed_at FROM payments WHERE invoice_id = $1 ORDER BY confirmed_at, id",
    [invoiceId],
  );

export function serializeInvoice(
  invoice: InvoiceRow,
  payments: InvoicePayment[],
  config: Pick<Config, "chainId" | "checkoutUrl" | "explorerUrl">,
) {
  const due = amountDue(invoice);
  const paid = Number(invoice.amount_paid);
  return {
    id: invoice.id,
    object: "invoice",
    number: invoice.number,
    status: invoice.status,
    currency: invoice.currency,
    customer: { name: invoice.customer_name, email: invoice.customer_email },
    line_items: invoice.line_items,
    subtotal: Number(invoice.total),
    late_fee: invoice.late_fee,
    late_fee_amount: lateFeeAmount(invoice),
    total: due,
    amount_paid: paid,
    amount_remaining: Math.max(due - paid, 0),
    allow_partial: invoice.allow_partial,
    notes: invoice.notes,
    due_date: invoice.due_date ? Math.floor(invoice.due_date.getTime() / 1000) : null,
    issued_at: invoice.issued_at ? Math.floor(invoice.issued_at.getTime() / 1000) : null,
    created: Math.floor(invoice.created_at.getTime() / 1000),
    hosted_invoice_url: `${config.checkoutUrl}/i/${invoice.id}`,
    payments: payments.map((payment) => ({
      id: payment.id,
      amount: Number(payment.amount),
      tx_hash: payment.tx_hash,
      explorer_url: `${config.explorerUrl}/tx/${payment.tx_hash}`,
      paid_at: Math.floor(payment.confirmed_at.getTime() / 1000),
    })),
  };
}

/** Adds a confirmed payment to its invoice and moves the invoice to paid or partially_paid. */
export async function recordInvoicePayment(
  q: Queryable,
  config: Config,
  invoiceId: string,
  amount: number,
  source: EventSource,
) {
  await q.query("UPDATE invoices SET amount_paid = amount_paid + $2 WHERE id = $1", [invoiceId, amount]);
  const invoice = (await getInvoice(q, invoiceId))!;
  const paidInFull = Number(invoice.amount_paid) >= amountDue(invoice);
  // An overdue invoice stays overdue until it is cleared, so a part payment can't re-trigger invoice.overdue.
  const status = paidInFull ? "paid" : invoice.status === "overdue" ? "overdue" : "partially_paid";
  await q.query("UPDATE invoices SET status = $2 WHERE id = $1", [invoiceId, status]);

  const updated = { ...invoice, status };
  await emitEvent(
    q,
    invoice.merchant_id,
    paidInFull ? "invoice.paid" : "invoice.payment_partially_paid",
    serializeInvoice(updated, await invoicePayments(q, invoiceId), config),
    source,
  );
}
