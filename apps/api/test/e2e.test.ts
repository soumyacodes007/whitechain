import { describe, expect, it } from "vitest";
import { dispatchDue, RETRY_DELAYS_SECONDS } from "../src/webhooks.ts";
import { customer, useChain } from "./harness.ts";

const chain = useChain(38546);

const newIntent = async (amount: number, orderId: string) =>
  (await chain.api("POST", "/v1/payment_intents", { amount, currency: "usd", metadata: { orderId } })).json();

const getIntent = async (id: string) => (await chain.api("GET", `/v1/payment_intents/${id}`)).json();

describe("payment to webhook, on a local chain", () => {
  it("moves an intent through processing to succeeded and delivers both webhooks", async () => {
    const intent = await newIntent(50000, "PF-1042");
    const hash = await chain.pay(intent.client_secret);

    await chain.indexer().tick();
    expect((await getIntent(intent.id)).status).toBe("processing");

    await chain.mine();
    await chain.indexer().tick();
    await dispatchDue(chain.db());

    const final = await getIntent(intent.id);
    expect(final.status).toBe("succeeded");
    expect(final.settlekit).toMatchObject({
      tx_hash: hash,
      payer: customer.address,
      explorer_url: `https://explorer.test/tx/${hash}`,
    });
    expect(chain.receiver.types()).toEqual(
      expect.arrayContaining(["payment_intent.processing", "payment_intent.succeeded"]),
    );

    const succeeded = chain.receiver.received.find((e) => e.type === "payment_intent.succeeded");
    expect(succeeded.id).toContain(hash);
    expect(succeeded.data.object.metadata.orderId).toBe("PF-1042");
  });

  it("never emits a second event when the same logs are scanned again", async () => {
    const count = async () => (await chain.db().query("SELECT count(*)::int AS n FROM events"))[0].n;
    const before = await count();
    await chain.db().query("UPDATE indexer_state SET next_block = 0");
    await chain.indexer().tick();
    await dispatchDue(chain.db());
    expect(await count()).toBe(before);
    expect(chain.receiver.duplicates).toEqual([]);
  });

  it("delivers exactly once to fulfilment after the merchant's server was down", async () => {
    const type = "payment_intent.succeeded";
    const intent = await newIntent(1000, "PF-DOWN");
    await chain.pay(intent.client_secret);
    await chain.mine();

    chain.receiver.failTimes(1);
    await chain.indexer().tick();
    await dispatchDue(chain.db());

    const [delivery] = await chain.db().query(
      `SELECT d.status, d.attempt, d.status_code, extract(epoch FROM d.next_retry_at - now()) AS wait
       FROM webhook_deliveries d JOIN events e ON e.id = d.event_id
       WHERE e.type = $1 AND e.payload->'data'->'object'->>'id' = $2`,
      [type, intent.id],
    );
    expect(delivery).toMatchObject({ status: "pending", attempt: 1, status_code: 500 });
    expect(Number(delivery.wait)).toBeGreaterThan(50);

    const matching = () => chain.receiver.received.filter((e) => e.data.object.id === intent.id && e.type === type);

    // Nothing is sent early.
    await dispatchDue(chain.db());
    expect(matching()).toHaveLength(0);

    await chain.db().query("UPDATE webhook_deliveries SET next_retry_at = now() WHERE status = 'pending'");
    await dispatchDue(chain.db());
    expect(matching()).toHaveLength(1);
    expect(chain.receiver.duplicates).toEqual([]);
  });

  it("marks a delivery failed after the first try plus every retry", async () => {
    const intent = await newIntent(1100, "PF-DEAD");
    await chain.pay(intent.client_secret);
    await chain.mine();
    await chain.indexer().tick();

    const attempts = RETRY_DELAYS_SECONDS.length + 1;
    chain.receiver.failTimes(attempts * 2);
    for (let i = 0; i < attempts; i++) {
      await chain.db().query("UPDATE webhook_deliveries SET next_retry_at = now() WHERE status = 'pending'");
      await dispatchDue(chain.db());
    }
    chain.receiver.failTimes(0);

    const rows = await chain.db().query(
      `SELECT d.status, d.attempt FROM webhook_deliveries d JOIN events e ON e.id = d.event_id
       WHERE e.payload->'data'->'object'->>'id' = $1 AND e.type = 'payment_intent.succeeded'`,
      [intent.id],
    );
    expect(rows[0]).toMatchObject({ status: "failed", attempt: 8 });
  });

  it("records a partial refund onchain and emits refund events once", async () => {
    const intent = await newIntent(50000, "PF-REFUND");
    await chain.pay(intent.client_secret);
    await chain.mine();
    await chain.indexer().tick();

    const { pay } = (await chain.app().inject({ url: `/public/payment_intents/${intent.client_secret}` })).json();
    await chain.refund(pay.intent_id, 100_000000n, 2);
    await chain.mine();
    await chain.indexer().tick();
    await chain.indexer().tick();
    await dispatchDue(chain.db());

    const refunds = await chain.db().query("SELECT amount, reason, status FROM refunds");
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ reason: "cancelled_item", status: "succeeded" });
    expect(Number(refunds[0].amount)).toBe(10000);

    const charge = chain.receiver.received.find((e) => e.type === "charge.refunded");
    expect(charge.data.object).toMatchObject({ amount: 50000, amount_refunded: 10000, refunded: false });
    expect(chain.receiver.types().filter((type) => type === "refund.created")).toHaveLength(1);
  });

  it("flags a payment confirmed after expiry as a late settlement", async () => {
    const intent = await newIntent(2000, "PF-LATE");
    await chain.db().query("UPDATE payment_intents SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      intent.id,
    ]);
    await chain.pay(intent.client_secret);
    await chain.mine();
    await chain.indexer().tick();

    const final = await getIntent(intent.id);
    expect(final.status).toBe("succeeded");
    expect(final.settlekit.late_settlement).toBe(true);
  });
});
