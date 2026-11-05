import type { Queryable } from "./db.ts";
import { newId, newSecret, sha256 } from "./ids.ts";

export type Merchant = {
  id: string;
  name: string;
  merchant_address: string;
  confirmations: number;
};

export async function createMerchant(
  q: Queryable,
  input: { name: string; merchantAddress: string; payoutWallet: string; refundWallet: string; confirmations?: number },
) {
  const [merchant] = await q.query<Merchant>(
    `INSERT INTO merchants (id, name, merchant_address, payout_wallet, refund_wallet, confirmations)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      newId("acct"),
      input.name,
      input.merchantAddress,
      input.payoutWallet,
      input.refundWallet,
      input.confirmations ?? 2,
    ],
  );

  // Only the hash is stored, so this is the one time the key can be shown.
  const secretKey = newSecret("sk_test");
  await q.query("INSERT INTO api_keys (id, merchant_id, type, hash) VALUES ($1, $2, 'secret', $3)", [
    newId("key"),
    merchant!.id,
    sha256(secretKey),
  ]);
  return { merchant: merchant!, secretKey };
}

export async function merchantForSecretKey(q: Queryable, secretKey: string) {
  const [merchant] = await q.query<Merchant>(
    `UPDATE api_keys k SET last_used_at = now()
     FROM merchants m
     WHERE k.hash = $1 AND k.type = 'secret' AND m.id = k.merchant_id
     RETURNING m.*`,
    [sha256(secretKey)],
  );
  return merchant;
}
