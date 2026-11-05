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
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, expect } from "vitest";
import { buildApp } from "../src/app.ts";
import { type ChainWriter, createChainWriter } from "../src/chain.ts";
import type { Config } from "../src/config.ts";
import type { Db } from "../src/db.ts";
import { createIndexer } from "../src/indexer.ts";
import { createMerchant } from "../src/merchants.ts";
import { createTestDb } from "./testDb.ts";

const CHAIN_ID = 31337;
const DEPLOYER_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const MERCHANT_KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const CUSTOMER_KEY: Hex = `0x${"c0".repeat(32)}`;

export const deployer = privateKeyToAccount(DEPLOYER_KEY);
export const merchantAccount = privateKeyToAccount(MERCHANT_KEY);
export const customer = privateKeyToAccount(CUSTOMER_KEY);

const paymentsAbi = parseAbi([
  "function registerMerchant(address payout, address refundWallet, address refundOperator)",
  "function pay(bytes32 intentId, address merchant, uint256 amount, uint256 deadline, bytes sig)",
  "function refund(bytes32 intentId, uint256 amount, uint8 reasonCode)",
]);
const usdtAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);
const subscriptionsAbi = parseAbi([
  "function subscribe(address merchant, uint256 amount, uint32 interval, uint32 maxPeriods) returns (uint256)",
  "function cancel(uint256 subId)",
]);

const artifact = (name: string) => {
  const path = new URL(`../../../contracts/out/${name}.sol/${name}.json`, import.meta.url);
  const json = JSON.parse(readFileSync(path, "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object as Hex };
};

/** A merchant's webhook receiver that verifies signatures and fulfils each event id once. */
function createReceiver(secret: () => string) {
  const received: any[] = [];
  const raw: { body: string; stripeSignature: string }[] = [];
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
      raw.push({ body, stripeSignature: String(req.headers["stripe-signature"]) });
      if (fulfilled.has(event.id)) duplicates.push(event.id);
      fulfilled.add(event.id);
      res.end();
    });
  });

  return {
    server,
    received,
    raw,
    duplicates,
    failTimes: (times: number) => (failNext = times),
    types: () => received.map((event) => event.type),
  };
}

