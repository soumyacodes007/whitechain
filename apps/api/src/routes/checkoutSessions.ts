import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type Deps, send } from "../app.ts";
import { invalidRequest, notFound } from "../errors.ts";
import { idempotent } from "../idempotency.ts";
import { newId } from "../ids.ts";
import type { IntentRow } from "../intents.ts";
import { createSession, serializeSession, serializeSubscriptionSession, type SessionRow } from "../sessions.ts";
import { INTERVALS } from "../subscriptions.ts";

const lineItem = z.object({
  quantity: z.coerce.number().int().positive().default(1),
  price: z.string().optional(),
  price_data: z
    .object({
      currency: z.enum(["usd", "usdt"]),
      unit_amount: z.coerce.number().int().positive(),
      product_data: z.object({ name: z.string().min(1) }),
      recurring: z.object({ interval: z.enum(["week", "month"]) }).optional(),
    })
    .optional(),
});

const createBody = z.object({
  mode: z.string().default("payment"),
  line_items: z.array(lineItem).min(1),
  success_url: z.url().optional(),
  cancel_url: z.url().optional(),
  metadata: z.record(z.string(), z.string()).default({}),
  client_reference_id: z.string().optional(),
  settlekit_interval_seconds: z.coerce.number().int().min(60).optional(),
  settlekit_max_periods: z.coerce.number().int().min(0).default(0),
});

type Priced = { name: string; quantity: number; unit_amount: number; currency: string; interval?: string };

/** Accepts both inline price_data and a saved price id, which is what Stripe's own samples send. */
async function resolveItems(db: Deps["db"], merchantId: string, items: z.infer<typeof lineItem>[]): Promise<Priced[]> {
  return Promise.all(
    items.map(async (item) => {
      if (item.price_data) {
        return {
          name: item.price_data.product_data.name,
          quantity: item.quantity,
          unit_amount: item.price_data.unit_amount,
          currency: item.price_data.currency,
          interval: item.price_data.recurring?.interval,
        };
      }
      const [price] = await db.query(
        `SELECT pr.unit_amount, pr.interval, p.name FROM prices pr JOIN products p ON p.id = pr.product_id
         WHERE pr.id = $1 AND pr.merchant_id = $2`,
        [item.price ?? "", merchantId],
      );
      if (!price) throw invalidRequest("resource_missing", `No such price: '${item.price}'`, "line_items");
      return {
        name: price.name,
        quantity: item.quantity,
        unit_amount: Number(price.unit_amount),
        currency: "usd",
        interval: price.interval ?? undefined,
      };
    }),
  );
}

export async function checkoutSessionRoutes(app: FastifyInstance, { db, config }: Deps) {
  app.post("/checkout/sessions", async (request, reply) => {
    const input = createBody.parse(request.body ?? {});
    if (input.mode !== "payment" && input.mode !== "subscription") {
      throw invalidRequest("unsupported_on_settlekit", `mode: ${input.mode} is not supported`, "mode");
    }
    const items = await resolveItems(db, request.merchant.id, input.line_items);
    if (new Set(items.map((item) => item.currency)).size > 1) {
      throw invalidRequest("parameter_invalid", "Line items must share a currency", "line_items");
    }

    if (input.mode === "subscription") {
      const item = items[0]!;
      if (items.length > 1 || !item.interval) {
        throw invalidRequest("parameter_invalid", "A subscription needs exactly one recurring price", "line_items");
      }
      const result = await idempotent(db, request, request.merchant.id, async () => {
        const [session] = await db.query<SessionRow>(
          `INSERT INTO checkout_sessions
             (id, merchant_id, mode, line_items, success_url, cancel_url, client_reference_id, amount, currency,
              metadata, interval_seconds, max_periods, expires_at)
           VALUES ($1, $2, 'subscription', $3::jsonb, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, now() + interval '30 minutes')
           RETURNING *`,
          [
            newId("cs"),
            request.merchant.id,
            JSON.stringify(items),
            input.success_url ?? null,
            input.cancel_url ?? null,
            input.client_reference_id ?? null,
            item.unit_amount * item.quantity,
            item.currency,
            JSON.stringify(input.metadata),
            input.settlekit_interval_seconds ?? INTERVALS[item.interval!],
            input.settlekit_max_periods,
          ],
        );
        return { status: 200, body: serializeSubscriptionSession(session!, config) };
      });
      return send(reply, result);
    }

    const result = await idempotent(db, request, request.merchant.id, async () => {
      const { session, intent } = await db.tx((q) =>
        createSession(q, config, request.merchant, {
          lineItems: items.map(({ name, quantity, unit_amount }) => ({ name, quantity, unit_amount })),
          currency: items[0]!.currency,
          metadata: input.metadata,
          successUrl: input.success_url,
          cancelUrl: input.cancel_url,
          clientReferenceId: input.client_reference_id,
        }),
      );
      return { status: 200, body: serializeSession(session, intent, config) };
    });
    return send(reply, result);
  });

  app.get<{ Params: { id: string } }>("/checkout/sessions/:id", async (request) => {
    const [row] = await db.query<SessionRow & IntentRow & { intent_status: string; session_status: string }>(
      `SELECT s.*, s.status AS session_status, i.id AS intent_id, i.amount, i.currency, i.metadata, i.expires_at,
              i.status AS intent_status, p.tx_hash, p.payer
       FROM checkout_sessions s
       LEFT JOIN payment_intents i ON i.id = s.intent_id
       LEFT JOIN payments p ON p.intent_id = i.id
       WHERE s.id = $1 AND s.merchant_id = $2`,
      [request.params.id, request.merchant.id],
    );
    if (!row) throw notFound("checkout.session", request.params.id);
    if (row.mode === "subscription") {
      const [session] = await db.query<SessionRow>("SELECT * FROM checkout_sessions WHERE id = $1", [row.id]);
      return serializeSubscriptionSession(session!, config);
    }
    return serializeSession(
      { ...row, status: row.session_status },
      { ...row, id: row.intent_id, status: row.intent_status },
      config,
    );
  });
}
