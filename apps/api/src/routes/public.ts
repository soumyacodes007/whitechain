import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Address, Hex } from "viem";
import type { Deps } from "../app.ts";
import { ApiError, invalidRequest, notFound } from "../errors.ts";
import { centsToUnits, createIntent } from "../intents.ts";
import { amountDue, getInvoice, invoicePayments, serializeInvoice } from "../invoices.ts";
import { invoicePdf } from "../pdf.ts";
import { createSession } from "../sessions.ts";
import { linkByCode, serializeLink } from "./paymentLinks.ts";
import { portalRoutes } from "./portal.ts";

const SELECT_INTENT = `
  SELECT i.*, m.name AS merchant_name, m.merchant_address, m.logo, m.brand_color, m.gasless,
         p.id AS payment_id, p.tx_hash
  FROM payment_intents i
  JOIN merchants m ON m.id = i.merchant_id
  LEFT JOIN payments p ON p.intent_id = i.id`;

const REFUND_STATUS = (paid: number, refunded: number) =>
  refunded === 0 ? "paid" : refunded >= paid ? "refunded" : "partially_refunded";

const relayBody = z.object({
  payer: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  payer_signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  permit: z.object({
    deadline: z.coerce.bigint(),
    v: z.coerce.number().int(),
    r: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    s: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  }),
});
const subscribedBody = z.object({ tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) });

const linkCheckoutBody = z.object({ quantity: z.coerce.number().int().min(1).max(100).default(1) });
const invoicePayBody = z.object({ amount: z.coerce.number().int().positive().optional() });

