import type { FastifyInstance } from "fastify";
import type { Deps } from "../app.ts";
import { notFound } from "../errors.ts";
import { centsToUnits } from "../intents.ts";

/** Unauthenticated routes for the hosted checkout. The client secret is the only credential. */
export async function publicRoutes(app: FastifyInstance, { db, config }: Deps) {
  app.get<{ Params: { clientSecret: string } }>("/payment_intents/:clientSecret", async (request) => {
    const [row] = await db.query(
      `SELECT i.*, m.name AS merchant_name, m.merchant_address, m.logo, m.brand_color, p.tx_hash
       FROM payment_intents i
       JOIN merchants m ON m.id = i.merchant_id
       LEFT JOIN payments p ON p.intent_id = i.id
       WHERE i.client_secret = $1`,
      [request.params.clientSecret],
    );
    if (!row) throw notFound("payment_intent", "client_secret");

    return {
      id: row.id,
      status: row.status,
      amount: Number(row.amount),
      currency: row.currency,
      description: row.description,
      expires_at: Math.floor(row.expires_at.getTime() / 1000),
      expired: row.expires_at < new Date(),
      merchant: { name: row.merchant_name, logo: row.logo, brand_color: row.brand_color },
      tx_hash: row.tx_hash,
      pay: {
        chain_id: config.chainId,
        contract: config.paymentsAddress,
        token: config.usdtAddress,
        intent_id: row.onchain_id,
        merchant: row.merchant_address,
        amount: centsToUnits(row.amount).toString(),
        deadline: String(row.deadline),
        signature: row.signature,
      },
    };
  });
}
