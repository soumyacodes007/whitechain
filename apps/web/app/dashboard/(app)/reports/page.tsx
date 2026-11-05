import { matchTransfer } from "../../actions";
import { api, Badge, date, Kpi, Title, TxLink, usdt } from "../../lib";

function period(which: string | undefined, fromDay?: string, toDay?: string) {
  const now = new Date();
  const utc = (year: number, month: number) => Date.UTC(year, month, 1) / 1000;
  if (which === "custom" && fromDay && toDay) {
    return { from: Date.parse(fromDay) / 1000, to: Date.parse(toDay) / 1000 + 86_400 };
  }
  if (which === "last") {
    return { from: utc(now.getUTCFullYear(), now.getUTCMonth() - 1), to: utc(now.getUTCFullYear(), now.getUTCMonth()) };
  }
  return { from: utc(now.getUTCFullYear(), now.getUTCMonth()), to: utc(now.getUTCFullYear(), now.getUTCMonth() + 1) };
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string; timezone?: string }>;
}) {
  const params = await searchParams;
  const { from, to } = period(params.period, params.from, params.to);
  const timezone = params.timezone || (await api("/account")).timezone;
  const query = new URLSearchParams({ from: String(from), to: String(to), timezone }).toString();
  const report = await api(`/reports?${query}`);
  const { summary } = report;

  return (
    <>
      <Title>Reports & export</Title>

      <form className="filters">
        <select name="period" defaultValue={params.period ?? "this"} aria-label="Period">
          <option value="this">This month</option>
          <option value="last">Last month</option>
          <option value="custom">Custom range</option>
        </select>
        <input name="from" type="date" defaultValue={params.from} aria-label="From" />
        <input name="to" type="date" defaultValue={params.to} aria-label="To" />
        <input name="timezone" defaultValue={timezone} aria-label="Timezone" />
        <button className="secondary">Apply</button>
      </form>

      <div className="kpis">
        <Kpi name="Gross" value={usdt(summary.gross)} note={`${summary.payments} payments`} />
        <Kpi name="Refunds" value={usdt(summary.refunds)} />
        <Kpi name="Network fees paid by you" value={usdt(summary.fees)} />
        <Kpi name="Net" value={usdt(summary.net)} note={`Invoices: ${summary.invoices_on_time} on time, ${summary.invoices_late} late`} />
      </div>

      <section className="card">
        <div className="actions">
          <a className="secondary" href={`/dashboard/export?kind=export.csv&${query}`}>
            Export CSV
          </a>
          <a className="secondary" href={`/dashboard/export?kind=export.xlsx&${query}`}>
            Export XLSX
          </a>
          <a className="primary" href={`/dashboard/export?kind=accountant-pack.zip&${query}`}>
            Accountant pack
          </a>
        </div>
      </section>

      <section className="card scroll">
        <h2>Reconciliation</h2>
        {report.reconciliation.length === 0 ? (
          <p className="muted">No transfers into your wallet in this period.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Linked to</th>
                <th>Flags</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {report.reconciliation.map((row: any) => (
                <tr key={row.id}>
                  <td>{date(row.date)}</td>
                  <td>{usdt(row.amount)}</td>
                  <td>
                    <Badge status={row.status} />
                  </td>
                  <td>
                    {row.status === "matched" ? (
                      row.reference
                    ) : (
                      <form action={matchTransfer.bind(null, row.id)} className="filters">
                        <input name="reference" placeholder="Invoice or order" required aria-label="Reference" />
                        <button className="secondary">Match</button>
                      </form>
                    )}
                  </td>
                  <td>{row.flags.join(", ") || "–"}</td>
                  <td>
                    <TxLink url={row.explorer_url} />
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
