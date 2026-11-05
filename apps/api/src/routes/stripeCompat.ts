import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.ts";
import { invalidRequest, notFound } from "../errors.ts";
import { newId } from "../ids.ts";

/** Stripe features SettleKit doesn't have. They fail clearly instead of looking like a typo in the URL. */
const UNSUPPORTED = [
  "payment_methods",
  "setup_intents",
  "charges",
  "disputes",
  "coupons",
  "promotion_codes",
  "tax_rates",
  "tax",
  "accounts",
  "transfers",
  "payouts",
];

const customerBody = z.object({
  name: z.string().optional(),
  email: z.email().optional(),
  metadata: z.record(z.string(), z.string()).default({}),
});

const productBody = z.object({ name: z.string().min(1) });

const priceBody = z.object({
  unit_amount: z.coerce.number().int().positive(),
  currency: z.enum(["usd", "usdt"]),
  product: z.string().optional(),
  product_data: z.object({ name: z.string().min(1) }).optional(),
  recurring: z.object({ interval: z.enum(["week", "month"]) }).optional(),
});

const serializePrice = (id: string, product: string, unitAmount: number, currency: string, interval: string | null) => ({
  id,
  object: "price",
  active: true,
  currency,
  product,
  unit_amount: unitAmount,
  type: interval ? "recurring" : "one_time",
  recurring: interval ? { interval, interval_count: 1 } : null,
  livemode: false,
});

export async function stripeCompatRoutes(app: FastifyInstance, { db }: Deps) {
  for (const resource of UNSUPPORTED) {
    app.all(`/${resource}`, unsupported(resource));
    app.all(`/${resource}/*`, unsupported(resource));
  }

  function unsupported(resource: string) {
    return async () => {
      throw invalidRequest("unsupported_on_settlekit", `${resource} are not available on SettleKit`);
    };
  }

  const serializeCustomer = (row: any) => ({
    id: row.id,
    object: "customer",
    name: row.name,
    email: row.email,
    metadata: { wallet: row.wallets[0] ?? "" },
    created: Math.floor(row.created_at.getTime() / 1000),
    livemode: false,
  });

  app.post("/customers", async (request) => {
    const input = customerBody.parse(request.body ?? {});
    const wallet = input.metadata.wallet;
    const [row] = await db.query(
      `INSERT INTO customers (id, merchant_id, name, email, wallets) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`,
      [
        newId("cus"),
        request.merchant.id,
        input.name ?? null,
        input.email ?? null,
        JSON.stringify(wallet ? [wallet] : []),
      ],
    );
    return serializeCustomer(row);
  });

  app.get<{ Params: { id: string } }>("/customers/:id", async (request) => {
    const [row] = await db.query("SELECT * FROM customers WHERE id = $1 AND merchant_id = $2", [
      request.params.id,
      request.merchant.id,
    ]);
    if (!row) throw notFound("customer", request.params.id);
    return serializeCustomer(row);
  });

  app.post("/products", async (request) => {
    const { name } = productBody.parse(request.body ?? {});
    const id = newId("prod");
    await db.query("INSERT INTO products (id, merchant_id, name) VALUES ($1, $2, $3)", [id, request.merchant.id, name]);
    return { id, object: "product", name, active: true, livemode: false };
  });

  app.get<{ Params: { id: string } }>("/prices/:id", async (request) => {
    const [row] = await db.query("SELECT * FROM prices WHERE id = $1 AND merchant_id = $2", [
      request.params.id,
      request.merchant.id,
    ]);
    if (!row) throw notFound("price", request.params.id);
    return serializePrice(row.id, row.product_id, Number(row.unit_amount), "usd", row.interval);
  });

  app.post("/prices", async (request) => {
    const input = priceBody.parse(request.body ?? {});
    const merchantId = request.merchant.id;

    let productId = input.product;
    if (productId) {
      const [product] = await db.query("SELECT id FROM products WHERE id = $1 AND merchant_id = $2", [
        productId,
        merchantId,
      ]);
      if (!product) throw invalidRequest("resource_missing", `No such product: '${productId}'`, "product");
    } else if (input.product_data) {
      productId = newId("prod");
      await db.query("INSERT INTO products (id, merchant_id, name) VALUES ($1, $2, $3)", [
        productId,
        merchantId,
        input.product_data.name,
      ]);
    } else {
      throw invalidRequest("parameter_missing", "A price needs a product or product_data", "product");
    }

    const id = newId("price");
    const interval = input.recurring?.interval ?? null;
    await db.query("INSERT INTO prices (id, merchant_id, product_id, unit_amount, interval) VALUES ($1, $2, $3, $4, $5)", [
      id,
      merchantId,
      productId,
      input.unit_amount,
      interval,
    ]);
    return serializePrice(id, productId!, input.unit_amount, input.currency, interval);
  });
}
