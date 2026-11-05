import { cancelSubscription, retrySubscription } from "../../actions";
import { api, Badge, date, Kpi, Title, usdt } from "../../lib";

export default async function SubscriptionsPage() {
  const { data } = await api("/subscriptions");
  const details = await Promise.all(data.map((sub: any) => api(`/subscriptions/${sub.id}`)));

  const active = details.filter((sub) => sub.status === "active");
  const mrr = active.reduce((sum, sub) => sum + (sub.plan.amount * 2_592_000) / sub.plan.interval_seconds, 0);
  const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime() / 1000;

  return (
    <>
      <Title>Subscriptions</Title>
      <div className="kpis">
        <Kpi name="MRR" value={usdt(Math.round(mrr))} />
        <Kpi name="Active" value={String(active.length)} />
        <Kpi name="Past due" value={String(details.filter((sub) => sub.status === "past_due").length)} />
        <Kpi
          name="Cancelled this month"
          value={String(details.filter((sub) => sub.canceled_at && sub.canceled_at >= startOfMonth).length)}
        />
      </div>

      {details.length === 0 && (
        <section className="card">
          <p className="muted">No subscriptions yet.</p>
        </section>
      )}

      {details.map((sub) => {
        const live = sub.status === "active" || sub.status === "past_due";
        return (
          <section className="card" key={sub.id}>
            <div className="row">
              <strong>{sub.plan.name}</strong>
              <Badge status={sub.status} />
            </div>
            <div className="muted">
              {usdt(sub.plan.amount)} per {sub.plan.interval} · {sub.periods_charged} periods charged · next charge{" "}
              {date(sub.current_period_end)}
            </div>
            <div className="mono">{sub.settlekit.wallet}</div>
            {sub.charges.map((charge: any) => (
              <div className="row" key={charge.id}>
                <span>
                  Period {charge.period} · {usdt(charge.amount)} · {date(charge.date)} <Badge status={charge.status} />
                </span>
                <a href={charge.explorer_url} target="_blank" rel="noreferrer">
                  Explorer
                </a>
              </div>
            ))}
            {live && (
              <div className="actions">
                {sub.status === "past_due" && (
                  <form action={retrySubscription.bind(null, sub.id)}>
                    <button className="secondary">Retry now</button>
                  </form>
                )}
                <form action={cancelSubscription.bind(null, sub.id)}>
                  <button className="secondary">Cancel</button>
                </form>
              </div>
            )}
          </section>
        );
      })}
    </>
  );
}
