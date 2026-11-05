import { type ChildProcess, spawn } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  type Hex,
  http as httpTransport,
  parseAbi,
  publicActions,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { createDb, type Db } from "../src/db.ts";
import { createIndexer } from "../src/indexer.ts";
import { createMerchant } from "../src/merchants.ts";
import { dispatchDue, RETRY_DELAYS_SECONDS } from "../src/webhooks.ts";

const PORT = 18545;
const CHAIN_ID = 31337;
const RPC = `http://127.0.0.1:${PORT}`;
const ANVIL_KEYS: Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  `0x${"c0".repeat(32)}`,
];
const [deployer, merchantAccount, customer] = ANVIL_KEYS.map((key) => privateKeyToAccount(key)) as [
  ReturnType<typeof privateKeyToAccount>,
  ReturnType<typeof privateKeyToAccount>,
  ReturnType<typeof privateKeyToAccount>,
];

const chain = defineChain({
  id: CHAIN_ID,
  name: "anvil",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const artifact = (name: string) => {
  const path = new URL(`../../../contracts/out/${name}.sol/${name}.json`, import.meta.url);
  const json = JSON.parse(readFileSync(path, "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object as Hex };
};

const paymentsAbi = parseAbi([
  "function registerMerchant(address payout, address refundWallet, address refundOperator)",
  "function pay(bytes32 intentId, address merchant, uint256 amount, uint256 deadline, bytes sig)",
  "function refund(bytes32 intentId, uint256 amount, uint8 reasonCode)",
]);
const usdtAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

/** A merchant's webhook receiver that verifies signatures and fulfils each event id once. */
function createReceiver(secret: () => string) {
  const received: any[] = [];
  const fulfilled = new Set<string>();
  const duplicates: string[] = [];
  let failNext = 0;

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk)).on("end", () => {
      const header = String(req.headers["settlekit-signature"]);
      const [, t, v1] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(header) ?? [];
      const expected = createHmac("sha256", secret()).update(`${t}.${body}`).digest();
      if (!v1 || !timingSafeEqual(expected, Buffer.from(v1, "hex"))) {
        res.statusCode = 400;
        return res.end();
      }
      if (failNext > 0) {
        failNext--;
        res.statusCode = 500;
        return res.end();
      }
      const event = JSON.parse(body);
      received.push(event);
      if (fulfilled.has(event.id)) duplicates.push(event.id);
      fulfilled.add(event.id);
      res.end();
    });
  });

  return {
    server,
    received,
    duplicates,
    failTimes: (times: number) => (failNext = times),
    types: () => received.map((event) => event.type),
  };
}

