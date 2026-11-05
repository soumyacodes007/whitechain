import { api, Badge, date, Kpi, label, Title, TxLink, usdt } from "../../lib";

export default async function RefundsPage({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const { reason } = await searchParams;
  const { data } = await api("/refunds");
  const settled = data.filter((refund: any) => refund.status !== "failed");

  const totals = new Map<string, number>();
  for (const refund of settled) totals.set(refund.reason, (totals.get(refund.reason) ?? 0) + refund.amount);
  const rows = reason ? data.filter((refund: any) => refund.reason === reason) : data;

  return (
    <>
      <Title>Refunds</Title>
      {totals.size > 0 && (
        <div className="kpis">
          {[...totals].map(([name, amount]) => (
            <a key={name} href={`/dashboard/refunds?reason=${name}`}>
              <Kpi name={label(name)} value={usdt(amount)} />
            </a>
          ))}
        </div>
      )}

      <section className="card scroll">
        {rows.length === 0 ? (
          <p className="muted">No refunds yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Amount</th>
                <th>Reason</th>
                <th>Payment</th>
                <th>Status</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((refund: any) => (
                <tr key={refund.id}>
                  <td>{date(refund.created)}</td>
                  <td>{usdt(refund.amount)}</td>
                  <td>{refund.reason ? label(refund.reason) : "–"}</td>
                  <td className="mono">{refund.payment_intent}</td>
                  <td>
                    <Badge status={refund.status} />
                  </td>
                  <td>
                    <TxLink url={refund.settlekit.explorer_url} hash={refund.settlekit.tx_hash} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
