import Link from "next/link";
import { api, date, Kpi, label, TxLink, Title, usdt } from "../lib";
import { VolumeChart } from "./VolumeChart";

export default async function HomePage() {
  const data = await api("/overview");

  return (
    <>
      <Title
        action={
          <div className="actions">
            <Link className="secondary" href="/dashboard/invoices/new">
              New invoice
            </Link>
            <Link className="secondary" href="/dashboard/links">
              New payment link
            </Link>
            <Link className="secondary" href="/dashboard/payments">
              Issue refund
            </Link>
          </div>
        }
      >
        Home
      </Title>

      <div className="kpis">
        <Kpi name="Gross, 30 days" value={usdt(data.volume.month)} note={`Today ${usdt(data.volume.today)} · 7 days ${usdt(data.volume.week)}`} />
        <Kpi name="Net after refunds" value={usdt(data.net)} note={`Refund rate ${data.refund_rate.toFixed(1)}%`} />
        <Kpi name="Open invoices" value={usdt(data.invoices.open)} note={`Overdue ${usdt(data.invoices.overdue)}`} />
        <Kpi name="Active subscriptions" value={String(data.subscriptions.active)} note={`MRR ${usdt(data.subscriptions.mrr)}`} />
      </div>

      <section className="card">
        <VolumeChart days={data.daily} />
      </section>

      <div className="columns">
        <section className="card">
          <h2>Needs attention</h2>
          {data.attention.length === 0 && <p className="muted">Nothing needs you right now.</p>}
          {data.attention.map((item: any) => (
            <Link key={item.kind} href={item.href}>
              {item.message}
            </Link>
          ))}
        </section>

        <section className="card">
          <h2>Wallet</h2>
          {data.wallet ? (
            <>
              <div className="mono">{data.wallet.address}</div>
              <div className="row">
                <span className="muted">USDT balance</span>
                <span>{data.wallet.usdt.toFixed(2)}</span>
              </div>
              <div className="row">
                <span className="muted">WBT balance</span>
                <span>{data.wallet.wbt === null ? "–" : data.wallet.wbt.toFixed(4)}</span>
              </div>
            </>
          ) : (
            <p className="muted">Wallet balance is unavailable right now.</p>
          )}
        </section>
      </div>

      <section className="card">
        <h2>Recent activity</h2>
        {data.activity.length === 0 && <p className="muted">No activity yet.</p>}
        {data.activity.map((event: any) => (
          <div className="row" key={event.id}>
            <span>
              {label(event.type.replaceAll(".", " "))} · <span className="muted">{date(event.date)}</span>
            </span>
            <TxLink url={event.explorer_url} />
          </div>
        ))}
      </section>
    </>
  );
}
