import type { FastifyInstance } from "fastify";
import type { Address, Hex } from "viem";
import { z } from "zod";
import { type Deps, send } from "../app.ts";
import type { Config } from "../config.ts";
import { ApiError, invalidRequest, notFound } from "../errors.ts";
import { emitEvent } from "../events.ts";
import { idempotent } from "../idempotency.ts";
import { newId } from "../ids.ts";
import { centsToUnits } from "../intents.ts";

export const REFUND_REASONS = ["requested_by_customer", "duplicate", "cancelled_item", "other"];

const createBody = z.object({
  payment_intent: z.string().min(1),
  amount: z.coerce.number().int().positive().optional(),
  reason: z.enum(REFUND_REASONS as [string, ...string[]]).default("requested_by_customer"),
  note: z.string().max(500).optional(),
});

const SELECT_REFUND = `
  SELECT r.*, p.intent_id, i.currency
  FROM refunds r JOIN payments p ON p.id = r.payment_id JOIN payment_intents i ON i.id = p.intent_id`;

export function serializeRefund(row: any, config: Pick<Config, "chainId" | "explorerUrl">) {
  return {
    id: row.id,
    object: "refund",
    amount: Number(row.amount),
    currency: row.currency,
    payment_intent: row.intent_id,
    reason: row.reason,
    note: row.note,
    status: row.status,
    created: Math.floor(row.created_at.getTime() / 1000),
    settlekit: {
      chain_id: config.chainId,
      tx_hash: row.tx_hash,
      explorer_url: row.tx_hash ? `${config.explorerUrl}/tx/${row.tx_hash}` : null,
    },
  };
}

export async function refundRoutes(app: FastifyInstance, { db, config, writer }: Deps) {
  app.post("/refunds", async (request, reply) => {
    const input = createBody.parse(request.body ?? {});
    const merchant = request.merchant;

    const result = await idempotent(db, request, merchant.id, async () => {
      if (!writer) throw new ApiError(503, "api_error", "refunds_unavailable", "Refunds are not configured");

      const prepared = await db.tx(async (q) => {
        // Locking the payment stops two refunds from both passing the remaining-amount check.
        const [payment] = await q.query(
          `SELECT p.id, p.amount, i.onchain_id, i.currency, i.id AS intent_id
           FROM payments p JOIN payment_intents i ON i.id = p.intent_id
           WHERE i.id = $1 AND i.merchant_id = $2
           FOR UPDATE OF p`,
          [input.payment_intent, merchant.id],
        );
        if (!payment) throw notFound("payment_intent", input.payment_intent);

        const [{ refunded }] = await q.query(
          "SELECT coalesce(sum(amount), 0)::bigint AS refunded FROM refunds WHERE payment_id = $1 AND status <> 'failed'",
          [payment.id],
        );
        const remaining = Number(payment.amount) - Number(refunded);
        const amount = input.amount ?? remaining;
        if (remaining <= 0) throw invalidRequest("charge_already_refunded", "This payment is fully refunded");
        if (amount > remaining) {
          throw invalidRequest("refund_exceeds_paid", `Only ${remaining} can still be refunded`, "amount");
        }

        const [row] = await q.query(
          `INSERT INTO refunds (id, payment_id, merchant_id, amount, reason, note, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending')
           RETURNING *`,
          [newId("re"), payment.id, merchant.id, amount, input.reason, input.note ?? null],
        );
        return { row, payment, amount };
      });

      const units = centsToUnits(prepared.amount);
      const fail = async (error: ApiError) => {
        await db.query("UPDATE refunds SET status = 'failed' WHERE id = $1", [prepared.row.id]);
        return error;
      };

      const [{ refund_wallet: refundWallet }] = await db.query("SELECT refund_wallet FROM merchants WHERE id = $1", [
        merchant.id,
      ]);
      const funding = await writer.refundFunding(refundWallet as Address);
      if (funding.balance < units || funding.allowance < units) {
        throw await fail(
          invalidRequest("insufficient_refund_balance", "The refund wallet needs more USDT, or a higher allowance"),
        );
      }
      if (funding.gas === 0n) {
        throw await fail(new ApiError(503, "api_error", "operator_out_of_gas", "The refund operator has no WBT"));
      }

      let hash: Hex;
      try {
        hash = await writer.refund(prepared.payment.onchain_id, units, REFUND_REASONS.indexOf(input.reason));
      } catch (cause) {
        console.error("refund failed:", cause instanceof Error ? cause.message : cause);
        throw await fail(new ApiError(402, "api_error", "refund_failed", "The refund transaction was rejected"));
      }

      const object = await db.tx(async (q) => {
        const [row] = await q.query("UPDATE refunds SET tx_hash = $2 WHERE id = $1 RETURNING *", [
          prepared.row.id,
          hash,
        ]);
        const refund = serializeRefund(
          { ...row, intent_id: prepared.payment.intent_id, currency: prepared.payment.currency },
          config,
        );
        await emitEvent(q, merchant.id, "refund.created", refund);
        return refund;
      });
      return { status: 200, body: object };
    });
    return send(reply, result);
  });

  app.get<{ Params: { id: string } }>("/refunds/:id", async (request) => {
    const [row] = await db.query(`${SELECT_REFUND} WHERE r.id = $1 AND i.merchant_id = $2`, [
      request.params.id,
      request.merchant.id,
    ]);
    if (!row) throw notFound("refund", request.params.id);
    return serializeRefund(row, config);
  });

  app.get("/refunds", async (request) => {
    const rows = await db.query(`${SELECT_REFUND} WHERE i.merchant_id = $1 ORDER BY r.created_at DESC, r.id LIMIT 100`, [
      request.merchant.id,
    ]);
    return { object: "list", data: rows.map((row) => serializeRefund(row, config)) };
  });
}
