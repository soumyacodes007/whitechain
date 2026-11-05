// Runs a real payment and partial refund on Whitechain Sepolia through the real API and indexer.
// Every step checks onchain state first, so a re-run after a network failure never repeats a transfer.
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  formatEther,
  type Hex,
  http,
  parseAbi,
  parseEther,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { createDb } from "../src/db.ts";
import { loadEnv } from "../src/env.ts";
import { createIndexer } from "../src/indexer.ts";
import { createMerchant } from "../src/merchants.ts";

loadEnv();

const ENV_FILE = fileURLToPath(new URL("../../../.env", import.meta.url));
const MAX_SPEND = parseEther("0.1");
const CUSTOMER_WBT = parseEther("0.05");
const CUSTOMER_USDT = 10_000000n;
const PAYMENT_CENTS = 500;
const REFUND_UNITS = 1_000000n;

const remember = (name: string, value: string) => {
  appendFileSync(ENV_FILE, `\n${name}=${value}\n`);
  process.env[name] = value;
};

if (!process.env.CUSTOMER_PRIVATE_KEY) remember("CUSTOMER_PRIVATE_KEY", generatePrivateKey());

const config = loadConfig();
const merchant = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex);
const customer = privateKeyToAccount(process.env.CUSTOMER_PRIVATE_KEY as Hex);

const chain = {
  id: config.chainId,
  name: "Whitechain Sepolia",
  nativeCurrency: { name: "WBT", symbol: "WBT", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
};
const client = createPublicClient({ chain, transport: http(config.rpcUrl, { retryCount: 5, timeout: 30_000 }) });
const merchantWallet = createWalletClient({ account: merchant, chain, transport: http(config.rpcUrl) });
const customerWallet = createWalletClient({ account: customer, chain, transport: http(config.rpcUrl) });

const usdtAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
]);
const paymentsAbi = parseAbi([
  "function merchants(address) view returns (address payout, address refundWallet, address refundOperator)",
  "function registerMerchant(address payout, address refundWallet, address refundOperator)",
  "function pay(bytes32 intentId, address merchant, uint256 amount, uint256 deadline, bytes sig)",
  "function refund(bytes32 intentId, uint256 amount, uint8 reasonCode)",
]);

const usdt = { address: config.usdtAddress, abi: usdtAbi } as const;
const payments = { address: config.paymentsAddress, abi: paymentsAbi } as const;
const explorer = (hash: string) => `${config.explorerUrl}/tx/${hash}`;

const startBalance = await client.getBalance({ address: merchant.address });

async function confirmed(label: string, hash: Hex) {
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  const spent = startBalance - (await client.getBalance({ address: merchant.address }));
  if (spent > MAX_SPEND + CUSTOMER_WBT) throw new Error(`Spent ${formatEther(spent)} WBT, stopping`);
  console.log(`${label}: ${explorer(hash)}`);
  return receipt;
}

// 1. Fund the customer.
if ((await client.getBalance({ address: customer.address })) < CUSTOMER_WBT / 2n) {
  await confirmed("fund customer WBT", await merchantWallet.sendTransaction({ to: customer.address, value: CUSTOMER_WBT }));
}
if ((await client.readContract({ ...usdt, functionName: "balanceOf", args: [customer.address] })) < 500_0000n) {
  await confirmed(
    "fund customer USDT",
    await merchantWallet.writeContract({ ...usdt, functionName: "transfer", args: [customer.address, CUSTOMER_USDT] }),
  );
}

// 2. Register the merchant and let the contract pull refunds.
const [payout] = await client.readContract({ ...payments, functionName: "merchants", args: [merchant.address] });
if (payout === "0x0000000000000000000000000000000000000000") {
  await confirmed(
    "register merchant",
    await merchantWallet.writeContract({
      ...payments,
      functionName: "registerMerchant",
      args: [merchant.address, merchant.address, merchant.address],
    }),
  );
}
const refundAllowance = await client.readContract({
  ...usdt,
  functionName: "allowance",
  args: [merchant.address, config.paymentsAddress],
});
if (refundAllowance < CUSTOMER_USDT) {
  await confirmed(
    "approve refunds",
    await merchantWallet.writeContract({
      ...usdt,
      functionName: "approve",
      args: [config.paymentsAddress, 2n ** 96n],
    }),
  );
}

