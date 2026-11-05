import type { FastifyInstance } from "fastify";
import type { Deps } from "../app.ts";
import { invalidRequest, notFound } from "../errors.ts";
import { cancelSubscription, serializeSubscription, type SubscriptionRow } from "../subscriptions.ts";

export async function subscriptionRoutes(app: FastifyInstance, { db, config }: Deps) {
  const find = async (id: string, merchantId: string) => {
    const [row] = await db.query<SubscriptionRow>("SELECT * FROM subscriptions WHERE id = $1 AND merchant_id = $2", [
      id,
      merchantId,
    ]);
    if (!row) throw notFound("subscription", id);
    return row;
  };

  app.get("/subscriptions", async (request) => {
    const rows = await db.query<SubscriptionRow>(
      "SELECT * FROM subscriptions WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 100",
      [request.merchant.id],
    );
    return { object: "list", data: rows.map((row) => serializeSubscription(row, config)) };
  });

  app.get<{ Params: { id: string } }>("/subscriptions/:id", async (request) => {
    const row = await find(request.params.id, request.merchant.id);
    const charges = await db.query(
      "SELECT id, period, amount, status, tx_hash, created_at FROM subscription_charges WHERE subscription_id = $1 ORDER BY block_number, log_index",
      [row.id],
    );
    return {
      ...serializeSubscription(row, config),
      charges: charges.map((charge) => ({
        id: charge.id,
        period: charge.period,
        amount: Number(charge.amount),
        status: charge.status,
        date: Math.floor(charge.created_at.getTime() / 1000),
        explorer_url: `${config.explorerUrl}/tx/${charge.tx_hash}`,
      })),
    };
  });

  // Cancelling from the merchant side stops the keeper. The onchain mandate can only be closed by a key
  // SettleKit doesn't hold, but no charge can happen without the keeper.
  const cancel = async (id: string, merchantId: string) => {
    await find(id, merchantId);
    const row = await db.tx((q) => cancelSubscription(q, config, id));
    if (!row) throw invalidRequest("subscription_already_canceled", "This subscription is already canceled");
    return serializeSubscription(row, config);
  };

  app.post<{ Params: { id: string } }>("/subscriptions/:id/cancel", (request) =>
    cancel(request.params.id, request.merchant.id),
  );
  app.delete<{ Params: { id: string } }>("/subscriptions/:id", (request) =>
    cancel(request.params.id, request.merchant.id),
  );

  app.post<{ Params: { id: string } }>("/subscriptions/:id/retry", async (request) => {
    const row = await find(request.params.id, request.merchant.id);
    if (row.status !== "past_due") throw invalidRequest("subscription_not_past_due", "Only past due renewals can be retried");
    await db.query("UPDATE subscriptions SET next_charge_at = now() WHERE id = $1", [row.id]);
    return serializeSubscription({ ...row, next_charge_at: new Date() }, config);
  });
}
