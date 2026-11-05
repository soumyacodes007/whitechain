import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type Deps, send } from "../app.ts";
import { invalidRequest, notFound } from "../errors.ts";
import { emitEvent } from "../events.ts";
import { idempotent } from "../idempotency.ts";
import { createInvoice, getInvoice, invoicePayments, listInvoices, serializeInvoice } from "../invoices.ts";

const createBody = z.object({
  customer: z.object({ name: z.string().min(1), email: z.email().optional() }),
  line_items: z
    .array(
      z.object({
        description: z.string().min(1),
        quantity: z.coerce.number().int().positive().default(1),
        unit_amount: z.coerce.number().int().positive(),
      }),
    )
    .min(1),
  due_date: z.coerce.number().int().positive().optional(),
  late_fee: z
    .object({ type: z.enum(["percent", "fixed"]), value: z.coerce.number().int().positive() })
    .optional(),
  allow_partial: z.coerce.boolean().default(false),
  notes: z.string().optional(),
  currency: z.enum(["usd", "usdt"]).default("usd"),
});

const listQuery = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export async function invoiceRoutes(app: FastifyInstance, { db, config }: Deps) {
  const view = async (id: string, merchantId: string) => {
    const invoice = await getInvoice(db, id, merchantId);
    if (!invoice) throw notFound("invoice", id);
    return serializeInvoice(invoice, await invoicePayments(db, id), config);
  };

  app.post("/invoices", async (request, reply) => {
    const input = createBody.parse(request.body ?? {});
    const merchantId = request.merchant.id;
    const result = await idempotent(db, request, merchantId, async () => {
      const invoice = await db.tx(async (q) => {
        const created = await createInvoice(q, merchantId, {
          customer: input.customer,
          lineItems: input.line_items,
          dueDate: input.due_date ? new Date(input.due_date * 1000) : undefined,
          lateFee: input.late_fee,
          allowPartial: input.allow_partial,
          notes: input.notes,
          currency: input.currency,
        });
        await emitEvent(q, merchantId, "invoice.created", serializeInvoice(created, [], config));
        return created;
      });
      return { status: 200, body: serializeInvoice(invoice, [], config) };
    });
    return send(reply, result);
  });

  app.get("/invoices", async (request) => {
    const { status, limit } = listQuery.parse(request.query);
    const rows = await listInvoices(db, request.merchant.id, status, limit);
    return {
      object: "list",
      data: await Promise.all(rows.map(async (row) => serializeInvoice(row, await invoicePayments(db, row.id), config))),
    };
  });

  app.get<{ Params: { id: string } }>("/invoices/:id", (request) => view(request.params.id, request.merchant.id));

  app.post<{ Params: { id: string } }>("/invoices/:id/send", async (request) => {
    const { id } = request.params;
    const merchantId = request.merchant.id;
    await db.tx(async (q) => {
      const moved = await q.query(
        `UPDATE invoices SET status = 'open', issued_at = now()
         WHERE id = $1 AND merchant_id = $2 AND status = 'draft' RETURNING id`,
        [id, merchantId],
      );
      const invoice = await getInvoice(q, id, merchantId);
      if (!invoice) throw notFound("invoice", id);
      if (moved.length === 0) {
        throw invalidRequest("invoice_unexpected_state", `Can't send an invoice that is ${invoice.status}`);
      }
      await emitEvent(q, merchantId, "invoice.sent", serializeInvoice(invoice, [], config));
    });
    return view(id, merchantId);
  });

  app.post<{ Params: { id: string } }>("/invoices/:id/void", async (request) => {
    const { id } = request.params;
    const merchantId = request.merchant.id;
    // Money already received has to be refunded, not voided, so only unpaid invoices qualify.
    const moved = await db.query(
      `UPDATE invoices SET status = 'void'
       WHERE id = $1 AND merchant_id = $2 AND status IN ('draft', 'open', 'overdue') AND amount_paid = 0
       RETURNING id`,
      [id, merchantId],
    );
    if (moved.length === 0) {
      const invoice = await view(id, merchantId);
      throw invalidRequest("invoice_unexpected_state", `Can't void an invoice that is ${invoice.status} or part paid`);
    }
    return view(id, merchantId);
  });
}
