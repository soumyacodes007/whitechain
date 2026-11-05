import { loadConfig } from "./config.ts";
import { createDb } from "./db.ts";
import { loadEnv } from "./env.ts";
import { createMerchant } from "./merchants.ts";

loadEnv();

const WALLET = process.env.MERCHANT_WALLET ?? "0x656Db8fb1C96129642D4E3d120F6aab1E7EAa214";

const config = loadConfig();
const db = await createDb({ databaseUrl: config.databaseUrl, dataDir: config.dataDir });
const { merchant, secretKey } = await createMerchant(db, {
  name: "PixelForge Studio",
  merchantAddress: WALLET,
  payoutWallet: WALLET,
  refundWallet: WALLET,
});
await db.close();

console.log(`Merchant ${merchant.id}`);
console.log(`Secret key (shown once): ${secretKey}`);