/** Runs anvil with the real contracts, the API and a webhook receiver for one test file. */
export function useChain(port = 38545) {
  const rpc = `http://127.0.0.1:${port}`;
  const chain = defineChain({
    id: CHAIN_ID,
    name: "anvil",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });

  let anvil: ChildProcess;
  let db: Db;
  let app: ReturnType<typeof buildApp>;
  let key: string;
  let webhookSecret = "";
  let payments: Address;
  let usdt: Address;
  let subscriptions: Address;
  let config: Config;
  let indexer: ReturnType<typeof createIndexer>;
  let writer: ChainWriter;
  const receiver = createReceiver(() => webhookSecret);

  const testClient = createTestClient({ chain, mode: "anvil", transport: httpTransport(rpc) }).extend(publicActions);
  const walletOf = (account: PrivateKeyAccount) => createWalletClient({ account, chain, transport: httpTransport(rpc) });

  const send = async (account: PrivateKeyAccount, request: any) => {
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

  beforeAll(async () => {
    const local = join(homedir(), ".foundry", "bin", "anvil.exe");
    anvil = spawn(existsSync(local) ? local : "anvil", ["--port", String(port), "--silent"], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      try {
        await testClient.getBlockNumber();
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    // Another chain on this port would fail in confusing ways, so say so directly.
    const client_ = await testClient.request({ method: "web3_clientVersion" } as any);
    if (!String(client_).toLowerCase().includes("anvil")) {
      throw new Error(`Port ${port} is held by ${client_}, not anvil. Free it or change the test port.`);
    }

    await testClient.setBalance({ address: customer.address, value: 10n ** 18n });

    usdt = await deploy("MockUSDT", []);
    payments = await deploy("SettleKitPayments", [usdt, deployer.address, deployer.address]);
    subscriptions = await deploy("SettleKitSubscriptions", [usdt, payments, deployer.address, deployer.address]);

    await send(merchantAccount, {
      address: payments,
      abi: paymentsAbi,
      functionName: "registerMerchant",
      args: [merchantAccount.address, merchantAccount.address, deployer.address],
    });
    await send(customer, { address: usdt, abi: usdtAbi, functionName: "approve", args: [subscriptions, 2n ** 96n] });
    for (const account of [customer, merchantAccount]) {
      await send(account, { address: usdt, abi: usdtAbi, functionName: "mint", args: [account.address, 100_000_000000n] });
      await send(account, { address: usdt, abi: usdtAbi, functionName: "approve", args: [payments, 2n ** 96n] });
    }

    config = {
      port: 0,
      dataDir: "",
      rpcUrl: rpc,
      explorerUrl: "https://explorer.test",
      checkoutUrl: "http://checkout.test",
      chainId: CHAIN_ID,
      paymentsAddress: payments,
      usdtAddress: usdt,
      subscriptionsAddress: subscriptions,
      permitName: "Tether USD",
      permitVersion: "1",
      signerKey: DEPLOYER_KEY,
      operatorKey: DEPLOYER_KEY,
      startBlock: 0n,
    };

    db = await createTestDb();
    const client = createPublicClient({ chain, transport: httpTransport(rpc) }) as any;
    writer = createChainWriter(client, config);
    app = buildApp({ db, config, client, writer });
    key = (
      await createMerchant(db, {
        name: "PixelForge Studio",
        merchantAddress: merchantAccount.address,
        payoutWallet: merchantAccount.address,
        refundWallet: merchantAccount.address,
      })
    ).secretKey;
    indexer = createIndexer(db, client, config);

    await new Promise<void>((resolve) => receiver.server.listen(0, "127.0.0.1", resolve));
    const { port: hookPort } = receiver.server.address() as AddressInfo;
    webhookSecret = (await api("POST", "/v1/webhook_endpoints", { url: `http://127.0.0.1:${hookPort}/hook` })).json().secret;
  });

  afterAll(async () => {
    receiver.server.close();
    await db?.close();
    anvil?.kill();
  });

  return {
    api,
    receiver,
    db: () => db,
    app: () => app,
    config: () => config,
    indexer: () => indexer,
    writer: () => writer,
    key: () => key,
    webhookSecret: () => webhookSecret,
    mine: () => testClient.mine({ blocks: 2 }),
    gasBalance: (address: Address) => testClient.getBalance({ address }),
    mint: (to: Address, amount: bigint) =>
      send(deployer, { address: usdt, abi: usdtAbi, functionName: "mint", args: [to, amount] }),
    approveRefunds: (amount: bigint) =>
      send(merchantAccount, { address: usdt, abi: usdtAbi, functionName: "approve", args: [payments, amount] }),
    approveSubscriptions: (amount: bigint) =>
      send(customer, { address: usdt, abi: usdtAbi, functionName: "approve", args: [subscriptions, amount] }),
    transferToMerchant: (amount: bigint) =>
      send(customer, { address: usdt, abi: usdtAbi, functionName: "transfer", args: [merchantAccount.address, amount] }),
    subscribe: (params: any) =>
      send(customer, {
        address: params.contract,
        abi: subscriptionsAbi,
        functionName: "subscribe",
        args: [params.merchant, BigInt(params.amount), params.interval_seconds, params.max_periods],
      }),
    cancelSubscription: (subId: bigint) =>
      send(customer, { address: subscriptions, abi: subscriptionsAbi, functionName: "cancel", args: [subId] }),
    advanceTime: async (seconds: number) => {
      await testClient.increaseTime({ seconds });
      await testClient.mine({ blocks: 1 });
    },
    /** Does what a real checkout page does: fetch the signed params, then call pay. */
    async pay(clientSecret: string) {
      const { pay } = (await app.inject({ url: `/public/payment_intents/${clientSecret}` })).json();
      return send(customer, {
        address: pay.contract,
        abi: paymentsAbi,
        functionName: "pay",
        args: [pay.intent_id, pay.merchant, BigInt(pay.amount), BigInt(pay.deadline), pay.signature],
      });
    },
    refund: (intentId: Hex, amount: bigint, reason: number) =>
      send(merchantAccount, {
        address: payments,
        abi: paymentsAbi,
        functionName: "refund",
        args: [intentId, amount, reason],
      }),
  };
}
