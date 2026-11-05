import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { createDb, type Db } from "../src/db.ts";
import { createMerchant } from "../src/merchants.ts";
import { signatureHeader } from "../src/webhooks.ts";

const config: Config = {
  port: 0,
  dataDir: "",
  rpcUrl: "http://unused.test",
  explorerUrl: "https://explorer.test",
  checkoutUrl: "http://checkout.test",
  chainId: 1874,
  paymentsAddress: "0xD59EDe989E27d8CaAEebb8305897d51d61Dc299d",
  usdtAddress: "0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7",
  signerKey: `0x${"ab".repeat(32)}`,
  startBlock: 0n,
};

const WALLET = "0x0000000000000000000000000000000000000abc";
const OTHER_WALLET = "0x0000000000000000000000000000000000000def";

let db: Db;
let app: ReturnType<typeof buildApp>;
let key: string;
let otherKey: string;

const post = (url: string, payload: object, headers: Record<string, string> = {}, secret = key) =>
  app.inject({ method: "POST", url, payload, headers: { authorization: `Bearer ${secret}`, ...headers } });
const get = (url: string, secret = key) =>
  app.inject({ method: "GET", url, headers: { authorization: `Bearer ${secret}` } });

beforeAll(async () => {
  db = await createDb({});
  app = buildApp({ db, config });
  key = (await createMerchant(db, { name: "A", merchantAddress: WALLET, payoutWallet: WALLET, refundWallet: WALLET }))
    .secretKey;
  otherKey = (
    await createMerchant(db, {
      name: "B",
      merchantAddress: OTHER_WALLET,
      payoutWallet: OTHER_WALLET,
      refundWallet: OTHER_WALLET,
    })
  ).secretKey;
});

describe("auth", () => {
  it("rejects a bad key with a Stripe-shaped error", async () => {
    const res = await post("/v1/payment_intents", { amount: 100, currency: "usd" }, {}, "sk_test_wrong");
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatchObject({ type: "invalid_request_error", code: "api_key_invalid" });
  });
});

describe("payment intents", () => {
  it("creates an intent", async () => {
    const res = await post("/v1/payment_intents", { amount: 50000, currency: "usdt", metadata: { orderId: "PF-1042" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      object: "payment_intent",
      amount: 50000,
      status: "requires_payment_method",
      metadata: { orderId: "PF-1042" },
      settlekit: { chain_id: 1874, tx_hash: null },
    });
  });

  it("accepts the form encoding the Stripe SDK sends", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/payment_intents",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" },
      payload: "amount=2500&currency=usd&metadata[orderId]=A1",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ amount: 2500, currency: "usd", metadata: { orderId: "A1" } });
  });

  it.each([
    [{ amount: 0, currency: "usd" }, "amount"],
    [{ amount: 10.5, currency: "usd" }, "amount"],
    [{ amount: 100, currency: "eur" }, "currency"],
  ])("rejects %j", async (payload, param) => {
    const res = await post("/v1/payment_intents", payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.param).toBe(param);
  });

  it("hides one merchant's intents from another", async () => {
    const { id } = (await post("/v1/payment_intents", { amount: 100, currency: "usd" })).json();
    expect((await get(`/v1/payment_intents/${id}`)).statusCode).toBe(200);
    expect((await get(`/v1/payment_intents/${id}`, otherKey)).statusCode).toBe(404);
  });

  it("cancels once, then refuses", async () => {
    const { id } = (await post("/v1/payment_intents", { amount: 100, currency: "usd" })).json();
    const first = await post(`/v1/payment_intents/${id}/cancel`, {});
    expect(first.json().status).toBe("canceled");

    const second = await post(`/v1/payment_intents/${id}/cancel`, {});
    expect(second.statusCode).toBe(400);
    expect(second.json().error.code).toBe("payment_intent_unexpected_state");
  });

  it("gives checkout everything it needs to pay, including the signed amount in USDT units", async () => {
    const { client_secret } = (await post("/v1/payment_intents", { amount: 50000, currency: "usd" })).json();
    const res = await app.inject({ method: "GET", url: `/public/payment_intents/${client_secret}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().pay).toMatchObject({ amount: "500000000", merchant: WALLET, chain_id: 1874 });
    expect(res.json().pay.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });
});

describe("idempotency", () => {
  const body = { amount: 700, currency: "usd" };

  it("replays the first response", async () => {
    const first = await post("/v1/payment_intents", body, { "idempotency-key": "k1" });
    const second = await post("/v1/payment_intents", body, { "idempotency-key": "k1" });
    expect(second.json().id).toBe(first.json().id);
    expect(second.headers["idempotent-replayed"]).toBe("true");
  });

  it("rejects the same key with different parameters", async () => {
    await post("/v1/payment_intents", body, { "idempotency-key": "k2" });
    const res = await post("/v1/payment_intents", { ...body, amount: 701 }, { "idempotency-key": "k2" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("idempotency_key_reused");
  });

  it("scopes keys to the merchant", async () => {
    const mine = await post("/v1/payment_intents", body, { "idempotency-key": "k3" });
    const theirs = await post("/v1/payment_intents", body, { "idempotency-key": "k3" }, otherKey);
    expect(theirs.json().id).not.toBe(mine.json().id);
  });

  it("creates one intent when the same key arrives concurrently", async () => {
    const results = await Promise.all(
      [1, 2, 3].map(() => post("/v1/payment_intents", body, { "idempotency-key": "k4" })),
    );
    const ids = new Set(results.filter((r) => r.statusCode === 200).map((r) => r.json().id));
    expect(ids.size).toBe(1);
  });

  it("expires keys after 24 hours", async () => {
    const first = await post("/v1/payment_intents", body, { "idempotency-key": "k5" });
    await db.query("UPDATE idempotency_keys SET created_at = now() - interval '25 hours' WHERE key = 'k5'");
    const second = await post("/v1/payment_intents", body, { "idempotency-key": "k5" });
    expect(second.json().id).not.toBe(first.json().id);
  });
});

describe("webhook signatures", () => {
  it("uses the t.payload HMAC scheme", () => {
    const expected = createHmac("sha256", "whsec_x").update("1700000000.{}").digest("hex");
    expect(signatureHeader("{}", "whsec_x", 1700000000)).toBe(`t=1700000000,v1=${expected}`);
  });
});

describe("events", () => {
  it("404s in the Stripe shape", async () => {
    const res = await get("/v1/events/evt_missing");
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("resource_missing");
  });
});
