import { type Address, type Hex, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "./config.ts";
import type { Queryable } from "./db.ts";
import { newId, newSecret } from "./ids.ts";

/** The contract keeps accepting a signed intent this long after it expires. See late_settlement. */
const GRACE_SECONDS = 15 * 60;
const DEFAULT_EXPIRY_SECONDS = 30 * 60;

/** API amounts are integer cents. USDT has 6 decimals, so 1 cent is 10,000 units. */
export const centsToUnits = (cents: number | bigint) => BigInt(cents) * 10_000n;
export const unitsToCents = (units: bigint) => Number(units / 10_000n);

export type IntentRow = {
  id: string;
  merchant_id: string;
  onchain_id: Hex;
  client_secret: string;
  amount: string | number;
  currency: string;
  status: string;
  metadata: Record<string, string>;
  description: string | null;
  source: string;
  invoice_id: string | null;
  expires_at: Date;
  deadline: string | number;
  signature: Hex;
  late_settlement: boolean;
  created_at: Date;
  tx_hash?: string | null;
  payer?: string | null;
};

export function signIntent(
  config: Pick<Config, "chainId" | "paymentsAddress" | "signerKey">,
  intent: { intentId: Hex; merchant: Address; amount: bigint; deadline: bigint },
) {
  return privateKeyToAccount(config.signerKey).signTypedData({
    domain: { name: "SettleKitPayments", version: "1", chainId: config.chainId, verifyingContract: config.paymentsAddress },
    types: {
      Intent: [
        { name: "intentId", type: "bytes32" },
        { name: "merchant", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Intent",
    message: intent,
  });
}

export async function createIntent(
  q: Queryable,
  config: Config,
  merchant: { id: string; merchant_address: string },
  input: {
    amount: number;
    currency: string;
    metadata: Record<string, string>;
    description?: string;
    source?: string;
    expiresInSeconds?: number;
  },
) {
  const id = newId("pi");
  const onchainId = keccak256(toBytes(id));
  const expiresAt = new Date(Date.now() + (input.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS) * 1000);
  const deadline = BigInt(Math.floor(expiresAt.getTime() / 1000) + GRACE_SECONDS);
  const signature = await signIntent(config, {
    intentId: onchainId,
    merchant: merchant.merchant_address as Address,
    amount: centsToUnits(input.amount),
    deadline,
  });

  const [row] = await q.query<IntentRow>(
    `INSERT INTO payment_intents
       (id, merchant_id, onchain_id, client_secret, amount, currency, status, metadata, description, source,
        expires_at, deadline, signature)
     VALUES ($1, $2, $3, $4, $5, $6, 'requires_payment_method', $7::jsonb, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      id,
      merchant.id,
      onchainId,
      `${id}_secret_${newSecret("cs").slice(3)}`,
      input.amount,
      input.currency,
      JSON.stringify(input.metadata),
      input.description ?? null,
      input.source ?? "api",
      expiresAt,
      deadline.toString(),
      signature,
    ],
  );
  return row!;
}

export async function getIntent(q: Queryable, merchantId: string, id: string) {
  const [row] = await q.query<IntentRow>(
    `SELECT i.*, p.tx_hash, p.payer
     FROM payment_intents i LEFT JOIN payments p ON p.intent_id = i.id
     WHERE i.id = $1 AND i.merchant_id = $2`,
    [id, merchantId],
  );
  return row;
}

export function serializeIntent(row: IntentRow, config: Pick<Config, "chainId" | "usdtAddress" | "explorerUrl">) {
  const txHash = row.tx_hash ?? null;
  return {
    id: row.id,
    object: "payment_intent",
    amount: Number(row.amount),
    currency: row.currency,
    status: row.status,
    client_secret: row.client_secret,
    description: row.description,
    metadata: row.metadata,
    created: Math.floor(row.created_at.getTime() / 1000),
    livemode: false,
    settlekit: {
      chain_id: config.chainId,
      token: config.usdtAddress,
      tx_hash: txHash,
      payer: row.payer ?? null,
      explorer_url: txHash ? `${config.explorerUrl}/tx/${txHash}` : null,
      late_settlement: row.late_settlement,
    },
  };
}
