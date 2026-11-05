import { fetchPublic, formatDate, money, PUBLIC_API_URL, Shell } from "../../lib";
import { PayInvoice } from "./PayInvoice";

const BADGES: Record<string, [string, string]> = {
  open: ["Open", ""],
  partially_paid: ["Partially paid", "warn"],
  overdue: ["Overdue", "bad"],
  paid: ["Paid", "good"],
  void: ["Void", ""],
};

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const invoice = await fetchPublic(`/invoices/${id}`);
  const [label, tone] = BADGES[invoice.status] ?? [invoice.status, ""];
  const payable = ["open", "partially_paid", "overdue"].includes(invoice.status);

  return (
    <Shell merchant={invoice.merchant} wide>
      <section className="card">
        <div className="row">
          <h1>Invoice {invoice.number}</h1>
          <span className={`badge ${tone}`}>{label}</span>
        </div>
        <div className="muted">
          {invoice.issued_at && <div>Issued {formatDate(invoice.issued_at)}</div>}
          {invoice.due_date && <div>Due {formatDate(invoice.due_date)}</div>}
        </div>
        <div>
          <div className="muted">Bill to</div>
          <div>{invoice.customer.name}</div>
          {invoice.customer.email && <div className="muted">{invoice.customer.email}</div>}
        </div>
      </section>

      <section className="card">
        {invoice.line_items.map((line: any, index: number) => (
          <div className="row" key={index}>
            <span>
              {line.description}
              {line.quantity > 1 ? ` × ${line.quantity}` : ""}
            </span>
            <span>{money(line.quantity * line.unit_amount)} USDT</span>
          </div>
        ))}
        {invoice.late_fee_amount > 0 && (
          <div className="row">
            <span>Late fee</span>
            <span>{money(invoice.late_fee_amount)} USDT</span>
          </div>
        )}
        <div className="row total">
          <span>Total</span>
          <span>{money(invoice.total)} USDT</span>
        </div>
        <div className="row muted">
          <span>Paid</span>
          <span>{money(invoice.amount_paid)} USDT</span>
        </div>
        <div className="row">
          <strong>Remaining</strong>
          <strong data-testid="remaining">{money(invoice.amount_remaining)} USDT</strong>
        </div>
        {invoice.notes && <p className="muted">{invoice.notes}</p>}
      </section>

      {payable && (
        <section className="card">
          <PayInvoice
            apiUrl={PUBLIC_API_URL}
            invoiceId={invoice.id}
            remaining={invoice.amount_remaining}
            allowPartial={invoice.allow_partial}
          />
        </section>
      )}

      {invoice.payments.length > 0 && (
        <section className="card">
          <h2>Payments</h2>
          {invoice.payments.map((payment: any) => (
            <div className="row" key={payment.id}>
              <span>
                {money(payment.amount)} USDT · {formatDate(payment.paid_at)}
              </span>
              <span>
                <a href={`/r/${payment.id}`}>Receipt</a> ·{" "}
                <a href={payment.explorer_url} target="_blank" rel="noreferrer">
                  Explorer
                </a>
              </span>
            </div>
          ))}
        </section>
      )}

      <a className="muted" href={`${PUBLIC_API_URL}/public/invoices/${invoice.id}/pdf`}>
        Download PDF
      </a>
    </Shell>
  );
}