/** Unauthenticated routes for hosted pages. Each id or client secret is random and acts as the credential. */
export async function publicRoutes(app: FastifyInstance, { db, config, client, writer }: Deps) {
  // Lets @settlekit/react read these from a merchant's own site. They use no cookies.
  app.addHook("onSend", async (_request, reply) => {
    reply.header("access-control-allow-origin", "*");
  });
  app.options("/*", (_request, reply) =>
    reply.header("access-control-allow-headers", "content-type, authorization").code(204).send(),
  );

  // Registered here so the portal shares the CORS headers above.
  app.register(portalRoutes, { db, config, client, writer, prefix: "/portal" });

  const payable = (row: any) => ({
    id: row.id,
    status: row.status,
    amount: Number(row.amount),
    currency: row.currency,
    description: row.description,
    expires_at: Math.floor(row.expires_at.getTime() / 1000),
    expired: row.expires_at < new Date(),
    merchant: { name: row.merchant_name, logo: row.logo, brand_color: row.brand_color },
    payment_id: row.payment_id,
    tx_hash: row.tx_hash,
    explorer_url: row.tx_hash ? `${config.explorerUrl}/tx/${row.tx_hash}` : null,
    pay: {
      chain_id: config.chainId,
      rpc_url: config.rpcUrl,
      explorer_url: config.explorerUrl,
      contract: config.paymentsAddress,
      token: config.usdtAddress,
      intent_id: row.onchain_id,
      merchant: row.merchant_address,
      amount: centsToUnits(row.amount).toString(),
      deadline: String(row.deadline),
      signature: row.signature,
      gasless: row.gasless && Boolean(writer),
      permit_domain: { name: config.permitName, version: config.permitVersion },
    },
  });

  app.get<{ Params: { clientSecret: string } }>("/payment_intents/:clientSecret", async (request) => {
    const [row] = await db.query(`${SELECT_INTENT} WHERE i.client_secret = $1`, [request.params.clientSecret]);
    if (!row) throw notFound("payment_intent", "client_secret");
    return payable(row);
  });

  /** Submits a customer's signed gasless payment, paying the gas from the operator wallet. */
  app.post<{ Params: { clientSecret: string } }>("/payment_intents/:clientSecret/relay", async (request) => {
    const input = relayBody.parse(request.body ?? {});
    if (!writer) throw new ApiError(503, "api_error", "relayer_unavailable", "Gasless payments are not configured");

    const [row] = await db.query(`${SELECT_INTENT} WHERE i.client_secret = $1`, [request.params.clientSecret]);
    if (!row) throw notFound("payment_intent", "client_secret");
    if (!row.gasless) throw invalidRequest("gasless_disabled", "This merchant has gasless checkout turned off");
    if (row.status !== "requires_payment_method") {
      throw invalidRequest("payment_intent_unexpected_state", `This payment is ${row.status}`);
    }
    if (BigInt(row.deadline) * 1000n < BigInt(Date.now())) {
      throw invalidRequest("payment_intent_expired", "This payment has expired");
    }

    // The claim comes first, so a double click or replay can't spend the merchant's gas budget twice.
    const claimed = await db.query(
      `INSERT INTO relayed_txs (intent_id, merchant_id)
       SELECT $1, $2
       WHERE (SELECT count(*) FROM relayed_txs
              WHERE merchant_id = $2 AND created_at > now() - interval '1 day')
             < (SELECT relay_daily_limit FROM merchants WHERE id = $2)
       ON CONFLICT (intent_id) DO NOTHING
       RETURNING intent_id`,
      [row.id, row.merchant_id],
    );
    if (claimed.length === 0) {
      throw new ApiError(429, "rate_limit_error", "relay_limit_reached", "This payment was already sent, or the daily gasless limit is reached");
    }

    try {
      const hash = await writer.relay({
        intentId: row.onchain_id,
        merchant: row.merchant_address as Address,
        amount: centsToUnits(row.amount),
        deadline: BigInt(row.deadline),
        signature: row.signature,
        payer: input.payer as Address,
        payerSignature: input.payer_signature as Hex,
        permit: { ...input.permit, r: input.permit.r as Hex, s: input.permit.s as Hex },
      });
      await db.query("UPDATE relayed_txs SET tx_hash = $2 WHERE intent_id = $1", [row.id, hash]);
      return { tx_hash: hash };
    } catch (cause) {
      // Nothing was sent, so release the claim and let the customer try again.
      await db.query("DELETE FROM relayed_txs WHERE intent_id = $1", [row.id]);
      console.error("relay failed:", cause instanceof Error ? cause.message.split("\n")[0] : cause);
      throw invalidRequest("relay_rejected", "This payment couldn't be submitted. Check your USDT balance and try again");
    }
  });

  app.post<{ Params: { id: string } }>("/checkout/:id/subscribed", async (request) => {
    const { tx_hash } = subscribedBody.parse(request.body ?? {});
    await db.query(
      "UPDATE checkout_sessions SET subscribe_tx = $2 WHERE id = $1 AND mode = 'subscription' AND subscribe_tx IS NULL",
      [request.params.id, tx_hash],
    );
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/checkout/:id", async (request) => {
    const [session] = await db.query("SELECT * FROM checkout_sessions WHERE id = $1", [request.params.id]);
    if (!session) throw notFound("checkout.session", request.params.id);

    if (session.mode === "subscription") {
      const [merchant] = await db.query(
        "SELECT name, logo, brand_color, merchant_address FROM merchants WHERE id = $1",
        [session.merchant_id],
      );
      return {
        id: session.id,
        mode: session.mode,
        status: session.status,
        line_items: session.line_items,
        success_url: session.success_url,
        cancel_url: session.cancel_url,
        amount: Number(session.amount),
        expires_at: Math.floor(session.expires_at.getTime() / 1000),
        expired: session.expires_at < new Date(),
        merchant: { name: merchant.name, logo: merchant.logo, brand_color: merchant.brand_color },
        subscribe: {
          chain_id: config.chainId,
          rpc_url: config.rpcUrl,
          explorer_url: config.explorerUrl,
          contract: config.subscriptionsAddress,
          token: config.usdtAddress,
          merchant: merchant.merchant_address,
          amount: centsToUnits(session.amount).toString(),
          interval_seconds: session.interval_seconds,
          max_periods: session.max_periods,
        },
      };
    }

    const [intent] = await db.query(`${SELECT_INTENT} WHERE i.id = $1`, [session.intent_id]);
    return {
      id: session.id,
      mode: session.mode,
      status: session.status,
      line_items: session.line_items,
      success_url: session.success_url,
      cancel_url: session.cancel_url,
      intent: { ...payable(intent), client_secret: intent.client_secret },
    };
  });

  app.get<{ Params: { id: string } }>("/receipts/:id", async (request) => {
    const [row] = await db.query(
      `SELECT p.*, i.currency, i.metadata, i.description, i.id AS intent_id, m.name AS merchant_name, m.logo,
              m.brand_color, inv.number AS invoice_number
       FROM payments p
       JOIN payment_intents i ON i.id = p.intent_id
       JOIN merchants m ON m.id = i.merchant_id
       LEFT JOIN invoices inv ON inv.id = p.invoice_id
       WHERE p.id = $1`,
      [request.params.id],
    );
    if (!row) throw notFound("receipt", request.params.id);

    const refunds = await db.query(
      "SELECT id, amount, reason, status, tx_hash, created_at FROM refunds WHERE payment_id = $1 ORDER BY created_at, id",
      [row.id],
    );
    const refunded = refunds.reduce((sum, refund) => sum + Number(refund.amount), 0);
    const paid = Number(row.amount);
    const head = await client?.getBlockNumber({ cacheTime: 0 }).catch(() => undefined);

    return {
      id: row.id,
      status: REFUND_STATUS(paid, refunded),
      amount: paid,
      refunded,
      net: paid - refunded,
      currency: row.currency,
      paid_at: Math.floor(row.confirmed_at.getTime() / 1000),
      merchant: { name: row.merchant_name, logo: row.logo, brand_color: row.brand_color },
      reference: row.invoice_number ?? row.metadata?.orderId ?? row.intent_id,
      description: row.description,
      payer: row.payer,
      tx_hash: row.tx_hash,
      block_number: Number(row.block_number),
      confirmations: head === undefined ? null : Number(head - BigInt(row.block_number)) + 1,
      explorer_url: `${config.explorerUrl}/tx/${row.tx_hash}`,
      refunds: refunds.map((refund) => ({
        id: refund.id,
        amount: Number(refund.amount),
        reason: refund.reason,
        status: refund.status,
        date: Math.floor(refund.created_at.getTime() / 1000),
        explorer_url: refund.tx_hash ? `${config.explorerUrl}/tx/${refund.tx_hash}` : null,
      })),
    };
  });

  const openLink = async (code: string) => {
    const link = await linkByCode(db, code);
    if (!link) throw notFound("payment_link", code);
    return { link, available: link.active && (!link.expires_at || link.expires_at > new Date()) };
  };

  app.get<{ Params: { code: string } }>("/links/:code", async (request) => {
    const { link, available } = await openLink(request.params.code);
    const [merchant] = await db.query("SELECT name, logo, brand_color FROM merchants WHERE id = $1", [link.merchant_id]);
    return { ...serializeLink(link, config), available, merchant };
  });

  app.post<{ Params: { code: string } }>("/links/:code/checkout", async (request) => {
    const { quantity } = linkCheckoutBody.parse(request.body ?? {});
    const { link, available } = await openLink(request.params.code);
    if (!available) throw invalidRequest("payment_link_inactive", "This payment link is no longer available");
    if (quantity > 1 && !link.adjustable_quantity) {
      throw invalidRequest("parameter_invalid", "This link is for one item", "quantity");
    }
    const [merchant] = await db.query("SELECT id, merchant_address FROM merchants WHERE id = $1", [link.merchant_id]);

    // The price comes from the database, so a buyer can only choose how many.
    const { session } = await db.tx((q) =>
      createSession(q, config, merchant, {
        lineItems: [{ name: link.name, quantity, unit_amount: Number(link.unit_amount) }],
        currency: "usd",
        metadata: {},
        successUrl: link.success_url,
        paymentLinkId: link.id,
        source: "link",
      }),
    );
    return { session_id: session.id };
  });

  const payableInvoice = async (id: string) => {
    const invoice = await getInvoice(db, id);
    // A draft hasn't been sent, so its id working here would expose unfinished invoices.
    if (!invoice || invoice.status === "draft") throw notFound("invoice", id);
    return invoice;
  };

  app.get<{ Params: { id: string } }>("/invoices/:id", async (request) => {
    const invoice = await payableInvoice(request.params.id);
    const [merchant] = await db.query("SELECT name, logo, brand_color FROM merchants WHERE id = $1", [
      invoice.merchant_id,
    ]);
    return { ...serializeInvoice(invoice, await invoicePayments(db, invoice.id), config), merchant };
  });

  app.get<{ Params: { id: string } }>("/invoices/:id/pdf", async (request, reply) => {
    const invoice = await payableInvoice(request.params.id);
    const [merchant] = await db.query("SELECT name FROM merchants WHERE id = $1", [invoice.merchant_id]);
    const pdf = await invoicePdf(invoice, merchant.name, await invoicePayments(db, invoice.id), config);
    return reply
      .header("content-type", "application/pdf")
      .header("content-disposition", `attachment; filename="${invoice.number}.pdf"`)
      .send(pdf);
  });

  app.post<{ Params: { id: string } }>("/invoices/:id/pay", async (request) => {
    const { amount } = invoicePayBody.parse(request.body ?? {});
    const invoice = await payableInvoice(request.params.id);
    if (!["open", "partially_paid", "overdue"].includes(invoice.status)) {
      throw new ApiError(400, "invalid_request_error", "invoice_not_payable", `This invoice is ${invoice.status}`);
    }

    const remaining = amountDue(invoice) - Number(invoice.amount_paid);
    const paying = amount ?? remaining;
    if (paying > remaining) throw invalidRequest("amount_too_large", "That is more than the amount remaining", "amount");
    if (paying !== remaining && !invoice.allow_partial) {
      throw invalidRequest("partial_not_allowed", "This invoice must be paid in full", "amount");
    }

    const [merchant] = await db.query("SELECT id, merchant_address FROM merchants WHERE id = $1", [invoice.merchant_id]);
    const created = await createIntent(db, config, merchant, {
      amount: paying,
      currency: invoice.currency,
      metadata: { invoice: invoice.number },
      description: `Invoice ${invoice.number}`,
      source: "invoice",
    });
    await db.query("UPDATE payment_intents SET invoice_id = $2 WHERE id = $1", [created.id, invoice.id]);
    return { client_secret: created.client_secret };
  });
}