// 3. Create the merchant record, or reuse it.
const db = await createDb({ databaseUrl: config.databaseUrl, dataDir: config.dataDir });
const app = buildApp({ db, config, client: client as any });
if (!process.env.SETTLEKIT_SECRET_KEY) {
  const existing = await db.query("SELECT id FROM merchants WHERE merchant_address = $1", [merchant.address]);
  if (existing.length > 0) throw new Error("Merchant exists but SETTLEKIT_SECRET_KEY is missing from .env");
  const { secretKey } = await createMerchant(db, {
    name: "PixelForge Studio",
    merchantAddress: merchant.address,
    payoutWallet: merchant.address,
    refundWallet: merchant.address,
  });
  remember("SETTLEKIT_SECRET_KEY", secretKey);
}
const auth = { authorization: `Bearer ${process.env.SETTLEKIT_SECRET_KEY}` };

// 4. Pay through a real signed intent.
const created = (
  await app.inject({
    method: "POST",
    url: "/v1/payment_intents",
    headers: { ...auth, "idempotency-key": "live-payment-1" },
    payload: { amount: PAYMENT_CENTS, currency: "usd", metadata: { orderId: "PF-LIVE-1" } },
  })
).json();
const { pay } = (await app.inject({ url: `/public/payment_intents/${created.client_secret}` })).json();

const indexer = createIndexer(db, client as any, {
  ...config,
  startBlock: (await client.getBlockNumber({ cacheTime: 0 })) - 1_000n,
});

const status = async () =>
  (await app.inject({ url: `/v1/payment_intents/${created.id}`, headers: auth })).json();

async function waitForIndexer(done: () => Promise<boolean>) {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    await indexer.tick().catch((error) => console.log(`indexer retry: ${error.message}`));
    if (await done()) return (Date.now() - started) / 1000;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Indexer timed out");
}

if ((await status()).status === "requires_payment_method") {
  const amount = BigInt(pay.amount);
  const allowance = await client.readContract({
    ...usdt,
    functionName: "allowance",
    args: [customer.address, config.paymentsAddress],
  });
  if (allowance < amount) {
    await confirmed(
      "customer approves",
      await customerWallet.writeContract({ ...usdt, functionName: "approve", args: [config.paymentsAddress, amount] }),
    );
  }
  const args = [pay.intent_id, pay.merchant as Address, amount, BigInt(pay.deadline), pay.signature] as const;
  await client.simulateContract({ ...payments, functionName: "pay", args, account: customer });
  await confirmed("PAYMENT", await customerWallet.writeContract({ ...payments, functionName: "pay", args }));
}

const seconds = await waitForIndexer(async () => (await status()).status === "succeeded");
const paid = await status();
console.log(`indexed as succeeded in ${seconds.toFixed(1)}s after confirmation, status ${paid.status}`);

// 5. Partial refund.
const [refunds] = await db.query("SELECT count(*)::int AS n FROM refunds");
if (refunds.n === 0) {
  await confirmed(
    "REFUND",
    await merchantWallet.writeContract({
      ...payments,
      functionName: "refund",
      args: [pay.intent_id, REFUND_UNITS, 2],
    }),
  );
}
await waitForIndexer(async () => (await db.query("SELECT count(*)::int AS n FROM refunds"))[0].n > 0);

const [{ id: paymentId }] = await db.query("SELECT id FROM payments WHERE intent_id = $1", [created.id]);
const receipt = (await app.inject({ url: `/public/receipts/${paymentId}` })).json();
console.log(JSON.stringify({ status: receipt.status, net: receipt.net, paid_tx: receipt.explorer_url, refund_tx: receipt.refunds[0]?.explorer_url }, null, 1));

const spent = startBalance - (await client.getBalance({ address: merchant.address }));
console.log(`Merchant wallet WBT spent this run: ${formatEther(spent)} (includes customer funding)`);
await db.close();
