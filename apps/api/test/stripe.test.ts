import type { AddressInfo } from "node:net";
import Stripe from "stripe";
import { beforeAll, describe, expect, it } from "vitest";
import { dispatchDue } from "../src/webhooks.ts";
import { useChain } from "./harness.ts";

// Uses the official stripe package with only the host changed, which is the claim being tested.
const chain = useChain(18548);
let stripe: Stripe;

beforeAll(async () => {
  await chain.app().listen({ port: 0, host: "127.0.0.1" });
  const { port } = chain.app().server.address() as AddressInfo;
  stripe = new Stripe(chain.key(), { host: "127.0.0.1", port, protocol: "http" });
});

const confirm = async () => {
  await chain.mine();
  await chain.indexer().tick();
  await chain.indexer().tick();
};

const payThrough = async (paymentIntent: string) => {
  const row = (await chain.db().query("SELECT client_secret FROM payment_intents WHERE id = $1", [paymentIntent]))[0];
  await chain.pay(row.client_secret);
  await confirm();
};

describe("the official stripe package, pointed at SettleKit", () => {
  it("runs checkout, webhook verification and a partial refund", async () => {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 2,
          price_data: { currency: "usd", unit_amount: 2000, product_data: { name: "Stubborn Attachments" } },
        },
      ],
      success_url: "http://localhost:4242/success.html",
      cancel_url: "http://localhost:4242/cancel.html",
      metadata: { orderId: "SAMPLE-1" },
    });
    expect(session.url).toContain(session.id);
    expect(session.amount_total).toBe(4000);

    await payThrough(session.payment_intent as string);

    const retrieved = await stripe.checkout.sessions.retrieve(session.id);
    expect(retrieved.status).toBe("complete");
    expect(retrieved.payment_status).toBe("paid");

    await dispatchDue(chain.db());
    const raw = chain.receiver.raw.find((entry) => JSON.parse(entry.body).type === "checkout.session.completed")!;
    const event = stripe.webhooks.constructEvent(raw.body, raw.stripeSignature, chain.webhookSecret());
    expect(event.type).toBe("checkout.session.completed");
    expect(() => stripe.webhooks.constructEvent(`${raw.body} `, raw.stripeSignature, chain.webhookSecret())).toThrow();

    const refund = await stripe.refunds.create({ payment_intent: session.payment_intent as string, amount: 1500 });
    expect(refund.status).toBe("pending");
    await confirm();
    expect((await stripe.refunds.retrieve(refund.id)).status).toBe("succeeded");
  });

  it("creates a saved price and checks out with it, as Stripe's sample does", async () => {
    const product = await stripe.products.create({ name: "Brand Kit" });
    const price = await stripe.prices.create({ unit_amount: 50000, currency: "usd", product: product.id });
    expect((await stripe.prices.retrieve(price.id)).unit_amount).toBe(50000);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: price.id, quantity: 1 }],
      success_url: "http://localhost:4242/success.html?session_id={CHECKOUT_SESSION_ID}",
    });
    expect(session.amount_total).toBe(50000);
    expect(session.success_url).toBe(`http://localhost:4242/success.html?session_id=${session.id}`);
  });

  it("creates a subscription session from a recurring price", async () => {
    const price = await stripe.prices.create({
      unit_amount: 30000,
      currency: "usd",
      recurring: { interval: "month" },
      product_data: { name: "Retainer" },
    });
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: price.id, quantity: 1 }],
      success_url: "http://localhost:4242/success.html",
    });
    expect(session.url).toContain(session.id);
    expect(session.mode).toBe("subscription");
  });

  it("handles payment intents and customers", async () => {
    const intent = await stripe.paymentIntents.create({ amount: 1099, currency: "usd", metadata: { a: "1" } });
    expect(intent.status).toBe("requires_payment_method");
    expect((await stripe.paymentIntents.retrieve(intent.id)).metadata.a).toBe("1");
    expect((await stripe.paymentIntents.cancel(intent.id)).status).toBe("canceled");

    const customer = await stripe.customers.create({ email: "mark@example.com", name: "Mark" });
    expect((await stripe.customers.retrieve(customer.id)) as Stripe.Customer).toMatchObject({ email: "mark@example.com" });
  });

  it("lists events for replay", async () => {
    const events = await stripe.events.list({ limit: 3 });
    expect(events.data.length).toBeGreaterThan(0);
    expect((await stripe.events.retrieve(events.data[0]!.id)).id).toBe(events.data[0]!.id);
  });

  it("raises Stripe's own error types", async () => {
    const missing = await stripe.paymentIntents.retrieve("pi_missing").catch((error) => error);
    expect(missing).toBeInstanceOf(Stripe.errors.StripeInvalidRequestError);
    expect(missing.code).toBe("resource_missing");

    const unsupported = await stripe.disputes.list().catch((error) => error);
    expect(unsupported).toBeInstanceOf(Stripe.errors.StripeInvalidRequestError);
    expect(unsupported.code).toBe("unsupported_on_settlekit");

    const card = await stripe.paymentMethods.create({ type: "card" } as any).catch((error) => error);
    expect(card.code).toBe("unsupported_on_settlekit");
  });
});
