import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "viem";
import { z } from "zod";

const deployment = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../contracts/deployments/1874.json", import.meta.url)), "utf8"),
);

const blankToUndefined = (value: unknown) => (value === "" ? undefined : value);

const schema = z.object({
  PORT: z.preprocess(blankToUndefined, z.coerce.number().default(4000)),
  DATABASE_URL: z.preprocess(blankToUndefined, z.string().optional()),
  DATA_DIR: z.preprocess(blankToUndefined, z.string().default("./data")),
  WHITECHAIN_RPC_URL: z.preprocess(blankToUndefined, z.url().default(deployment.rpc)),
  EXPLORER_URL: z.preprocess(blankToUndefined, z.url().default(deployment.explorer)),
  CHECKOUT_URL: z.preprocess(blankToUndefined, z.url().default("http://localhost:3000")),
  DEPLOYER_PRIVATE_KEY: z.string().optional(),
  INTENT_SIGNER_PRIVATE_KEY: z.preprocess(blankToUndefined, z.string().optional()),
  OPERATOR_PRIVATE_KEY: z.preprocess(blankToUndefined, z.string().optional()),
  RESEND_API_KEY: z.preprocess(blankToUndefined, z.string().optional()),
  EMAIL_FROM: z.preprocess(blankToUndefined, z.string().default("SettleKit <receipts@settlekit.dev>")),
  CHAIN_ID: z.preprocess(blankToUndefined, z.coerce.number().default(deployment.chainId)),
  PAYMENTS_ADDRESS: z.preprocess(blankToUndefined, z.string().default(deployment.SettleKitPayments.address)),
  USDT_ADDRESS: z.preprocess(blankToUndefined, z.string().default(deployment.usdt)),
  SUBSCRIPTIONS_ADDRESS: z.preprocess(blankToUndefined, z.string().default(deployment.SettleKitSubscriptions.address)),
  INDEXER_START_BLOCK: z.preprocess(
    blankToUndefined,
    z.coerce.bigint().default(BigInt(deployment.SettleKitPayments.block)),
  ),
});

export type Config = {
  port: number;
  databaseUrl?: string;
  dataDir: string;
  rpcUrl: string;
  explorerUrl: string;
  checkoutUrl: string;
  chainId: number;
  paymentsAddress: Address;
  usdtAddress: Address;
  subscriptionsAddress: Address;
  permitName: string;
  permitVersion: string;
  signerKey: Hex;
  /** Sends refunds, gasless payments and renewals. Holds gas only, never customer funds. */
  operatorKey: Hex;
  resendApiKey?: string;
  emailFrom?: string;
  startBlock: bigint;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);
  const signerKey = parsed.INTENT_SIGNER_PRIVATE_KEY ?? parsed.DEPLOYER_PRIVATE_KEY;
  if (!signerKey) throw new Error("Set INTENT_SIGNER_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY");

  return {
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    dataDir: parsed.DATA_DIR,
    rpcUrl: parsed.WHITECHAIN_RPC_URL,
    explorerUrl: parsed.EXPLORER_URL,
    checkoutUrl: parsed.CHECKOUT_URL,
    chainId: parsed.CHAIN_ID,
    paymentsAddress: parsed.PAYMENTS_ADDRESS as Address,
    usdtAddress: parsed.USDT_ADDRESS as Address,
    subscriptionsAddress: parsed.SUBSCRIPTIONS_ADDRESS as Address,
    permitName: "Tether USD",
    permitVersion: "1",
    signerKey: signerKey as Hex,
    operatorKey: (parsed.OPERATOR_PRIVATE_KEY ?? signerKey) as Hex,
    startBlock: parsed.INDEXER_START_BLOCK,
    resendApiKey: parsed.RESEND_API_KEY,
    emailFrom: parsed.EMAIL_FROM,
  };
}
