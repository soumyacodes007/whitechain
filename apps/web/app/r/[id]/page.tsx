import { fetchPublic, formatDate, money, Shell } from "../../lib";

const STATUSES: Record<string, string> = {
  paid: "Paid",
  partially_refunded: "Partially refunded",
  refunded: "Refunded",
};

const REASONS: Record<string, string> = {
  requested_by_customer: "Requested by customer",
  duplicate: "Duplicate payment",
  cancelled_item: "Item cancelled",
  other: "Other",
};

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const receipt = await fetchPublic(`/receipts/${id}`);

  return (
    <Shell merchant={receipt.merchant}>
      <section className="card">
        <div className="status" data-testid="receipt-status">
          {STATUSES[receipt.status]}
        </div>
        <div className="row total">
          <span>Amount paid</span>
          <span>{money(receipt.amount)} USDT</span>
        </div>
        <div className="row">
          <span className="muted">Date</span>
          <span>{formatDate(receipt.paid_at)}</span>
        </div>
        <div className="row">
          <span className="muted">Reference</span>
          <span>{receipt.reference}</span>
        </div>
        <div className="row">
          <span className="muted">Paid from</span>
          <span className="mono">{receipt.payer}</span>
        </div>
      </section>

      <section className="card">
        <h2>Verify this payment</h2>
        <div className="verify">
          <div className="mono">{receipt.tx_hash}</div>
          <div className="muted">
            Block {receipt.block_number}
            {receipt.confirmations !== null ? ` · ${receipt.confirmations} confirmations` : ""}
          </div>
          <a href={receipt.explorer_url} target="_blank" rel="noreferrer">
            View on Whitechain explorer
          </a>
        </div>
        <p className="muted">This record lives on Whitechain and can be checked without SettleKit.</p>
      </section>

      {receipt.refunds.length > 0 && (
        <section className="card">
          <h2>Refunds</h2>
          {receipt.refunds.map((refund: any) => (
            <div className="row" key={refund.id}>
              <span>
                {money(refund.amount)} USDT · {REASONS[refund.reason] ?? refund.reason} · {formatDate(refund.date)}
              </span>
              {refund.explorer_url && (
                <a href={refund.explorer_url} target="_blank" rel="noreferrer">
                  Explorer
                </a>
              )}
            </div>
          ))}
          <div className="row total">
            <span>Net paid</span>
            <span>{money(receipt.net)} USDT</span>
          </div>
        </section>
      )}
    </Shell>
  );
}
