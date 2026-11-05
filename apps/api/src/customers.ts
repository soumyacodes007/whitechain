import type { Queryable } from "./db.ts";
import { newId } from "./ids.ts";

/** Finds the merchant's customer for a wallet, or creates one, and fills in an email if we learned it. */
export async function customerForWallet(q: Queryable, merchantId: string, wallet: string, email?: string | null) {
  const [existing] = await q.query<{ id: string; email: string | null }>(
    "SELECT id, email FROM customers WHERE merchant_id = $1 AND wallets @> $2::jsonb ORDER BY created_at, id LIMIT 1",
    [merchantId, JSON.stringify([wallet])],
  );
  if (existing) {
    if (email && !existing.email) {
      await q.query("UPDATE customers SET email = $2 WHERE id = $1", [existing.id, email]);
    }
    return existing.id;
  }

  const id = newId("cus");
  await q.query("INSERT INTO customers (id, merchant_id, email, wallets) VALUES ($1, $2, $3, $4::jsonb)", [
    id,
    merchantId,
    email ?? null,
    JSON.stringify([wallet]),
  ]);
  return id;
}

/** Links a wallet to a customer we already know, such as an invoice's bill-to contact. */
export async function addWallet(q: Queryable, customerId: string, wallet: string) {
  await q.query(
    `UPDATE customers SET wallets = wallets || $2::jsonb
     WHERE id = $1 AND NOT wallets @> $2::jsonb`,
    [customerId, JSON.stringify([wallet])],
  );
}
