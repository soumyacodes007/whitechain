import type { AddressInfo } from "node:net";
import { SettleKit, SettleKitError } from "@settlekit/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import type { Db } from "../src/db.ts";
import { createMerchant } from "../src/merchants.ts";
import { createTestDb } from "./testDb.ts";
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
  subscriptionsAddress: "0x5C648cc785526432bec6d6B3C5Fb729cA6311aD6",
  permitName: "Tether USD",
  permitVersion: "1",
  signerKey: `0x${"ab".repeat(32)}`,
  operatorKey: `0x${"ab".repeat(32)}`,
  startBlock: 0n,
};

const WALLET = "0x0000000000000000000000000000000000000abc";

describe("@settlekit/node against the real API", () => {
  let db: Db;
  let app: ReturnType<typeof buildApp>;
  let kit: SettleKit;

  beforeAll(async () => {
    db = await createTestDb();
    app = buildApp({ db, config });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const { secretKey } = await createMerchant(db, {
      name: "A",
      merchantAddress: WALLET,
      payoutWallet: WALLET,
      refundWallet: WALLET,
    });
    kit = new SettleKit(secretKey, { baseUrl: `http://127.0.0.1:${port}` });
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it("creates an intent the way the PRD example does", async () => {
    const orderId = "PF-1";
    const params = { amount: 50000, currency: "usdt", metadata: { orderId } };
    const first = await kit.paymentIntents.create(params, { idempotencyKey: orderId });
    const again = await kit.paymentIntents.create(params, { idempotencyKey: orderId });

    expect(first.client_secret).toBeTruthy();
    expect(again.id).toBe(first.id);
    expect((await kit.paymentIntents.retrieve(first.id)).metadata.orderId).toBe(orderId);
  });

  it("raises API errors with their code and param", async () => {
    const failure = await kit.paymentIntents.create({ amount: 0, currency: "usd" }).catch((error) => error);
    expect(failure).toBeInstanceOf(SettleKitError);
    expect(failure).toMatchObject({ status: 400, param: "amount" });
  });

  it("verifies the signature the dispatcher produces", () => {
    const body = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
    expect(kit.webhooks.constructEvent(body, signatureHeader(body, "whsec_x"), "whsec_x").type).toBe("invoice.paid");
  });
});
