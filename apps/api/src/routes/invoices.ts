import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { type Deps, send } from "../app.ts";
import { invalidRequest, notFound } from "../errors.ts";
import { queueInvoice } from "../emails.ts";
import { emitEvent } from "../events.ts";
import { idempotent } from "../idempotency.ts";
import { amountDue, createInvoice, getInvoice, invoicePayments, listInvoices, serializeInvoice } from "../invoices.ts";
import { recordAndSendReminder } from "../reminders.ts";

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
  reminders: z.coerce.boolean().default(true),
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
          reminders: input.reminders,
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
      if (invoice.customer_email) {
        await queueInvoice(q, config, {
          merchantId,
          to: invoice.customer_email,
          invoiceId: id,
          number: invoice.number,
          amount: amountDue(invoice),
          dueDate: invoice.due_date,
        });
      }
    });
    return view(id, merchantId);
  });

  app.post<{ Params: { id: string } }>("/invoices/:id/remind", async (request) => {
    const { id } = request.params;
    const invoice = await getInvoice(db, id, request.merchant.id);
    if (!invoice) throw notFound("invoice", id);
    if (!["open", "partially_paid", "overdue"].includes(invoice.status)) {
      throw invalidRequest("invoice_unexpected_state", `Can't remind for an invoice that is ${invoice.status}`);
    }
    if (!invoice.customer_email) throw invalidRequest("customer_email_missing", "This customer has no email on file");
    await recordAndSendReminder(db, config, invoice, "manual");
    return view(id, request.merchant.id);
  });

  app.get<{ Params: { id: string } }>("/invoices/:id/reminders", async (request) => {
    await view(request.params.id, request.merchant.id);
    const rows = await db.query("SELECT kind, sent_at FROM reminders WHERE invoice_id = $1 ORDER BY sent_at DESC, id", [
      request.params.id,
    ]);
    return {
      object: "list",
      data: rows.map((row) => ({ kind: row.kind, sent_at: Math.floor(row.sent_at.getTime() / 1000) })),
    };
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
