// Proves the remaining flows on Whitechain Sepolia: gasless payment, API refund, and a keeper renewal.
// Each step checks the database or chain first, so a re-run after a network failure repeats nothing.
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  type Hex,
  http,
  parseAbi,
  parseEther,
  parseSignature,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildApp } from "../src/app.ts";
import { createChainWriter } from "../src/chain.ts";
import { loadConfig } from "../src/config.ts";
import { createDb } from "../src/db.ts";
import { loadEnv } from "../src/env.ts";
import { createIndexer } from "../src/indexer.ts";
import { chargeDue } from "../src/subscriptions.ts";

loadEnv();

const ENV_FILE = fileURLToPath(new URL("../../../.env", import.meta.url));
const MAX_SPEND = parseEther("0.05");
const INTERVAL = 60;

if (!process.env.GASLESS_PRIVATE_KEY) {
  const key = generatePrivateKey();
  appendFileSync(ENV_FILE, `\nGASLESS_PRIVATE_KEY=${key}\n`);
  process.env.GASLESS_PRIVATE_KEY = key;
}

const config = loadConfig();
const merchant = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex);
const customer = privateKeyToAccount(process.env.CUSTOMER_PRIVATE_KEY as Hex);
const gasless = privateKeyToAccount(process.env.GASLESS_PRIVATE_KEY as Hex);

const chain = {
  id: config.chainId,
  name: "Whitechain Sepolia",
  nativeCurrency: { name: "WBT", symbol: "WBT", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
};
const client = createPublicClient({ chain, transport: http(config.rpcUrl, { retryCount: 5, timeout: 30_000 }) });
const walletOf = (account: typeof merchant) => createWalletClient({ account, chain, transport: http(config.rpcUrl) });

const usdtAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
  "function nonces(address) view returns (uint256)",
]);
const subscriptionsAbi = parseAbi([
  "function subscribe(address merchant, uint256 amount, uint32 interval, uint32 maxPeriods) returns (uint256)",
  "function cancel(uint256 subId)",
]);
const usdt = { address: config.usdtAddress, abi: usdtAbi } as const;
const explorer = (hash: string) => `${config.explorerUrl}/tx/${hash}`;

const startBalance = await client.getBalance({ address: merchant.address });

async function confirmed(label: string, hash: Hex) {
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  const spent = startBalance - (await client.getBalance({ address: merchant.address }));
  if (spent > MAX_SPEND) throw new Error(`Spent ${formatEther(spent)} WBT, stopping`);
  console.log(`${label}: ${explorer(hash)}`);
}

const db = await createDb({ databaseUrl: config.databaseUrl, dataDir: config.dataDir });
const writer = createChainWriter(client as any, config);
const app = buildApp({ db, config, client: client as any, writer });
const indexer = createIndexer(db, client as any, config);
const auth = { authorization: `Bearer ${process.env.SETTLEKIT_SECRET_KEY}` };

const api = async (method: "GET" | "POST", url: string, payload?: object, key?: string) => {
  const response = await app.inject({
    method,
    url,
    payload,
    headers: { ...auth, ...(key ? { "idempotency-key": key } : {}) },
  });
  const json = response.json();
  if (response.statusCode >= 400) throw new Error(`${url}: ${JSON.stringify(json.error)}`);
  return json;
};

