import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type Deps, send } from "../app.ts";
import { invalidRequest, notFound } from "../errors.ts";
import { idempotent } from "../idempotency.ts";
import { createIntent, getIntent, serializeIntent } from "../intents.ts";

const createBody = z.object({
  amount: z.coerce.number().int().positive().max(99_999_999),
  currency: z.enum(["usd", "usdt"]),
  metadata: z.record(z.string(), z.string()).default({}),
  description: z.string().max(500).optional(),
});

export async function paymentIntentRoutes(app: FastifyInstance, { db, config }: Deps) {
  app.post("/payment_intents", async (request, reply) => {
    const input = createBody.parse(request.body ?? {});
    const result = await idempotent(db, request, request.merchant.id, async () => ({
      status: 200,
      body: serializeIntent(await createIntent(db, config, request.merchant, input), config),
    }));
    return send(reply, result);
  });

  app.get<{ Params: { id: string } }>("/payment_intents/:id", async (request) => {
    const intent = await getIntent(db, request.merchant.id, request.params.id);
    if (!intent) throw notFound("payment_intent", request.params.id);
    return serializeIntent(intent, config);
  });

  app.post<{ Params: { id: string } }>("/payment_intents/:id/cancel", async (request, reply) => {
    const { id } = request.params;
    const result = await idempotent(db, request, request.merchant.id, async () => {
      const moved = await db.query(
        `UPDATE payment_intents SET status = 'canceled'
         WHERE id = $1 AND merchant_id = $2 AND status = 'requires_payment_method'
         RETURNING id`,
        [id, request.merchant.id],
      );
      const intent = await getIntent(db, request.merchant.id, id);
      if (!intent) throw notFound("payment_intent", id);
      if (moved.length === 0) {
        throw invalidRequest(
          "payment_intent_unexpected_state",
          `This PaymentIntent can't be canceled because its status is ${intent.status}`,
        );
      }
      return { status: 200, body: serializeIntent(intent, config) };
    });
    return send(reply, result);
  });
}
