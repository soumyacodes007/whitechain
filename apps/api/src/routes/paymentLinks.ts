import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.ts";
import { notFound } from "../errors.ts";
import { newId } from "../ids.ts";

const createBody = z.object({
  name: z.string().min(1),
  unit_amount: z.coerce.number().int().positive(),
  description: z.string().optional(),
  image: z.url().optional(),
  adjustable_quantity: z.coerce.boolean().default(false),
  expires_at: z.coerce.number().int().positive().optional(),
  success_url: z.url().optional(),
});

const SELECT_LINK = `
  SELECT l.*, pr.unit_amount, p.name
  FROM payment_links l
  JOIN prices pr ON pr.id = l.price_id
  JOIN products p ON p.id = pr.product_id`;

export function serializeLink(row: any, config: Deps["config"]) {
  return {
    id: row.id,
    object: "payment_link",
    code: row.code,
    url: `${config.checkoutUrl}/l/${row.code}`,
    active: row.active,
    name: row.name,
    description: row.description,
    image: row.image,
    unit_amount: Number(row.unit_amount),
    currency: "usd",
    adjustable_quantity: row.adjustable_quantity,
    times_paid: row.times_paid,
    expires_at: row.expires_at ? Math.floor(row.expires_at.getTime() / 1000) : null,
    success_url: row.success_url,
    created: Math.floor(row.created_at.getTime() / 1000),
  };
}

export const linkByCode = async (db: Deps["db"], code: string) =>
  (await db.query(`${SELECT_LINK} WHERE l.code = $1`, [code]))[0];

export async function paymentLinkRoutes(app: FastifyInstance, { db, config }: Deps) {
  app.post("/payment_links", async (request) => {
    const input = createBody.parse(request.body ?? {});
    const merchantId = request.merchant.id;
    const id = newId("plink");

    await db.tx(async (q) => {
      const productId = newId("prod");
      const priceId = newId("price");
      await q.query("INSERT INTO products (id, merchant_id, name) VALUES ($1, $2, $3)", [
        productId,
        merchantId,
        input.name,
      ]);
      await q.query("INSERT INTO prices (id, merchant_id, product_id, unit_amount) VALUES ($1, $2, $3, $4)", [
        priceId,
        merchantId,
        productId,
        input.unit_amount,
      ]);
      await q.query(
        `INSERT INTO payment_links
           (id, merchant_id, code, price_id, description, image, adjustable_quantity, expires_at, success_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          merchantId,
          id,
          priceId,
          input.description ?? null,
          input.image ?? null,
          input.adjustable_quantity,
          input.expires_at ? new Date(input.expires_at * 1000) : null,
          input.success_url ?? null,
        ],
      );
    });
    return serializeLink(await linkByCode(db, id), config);
  });

  app.get("/payment_links", async (request) => {
    const rows = await db.query(`${SELECT_LINK} WHERE l.merchant_id = $1 ORDER BY l.created_at DESC`, [
      request.merchant.id,
    ]);
    return { object: "list", data: rows.map((row) => serializeLink(row, config)) };
  });

  app.post<{ Params: { id: string } }>("/payment_links/:id/deactivate", async (request) => {
    const moved = await db.query(
      "UPDATE payment_links SET active = false WHERE id = $1 AND merchant_id = $2 RETURNING code",
      [request.params.id, request.merchant.id],
    );
    if (moved.length === 0) throw notFound("payment_link", request.params.id);
    return serializeLink(await linkByCode(db, moved[0].code), config);
  });
}