async function until(done: () => Promise<boolean>, label: string, seconds = 90) {
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    await indexer.tick().catch((error) => console.log(`indexer retry: ${error.message.split("\n")[0]}`));
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// 1. Gasless payment from a wallet that has never held WBT.
const held = await client.readContract({ ...usdt, functionName: "balanceOf", args: [gasless.address] });
if (held < 1_000000n) {
  await confirmed(
    "fund gasless wallet with USDT only",
    await walletOf(merchant).writeContract({ ...usdt, functionName: "transfer", args: [gasless.address, 2_000000n] }),
  );
}

const intent = await api(
  "POST",
  "/v1/payment_intents",
  { amount: 100, currency: "usd", metadata: { orderId: "PF-LIVE-GASLESS" } },
  "live-gasless-1",
);
const { pay } = (await app.inject({ url: `/public/payment_intents/${intent.client_secret}` })).json();

const status = async () => (await api("GET", `/v1/payment_intents/${intent.id}`)).status;

if ((await status()) === "requires_payment_method") {
  const amount = BigInt(pay.amount);
  const deadline = BigInt(pay.deadline);
  const nonce = await client.readContract({ ...usdt, functionName: "nonces", args: [gasless.address] });

  const permit = parseSignature(
    await gasless.signTypedData({
      domain: { ...pay.permit_domain, chainId: pay.chain_id, verifyingContract: pay.token },
      types: {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Permit",
      message: { owner: gasless.address, spender: pay.contract, value: amount, nonce, deadline },
    }),
  );
  const payerSignature = await gasless.signTypedData({
    domain: { name: "SettleKitPayments", version: "1", chainId: pay.chain_id, verifyingContract: pay.contract },
    types: {
      PaymentAuthorization: [
        { name: "intentId", type: "bytes32" },
        { name: "merchant", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "payer", type: "address" },
      ],
    },
    primaryType: "PaymentAuthorization",
    message: { intentId: pay.intent_id, merchant: pay.merchant, amount, deadline, payer: gasless.address },
  });

  const relayed = await app.inject({
    method: "POST",
    url: `/public/payment_intents/${intent.client_secret}/relay`,
    payload: {
      payer: gasless.address,
      payer_signature: payerSignature,
      permit: {
        deadline: deadline.toString(),
        v: Number(permit.v ?? BigInt(permit.yParity + 27)),
        r: permit.r,
        s: permit.s,
      },
    },
  });
  if (relayed.statusCode !== 200) throw new Error(`Relay refused: ${relayed.payload}`);
  await confirmed("GASLESS PAYMENT", relayed.json().tx_hash);
}
await until(async () => (await status()) === "succeeded", "gasless payment");
console.log(`gasless payer WBT balance: ${await client.getBalance({ address: gasless.address })}`);

// 2. Partial refund through the API, sent by the operator.
const [existingRefund] = await db.query(
  `SELECT r.id FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE p.intent_id = $1`,
  [intent.id],
);
const refundId =
  existingRefund?.id ??
  (await api("POST", "/v1/refunds", { payment_intent: intent.id, amount: 25, reason: "requested_by_customer" }, "live-refund-1")).id;
await until(async () => (await api("GET", `/v1/refunds/${refundId}`)).status === "succeeded", "API refund");
console.log(`API REFUND: ${(await api("GET", `/v1/refunds/${refundId}`)).settlekit.explorer_url}`);

// 3. Subscribe, then let the keeper charge a real renewal.
let [subscription] = await db.query("SELECT * FROM subscriptions WHERE lower(wallet) = lower($1) ORDER BY created_at LIMIT 1", [
  customer.address,
]);

if (!subscription) {
  const session = await api(
    "POST",
    "/v1/checkout/sessions",
    {
      mode: "subscription",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: 100,
            product_data: { name: "Maintenance retainer" },
            recurring: { interval: "month" },
          },
        },
      ],
      settlekit_interval_seconds: INTERVAL,
    },
    "live-subscription-1",
  );
  const { subscribe } = (await app.inject({ url: `/public/checkout/${session.id}` })).json();
  const customerWallet = walletOf(customer);

  const allowance = await client.readContract({
    ...usdt,
    functionName: "allowance",
    args: [customer.address, config.subscriptionsAddress],
  });
  if (allowance < 3_000000n) {
    await confirmed(
      "customer approves renewals",
      await customerWallet.writeContract({
        ...usdt,
        functionName: "approve",
        args: [config.subscriptionsAddress, 3_000000n],
      }),
    );
  }
  const hash = await customerWallet.writeContract({
    address: config.subscriptionsAddress,
    abi: subscriptionsAbi,
    functionName: "subscribe",
    args: [subscribe.merchant, BigInt(subscribe.amount), subscribe.interval_seconds, 0],
  });
  await confirmed("SUBSCRIBE, FIRST CHARGE", hash);
  await app.inject({ method: "POST", url: `/public/checkout/${session.id}/subscribed`, payload: { tx_hash: hash } });

  await until(
    async () => (await db.query("SELECT 1 FROM subscriptions WHERE lower(wallet) = lower($1)", [customer.address])).length > 0,
    "subscription",
  );
  [subscription] = await db.query("SELECT * FROM subscriptions WHERE lower(wallet) = lower($1) ORDER BY created_at LIMIT 1", [
    customer.address,
  ]);
}

const periods = async () => (await api("GET", `/v1/subscriptions/${subscription.id}`)).periods_charged;

if ((await periods()) < 2) {
  console.log("waiting for the renewal to come due");
  await until(
    async () => {
      await chargeDue(db, writer);
      return (await periods()) >= 2;
    },
    "keeper renewal",
    180,
  );
}
const details = await api("GET", `/v1/subscriptions/${subscription.id}`);
console.log(`RENEWAL: ${details.charges.find((charge: any) => charge.period === 2).explorer_url}`);

// 4. Cancel from the customer's wallet, so no further charges run.
if (details.status !== "canceled") {
  await confirmed(
    "CUSTOMER CANCELS ONCHAIN",
    await walletOf(customer).writeContract({
      address: config.subscriptionsAddress,
      abi: subscriptionsAbi,
      functionName: "cancel",
      args: [BigInt(subscription.onchain_sub_id)],
    }),
  );
  await until(async () => (await api("GET", `/v1/subscriptions/${subscription.id}`)).status === "canceled", "cancel");
}

const now = Math.floor(Date.now() / 1000);
const report = await api("GET", `/v1/reports?from=${now - 86_400}&to=${now + 60}`);
console.log(JSON.stringify({ summary: report.summary, reconciliation: report.reconciliation.map((row: any) => [row.status, row.amount, row.reference]) }));
console.log(`Merchant wallet WBT spent this run: ${formatEther(startBalance - (await client.getBalance({ address: merchant.address })))}`);
await db.close();
