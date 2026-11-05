import { fetchPublic, money, PUBLIC_API_URL, Shell } from "../../lib";
import { Checkout } from "./Checkout";
import { Subscribe } from "./Subscribe";

export default async function CheckoutPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await fetchPublic(`/checkout/${id}`);

  if (session.mode === "subscription") {
    const period = session.subscribe.interval_seconds >= 2_000_000 ? "month" : "week";
    return (
      <Shell merchant={session.merchant}>
        <section className="card">
          <div className="row">
            <span>{session.line_items[0].name}</span>
            <span>
              {money(session.amount)} USDT / {period}
            </span>
          </div>
          <p className="muted">≈ ${money(session.amount)} per {period}</p>
        </section>
        <section className="card">
          {session.expired && session.status !== "complete" ? (
            <p className="error">This checkout expired. Return to the store and try again.</p>
          ) : (
            <Subscribe
              apiUrl={PUBLIC_API_URL}
              sessionId={session.id}
              params={session.subscribe}
              amount={session.amount}
              brandColor={session.merchant.brand_color}
              merchantName={session.merchant.name}
              successUrl={session.success_url}
            />
          )}
        </section>
      </Shell>
    );
  }

  const { intent } = session;

  return (
    <Shell merchant={intent.merchant}>
      <section className="card">
        {session.line_items.map((item: any) => (
          <div className="row" key={item.name}>
            <span>
              {item.name}
              {item.quantity > 1 ? ` × ${item.quantity}` : ""}
            </span>
            <span>{money(item.quantity * item.unit_amount)} USDT</span>
          </div>
        ))}
        <div className="row total">
          <span>Total</span>
          <span>{money(intent.amount)} USDT</span>
        </div>
        <p className="muted">≈ ${money(intent.amount)}</p>
      </section>

      <section className="card">
        <Checkout
          apiUrl={PUBLIC_API_URL}
          clientSecret={intent.client_secret}
          expiresAt={intent.expires_at}
          merchantName={intent.merchant.name}
          successUrl={session.success_url}
          cancelUrl={session.cancel_url}
          paymentId={intent.payment_id}
        />
      </section>
    </Shell>
  );
}
