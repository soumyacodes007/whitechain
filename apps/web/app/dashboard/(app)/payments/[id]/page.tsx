import { ActionForm, Submit } from "../../../ActionForm";
import { refund, resendReceipt } from "../../../actions";
import { api, Badge, date, label, Title, TxLink, usdt } from "../../../lib";

const REASONS = ["requested_by_customer", "duplicate", "cancelled_item", "other"];

export default async function PaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const payment = await api(`/payments/${id}`);
  const refundable = payment.net;

  return (
    <>
      <Title action={<Badge status={payment.status} />}>{usdt(payment.amount)}</Title>

      <div className="columns">
        <section className="card">
          <h2>Summary</h2>
          <div className="row"><span className="muted">Net</span><span>{usdt(payment.net)}</span></div>
          <div className="row"><span className="muted">Reference</span><span>{payment.reference}</span></div>
          <div className="row"><span className="muted">Source</span><span>{label(payment.source)}</span></div>
          <div className="row"><span className="muted">Created</span><span>{date(payment.created)}</span></div>
          <div className="row"><span className="muted">Settled</span><span>{date(payment.settled)}</span></div>
          {payment.late_settlement && <p className="badge warn">Paid after the checkout expired</p>}
        </section>

        <section className="card">
          <h2>Onchain</h2>
          <div className="row"><span className="muted">Payer</span><span className="mono">{payment.payer}</span></div>
          <div className="row"><span className="muted">Block</span><span>{payment.block_number}</span></div>
          <div className="row"><span className="muted">Confirmations</span><span>{payment.confirmations ?? "–"}</span></div>
          <div className="row"><span className="muted">Gas paid by</span><span>{label(payment.gas_paid_by)}</span></div>
          <div className="row"><span className="muted">Transaction</span><TxLink url={payment.explorer_url} hash={payment.tx_hash} /></div>
        </section>
      </div>

      {refundable > 0 && (
        <section className="card">
          <h2>Refund</h2>
          <ActionForm action={refund}>
            <input type="hidden" name="payment_intent" value={payment.payment_intent} />
            <label className="field">
              Amount, up to {usdt(refundable)}
              <input
                name="amount"
                type="number"
                step="0.01"
                min="0.01"
                max={(refundable / 100).toFixed(2)}
                defaultValue={(refundable / 100).toFixed(2)}
                required
              />
            </label>
            <label className="field">
              Reason
              <select name="reason">
                {REASONS.map((reason) => (
                  <option key={reason} value={reason}>
                    {label(reason)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Note to customer (optional)
              <input name="note" maxLength={500} />
            </label>
            <Submit>Send refund</Submit>
          </ActionForm>
        </section>
      )}

      {payment.refunds.length > 0 && (
        <section className="card">
          <h2>Refunds</h2>
          {payment.refunds.map((item: any) => (
            <div className="row" key={item.id}>
              <span>
                {usdt(item.amount)} · {label(item.reason)} · {date(item.date)} <Badge status={item.status} />
              </span>
              <TxLink url={item.explorer_url} />
            </div>
          ))}
        </section>
      )}

      <section className="card">
        <h2>Webhook deliveries</h2>
        {payment.webhook_deliveries.length === 0 && <p className="muted">No endpoints were subscribed.</p>}
        {payment.webhook_deliveries.map((delivery: any) => (
          <div className="row" key={delivery.id}>
            <span>{delivery.type}</span>
            <span>
              {delivery.status_code ?? "–"} · {delivery.attempts} attempts <Badge status={delivery.status} />
            </span>
          </div>
        ))}
      </section>

      <section className="card">
        <div className="row">
          <a href={`/r/${payment.id}`}>Open customer receipt</a>
          <ActionForm action={resendReceipt.bind(null, payment.id)} className="inline">
            <Submit className="secondary">Resend receipt</Submit>
          </ActionForm>
        </div>
      </section>
    </>
  );
}
