import { ActionForm, Submit } from "../../../ActionForm";
import { invoiceAction } from "../../../actions";
import { api, Badge, date, Title, TxLink, usdt } from "../../../lib";

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const invoice = await api(`/invoices/${id}`);
  const draft = invoice.status === "draft";
  const voidable = ["draft", "open", "overdue"].includes(invoice.status) && invoice.amount_paid === 0;

  return (
    <>
      <Title action={<Badge status={invoice.status} />}>Invoice {invoice.number}</Title>

      <div className="columns">
        <section className="card">
          <div className="row"><span className="muted">Customer</span><span>{invoice.customer.name}</span></div>
          <div className="row"><span className="muted">Email</span><span>{invoice.customer.email ?? "–"}</span></div>
          <div className="row"><span className="muted">Issued</span><span>{date(invoice.issued_at)}</span></div>
          <div className="row"><span className="muted">Due</span><span>{date(invoice.due_date)}</span></div>
          <div className="row"><span className="muted">Partial payments</span><span>{invoice.allow_partial ? "Allowed" : "Not allowed"}</span></div>
        </section>
        <section className="card">
          {invoice.line_items.map((line: any, index: number) => (
            <div className="row" key={index}>
              <span>{line.description}{line.quantity > 1 ? ` × ${line.quantity}` : ""}</span>
              <span>{usdt(line.quantity * line.unit_amount)}</span>
            </div>
          ))}
          {invoice.late_fee_amount > 0 && (
            <div className="row"><span>Late fee</span><span>{usdt(invoice.late_fee_amount)}</span></div>
          )}
          <div className="row total"><span>Total</span><span>{usdt(invoice.total)}</span></div>
          <div className="row"><span className="muted">Remaining</span><span>{usdt(invoice.amount_remaining)}</span></div>
        </section>
      </div>

      <section className="card">
        <div className="actions">
          {draft && (
            <ActionForm action={invoiceAction.bind(null, id, "send")} className="inline">
              <Submit>Send invoice</Submit>
            </ActionForm>
          )}
          {voidable && (
            <ActionForm action={invoiceAction.bind(null, id, "void")} className="inline">
              <Submit className="secondary">Void</Submit>
            </ActionForm>
          )}
          {!draft && (
            <a className="secondary" href={invoice.hosted_invoice_url} target="_blank" rel="noreferrer">
              Open customer page
            </a>
          )}
        </div>
        {!draft && <div className="mono">{invoice.hosted_invoice_url}</div>}
        {draft && <p className="muted">Sending makes the invoice payable. Emails aren't sent yet, so share the link.</p>}
      </section>

      <section className="card">
        <h2>Payments</h2>
        {invoice.payments.length === 0 && <p className="muted">No payments yet.</p>}
        {invoice.payments.map((payment: any) => (
          <div className="row" key={payment.id}>
            <span>{usdt(payment.amount)} · {date(payment.paid_at)}</span>
            <TxLink url={payment.explorer_url} hash={payment.tx_hash} />
          </div>
        ))}
      </section>
    </>
  );
}
