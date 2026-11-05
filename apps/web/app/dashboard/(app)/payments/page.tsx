import Link from "next/link";
import { api, Badge, date, label, Title, TxLink, usdt } from "../../lib";

const STATUSES = ["succeeded", "partially_refunded", "refunded"];
const SOURCES = ["api", "checkout", "link", "invoice"];

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; source?: string; q?: string }>;
}) {
  const filters = await searchParams;
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value) as [string, string][]);
  const { data } = await api(`/payments?${query}`);

  return (
    <>
      <Title>Payments</Title>
      <form className="filters">
        <input name="q" defaultValue={filters.q} placeholder="Order, invoice, wallet or tx hash" aria-label="Search" />
        <select name="status" defaultValue={filters.status ?? ""} aria-label="Status">
          <option value="">All statuses</option>
          {STATUSES.map((status) => (
            <option key={status} value={status}>
              {label(status)}
            </option>
          ))}
        </select>
        <select name="source" defaultValue={filters.source ?? ""} aria-label="Source">
          <option value="">All sources</option>
          {SOURCES.map((source) => (
            <option key={source} value={source}>
              {label(source)}
            </option>
          ))}
        </select>
        <button className="secondary">Filter</button>
      </form>

      <section className="card scroll">
        {data.length === 0 ? (
          <p className="muted">No payments match.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Reference</th>
                <th>Source</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {data.map((payment: any) => (
                <tr key={payment.id}>
                  <td>{date(payment.settled)}</td>
                  <td>
                    <Link href={`/dashboard/payments/${payment.id}`}>{usdt(payment.amount)}</Link>
                  </td>
                  <td>
                    <Badge status={payment.status} />
                  </td>
                  <td>{payment.reference}</td>
                  <td>{label(payment.source)}</td>
                  <td>
                    <TxLink url={payment.explorer_url} hash={payment.tx_hash} />
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
