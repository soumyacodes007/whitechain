import { ActionForm, Submit } from "../../ActionForm";
import { addWebhook, replayEvent, rotateKey } from "../../actions";
import { api, Badge, date, Title } from "../../lib";

const SUPPORTED = [
  "Checkout Sessions (payment and subscription)",
  "Payment Intents, including cancel",
  "Refunds, full and partial",
  "Customers, Products and fixed Prices",
  "Subscriptions: get and cancel",
  "Events and Stripe-Signature webhooks",
];

export default async function DevelopersPage() {
  const [keys, endpoints, events, emails] = await Promise.all([
    api("/api_keys"),
    api("/webhook_endpoints"),
    api("/event_log"),
    api("/emails"),
  ]);
  const apiHost = process.env.PUBLIC_API_URL ?? process.env.API_URL ?? "http://localhost:4000";

  return (
    <>
      <Title>Developers</Title>

      <section className="card">
        <h2>API keys</h2>
        {keys.data.map((key: any) => (
          <div className="row" key={key.id}>
            <span>{key.type} test key</span>
            <span className="muted">
              Last used {key.last_used_at ? date(Math.floor(new Date(key.last_used_at).getTime() / 1000)) : "never"}
            </span>
          </div>
        ))}
        <p className="muted">Keys are stored hashed, so they can't be shown again. Rotating replaces the current key.</p>
        <ActionForm action={rotateKey}>
          <Submit className="secondary">Rotate secret key</Submit>
        </ActionForm>
      </section>

      <section className="card">
        <h2>Webhook endpoints</h2>
        {endpoints.data.map((endpoint: any) => (
          <div className="row" key={endpoint.id}>
            <span className="mono">{endpoint.url}</span>
            <span className="muted">
              {endpoint.delivered_24h} delivered in 24 h · {endpoint.failed} failed
            </span>
          </div>
        ))}
        <ActionForm action={addWebhook}>
          <label className="field">
            Endpoint URL
            <input name="url" type="url" required placeholder="https://example.com/webhooks" />
          </label>
          <Submit className="secondary">Add endpoint</Submit>
        </ActionForm>
      </section>

      <section className="card">
        <h2>Move from Stripe</h2>
        <p className="muted">Keep your Stripe code and change one line.</p>
        <pre className="code">{`const stripe = new Stripe(process.env.SETTLEKIT_SECRET_KEY, {
  host: "${new URL(apiHost).hostname}", // the one changed line
});`}</pre>
        <ul className="muted">
          {SUPPORTED.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Integration snippets</h2>
        <div className="muted">Script tag: create a payment link, then copy its button code.</div>
        <pre className="code">{`import { SettleCheckout } from "@settlekit/react";

<SettleCheckout clientSecret={intent.client_secret} onSuccess={onPaid} />`}</pre>
        <pre className="code">{`import { SettleKit } from "@settlekit/node";
const kit = new SettleKit(process.env.SETTLEKIT_SECRET_KEY);
const intent = await kit.paymentIntents.create({ amount: 50000, currency: "usdt" });`}</pre>
      </section>

      <section className="card scroll">
        <h2>Email log</h2>
        <p className="muted">Mail shows as logged when no email provider is configured.</p>
        {emails.data.length === 0 ? (
          <p className="muted">No emails yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Subject</th>
                <th>To</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {emails.data.map((email: any) => (
                <tr key={email.id}>
                  <td>{email.subject}</td>
                  <td>{email.to_address}</td>
                  <td>
                    <Badge status={email.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card scroll">
        <h2>Event log</h2>
        {events.data.length === 0 ? (
          <p className="muted">No events yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Date</th>
                <th>Delivery</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {events.data.map((event: any) => (
                <tr key={event.id}>
                  <td>{event.type}</td>
                  <td>{date(event.created_at)}</td>
                  <td>
                    {event.deliveries.length === 0 && <span className="muted">No endpoint</span>}
                    {event.deliveries.map((delivery: any) => (
                      <span key={delivery.id}>
                        <Badge status={delivery.status} /> {delivery.status_code ?? "–"} · {delivery.attempt} tries
                      </span>
                    ))}
                  </td>
                  <td>
                    {event.deliveries.length > 0 && (
                      <form action={replayEvent.bind(null, event.id)}>
                        <button className="link">Replay</button>
                      </form>
                    )}
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