describe("payment to webhook, on a local chain", () => {
  let anvil: ChildProcess;
  let db: Db;
  let app: ReturnType<typeof buildApp>;
  let key: string;
  let webhookSecret = "";
  let payments: Address;
  let usdt: Address;
  let indexer: ReturnType<typeof createIndexer>;
  const receiver = createReceiver(() => webhookSecret);

  const testClient = createTestClient({ chain, mode: "anvil", transport: httpTransport(RPC) }).extend(publicActions);
  const walletOf = (account: typeof deployer) =>
    createWalletClient({ account, chain, transport: httpTransport(RPC) });

  const send = async (account: typeof deployer, request: any) => {
    const hash = await walletOf(account).writeContract(request);
    const receipt = await testClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
    return hash;
  };

  const deploy = async (name: string, args: unknown[]) => {
    const { abi, bytecode } = artifact(name);
    const hash = await walletOf(deployer).deployContract({ abi, bytecode, args });
    return (await testClient.waitForTransactionReceipt({ hash })).contractAddress!;
  };

  const api = (method: "GET" | "POST", url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { authorization: `Bearer ${key}` } });

  /** Runs what a real checkout page does: fetch the signed params, then call pay. */
  const pay = async (clientSecret: string) => {
    const { pay } = (await app.inject({ url: `/public/payment_intents/${clientSecret}` })).json();
    return send(customer, {
      address: pay.contract,
      abi: paymentsAbi,
      functionName: "pay",
      args: [pay.intent_id, pay.merchant, BigInt(pay.amount), BigInt(pay.deadline), pay.signature],
    });
  };

  const newIntent = async (amount: number, orderId: string) =>
    (await api("POST", "/v1/payment_intents", { amount, currency: "usd", metadata: { orderId } })).json();

  beforeAll(async () => {
    const local = join(homedir(), ".foundry", "bin", "anvil.exe");
    anvil = spawn(existsSync(local) ? local : "anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      try {
        await testClient.getBlockNumber();
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    await testClient.setBalance({ address: customer.address, value: 10n ** 18n });

    usdt = await deploy("MockUSDT", []);
    payments = await deploy("SettleKitPayments", [usdt, deployer.address, deployer.address]);

    await send(merchantAccount, {
      address: payments,
      abi: paymentsAbi,
      functionName: "registerMerchant",
      args: [merchantAccount.address, merchantAccount.address, deployer.address],
    });
    for (const account of [customer, merchantAccount]) {
      await send(account, { address: usdt, abi: usdtAbi, functionName: "mint", args: [account.address, 10_000_000000n] });
      await send(account, { address: usdt, abi: usdtAbi, functionName: "approve", args: [payments, 2n ** 96n] });
    }

    const config: Config = {
      port: 0,
      dataDir: "",
      rpcUrl: RPC,
      explorerUrl: "https://explorer.test",
      checkoutUrl: "http://checkout.test",
      chainId: CHAIN_ID,
      paymentsAddress: payments,
      usdtAddress: usdt,
      signerKey: ANVIL_KEYS[0]!,
      startBlock: 0n,
    };

    db = await createDb({});
    app = buildApp({ db, config });
    key = (
      await createMerchant(db, {
        name: "PixelForge Studio",
        merchantAddress: merchantAccount.address,
        payoutWallet: merchantAccount.address,
        refundWallet: merchantAccount.address,
      })
    ).secretKey;
    const client = createPublicClient({ chain, transport: httpTransport(RPC) });
    indexer = createIndexer(db, client as any, config);

    await new Promise<void>((resolve) => receiver.server.listen(0, "127.0.0.1", resolve));
    const { port } = receiver.server.address() as AddressInfo;
    webhookSecret = (await api("POST", "/v1/webhook_endpoints", { url: `http://127.0.0.1:${port}/hook` })).json().secret;
  });

  afterAll(async () => {
    receiver.server.close();
    await db?.close();
    anvil?.kill();
  });

  it("moves an intent through processing to succeeded and delivers both webhooks", async () => {
    const intent = await newIntent(50000, "PF-1042");
    const hash = await pay(intent.client_secret);

    await indexer.tick();
    expect((await api("GET", `/v1/payment_intents/${intent.id}`)).json().status).toBe("processing");

    await testClient.mine({ blocks: 2 });
    await indexer.tick();
    await dispatchDue(db);

    const final = (await api("GET", `/v1/payment_intents/${intent.id}`)).json();
    expect(final.status).toBe("succeeded");
    expect(final.settlekit).toMatchObject({
      tx_hash: hash,
      payer: customer.address,
      explorer_url: `https://explorer.test/tx/${hash}`,
    });
    expect(receiver.types()).toEqual(expect.arrayContaining(["payment_intent.processing", "payment_intent.succeeded"]));

    const succeeded = receiver.received.find((e) => e.type === "payment_intent.succeeded");
    expect(succeeded.id).toContain(hash);
    expect(succeeded.data.object.metadata.orderId).toBe("PF-1042");
  });

  it("never emits a second event when the same logs are scanned again", async () => {
    const before = (await db.query("SELECT count(*)::int AS n FROM events"))[0].n;
    await db.query("UPDATE indexer_state SET next_block = 0");
    await indexer.tick();
    await dispatchDue(db);
    expect((await db.query("SELECT count(*)::int AS n FROM events"))[0].n).toBe(before);
    expect(receiver.duplicates).toEqual([]);
  });

  it("delivers exactly once to fulfilment after the merchant's server was down", async () => {
    const intent = await newIntent(1000, "PF-DOWN");
    await pay(intent.client_secret);
    await testClient.mine({ blocks: 2 });

    receiver.failTimes(1);
    await indexer.tick();
    await dispatchDue(db);

    const eventId = `payment_intent.succeeded`;
    const [delivery] = await db.query(
      `SELECT d.status, d.attempt, d.status_code,
              extract(epoch FROM d.next_retry_at - now()) AS wait
       FROM webhook_deliveries d JOIN events e ON e.id = d.event_id
       WHERE e.type = $1 AND e.payload->'data'->'object'->>'id' = $2`,
      [eventId, intent.id],
    );
    expect(delivery).toMatchObject({ status: "pending", attempt: 1, status_code: 500 });
    expect(Number(delivery.wait)).toBeGreaterThan(50);

    // Nothing is sent early.
    await dispatchDue(db);
    expect(receiver.received.some((e) => e.data.object.id === intent.id && e.type === eventId)).toBe(false);

    await db.query("UPDATE webhook_deliveries SET next_retry_at = now() WHERE status = 'pending'");
    await dispatchDue(db);
    const matching = receiver.received.filter((e) => e.data.object.id === intent.id && e.type === eventId);
    expect(matching).toHaveLength(1);
    expect(receiver.duplicates).toEqual([]);
  });

  it("marks a delivery failed after the first try plus every retry", async () => {
    const intent = await newIntent(1100, "PF-DEAD");
    await pay(intent.client_secret);
    await testClient.mine({ blocks: 2 });
    await indexer.tick();

    const attempts = RETRY_DELAYS_SECONDS.length + 1;
    receiver.failTimes(attempts * 2);
    for (let i = 0; i < attempts; i++) {
      await db.query("UPDATE webhook_deliveries SET next_retry_at = now() WHERE status = 'pending'");
      await dispatchDue(db);
    }
    receiver.failTimes(0);

    const rows = await db.query(
      `SELECT d.status, d.attempt FROM webhook_deliveries d JOIN events e ON e.id = d.event_id
       WHERE e.payload->'data'->'object'->>'id' = $1 AND e.type = 'payment_intent.succeeded'`,
      [intent.id],
    );
    expect(rows[0]).toMatchObject({ status: "failed", attempt: 8 });
  });

  it("records a partial refund onchain and emits refund events once", async () => {
    const intent = await newIntent(50000, "PF-REFUND");
    await pay(intent.client_secret);
    await testClient.mine({ blocks: 2 });
    await indexer.tick();

    const { pay: params } = (await app.inject({ url: `/public/payment_intents/${intent.client_secret}` })).json();
    await send(merchantAccount, {
      address: payments,
      abi: paymentsAbi,
      functionName: "refund",
      args: [params.intent_id, 100_000000n, 2],
    });
    await testClient.mine({ blocks: 2 });
    await indexer.tick();
    await indexer.tick();
    await dispatchDue(db);

    const refunds = await db.query("SELECT amount, reason, status FROM refunds");
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ reason: "cancelled_item", status: "succeeded" });
    expect(Number(refunds[0].amount)).toBe(10000);

    const charge = receiver.received.find((e) => e.type === "charge.refunded");
    expect(charge.data.object).toMatchObject({ amount: 50000, amount_refunded: 10000, refunded: false });
    expect(receiver.types().filter((type) => type === "refund.created")).toHaveLength(1);
  });

  it("flags a payment confirmed after expiry as a late settlement", async () => {
    const intent = await newIntent(2000, "PF-LATE");
    await db.query("UPDATE payment_intents SET expires_at = now() - interval '1 minute' WHERE id = $1", [intent.id]);
    await pay(intent.client_secret);
    await testClient.mine({ blocks: 2 });
    await indexer.tick();

    const final = (await api("GET", `/v1/payment_intents/${intent.id}`)).json();
    expect(final.status).toBe("succeeded");
    expect(final.settlekit.late_settlement).toBe(true);
  });
});
