import type { FastifyInstance } from "fastify";
import { type Address, formatUnits } from "viem";
import { z } from "zod";
import type { Deps } from "../app.ts";
import { notFound } from "../errors.ts";
import { newId, newSecret, sha256 } from "../ids.ts";

const DAY = 86_400_000;

const paymentsQuery = z.object({
  status: z.string().optional(),
  source: z.string().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const accountBody = z.object({
  name: z.string().min(1).optional(),
  logo: z.url().nullable().optional(),
  brand_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  support_email: z.email().nullable().optional(),
  timezone: z.string().optional(),
  confirmations: z.coerce.number().int().min(1).max(20).optional(),
  gasless: z.coerce.boolean().optional(),
  invoice_prefix: z.string().min(1).max(10).optional(),
});

const noteBody = z.object({ notes: z.string().max(2000) });

const PAYMENT_SELECT = `
  SELECT p.id, p.intent_id, p.amount, p.payer, p.tx_hash, p.block_number, p.confirmed_at, p.gas_paid_by,
         i.currency, i.source, i.description, i.metadata, i.late_settlement, i.onchain_id, i.created_at AS intent_created,
         inv.number AS invoice_number, c.name AS customer_name, c.email AS customer_email,
         coalesce((SELECT sum(r.amount) FROM refunds r WHERE r.payment_id = p.id AND r.status <> 'failed'), 0) AS refunded
  FROM payments p
  JOIN payment_intents i ON i.id = p.intent_id
  LEFT JOIN invoices inv ON inv.id = p.invoice_id
  LEFT JOIN customers c ON c.id = inv.customer_id`;

export async function dashboardRoutes(app: FastifyInstance, { db, config, client, writer }: Deps) {
  const payment = (row: any) => {
    const amount = Number(row.amount);
    const refunded = Number(row.refunded);
    return {
      id: row.id,
      payment_intent: row.intent_id,
      amount,
      refunded,
      net: amount - refunded,
      status: refunded === 0 ? "succeeded" : refunded >= amount ? "refunded" : "partially_refunded",
      currency: row.currency,
      source: row.source,
      description: row.description,
      metadata: row.metadata,
      reference: row.invoice_number ?? row.metadata?.orderId ?? row.intent_id,
      customer: row.customer_name ?? row.customer_email ?? null,
      payer: row.payer,
      late_settlement: row.late_settlement,
      gas_paid_by: row.gas_paid_by,
      tx_hash: row.tx_hash,
      block_number: Number(row.block_number),
      created: Math.floor(row.intent_created.getTime() / 1000),
      settled: Math.floor(row.confirmed_at.getTime() / 1000),
      explorer_url: `${config.explorerUrl}/tx/${row.tx_hash}`,
    };
  };

  app.get("/account", async (request) => {
    const [row] = await db.query("SELECT * FROM merchants WHERE id = $1", [request.merchant.id]);
    const { invoice_seq: _seq, ...account } = row;
    return { ...account, chain_id: config.chainId, operator: writer?.operator ?? null };
  });

  app.post("/account", async (request) => {
    const input = accountBody.parse(request.body ?? {});
    const fields = Object.entries(input).filter(([, value]) => value !== undefined);
    if (fields.length > 0) {
      const set = fields.map(([key], index) => `${key} = $${index + 2}`).join(", ");
      await db.query(`UPDATE merchants SET ${set} WHERE id = $1`, [
        request.merchant.id,
        ...fields.map(([, value]) => value),
      ]);
    }
    const [row] = await db.query("SELECT * FROM merchants WHERE id = $1", [request.merchant.id]);
    return row;
  });

  app.get("/api_keys", async (request) => {
    const rows = await db.query("SELECT id, type, last_used_at FROM api_keys WHERE merchant_id = $1", [
      request.merchant.id,
    ]);
    return { object: "list", data: rows };
  });

  /** Replaces the secret key at once. The old key stops working in the same transaction. */
  app.post("/api_keys/rotate", async (request) => {
    const secretKey = newSecret("sk_test");
    await db.tx(async (q) => {
      await q.query("DELETE FROM api_keys WHERE merchant_id = $1 AND type = 'secret'", [request.merchant.id]);
      await q.query("INSERT INTO api_keys (id, merchant_id, type, hash) VALUES ($1, $2, 'secret', $3)", [
        newId("key"),
        request.merchant.id,
        sha256(secretKey),
      ]);
    });
    return { secret_key: secretKey };
  });

  app.get("/overview", async (request) => {
    const id = request.merchant.id;
    const since = (days: number) => new Date(Date.now() - days * DAY);

    const volume = async (days: number) => {
      const [paid] = await db.query(
        `SELECT coalesce(sum(p.amount), 0) AS total FROM payments p JOIN payment_intents i ON i.id = p.intent_id
         WHERE i.merchant_id = $1 AND p.confirmed_at >= $2`,
        [id, since(days)],
      );
      const [renewals] = await db.query(
        `SELECT coalesce(sum(ch.amount), 0) AS total FROM subscription_charges ch
         JOIN subscriptions s ON s.id = ch.subscription_id
         WHERE s.merchant_id = $1 AND ch.status = 'succeeded' AND ch.created_at >= $2`,
        [id, since(days)],
      );
      return Number(paid.total) + Number(renewals.total);
    };

    const [refunds] = await db.query(
      `SELECT coalesce(sum(amount), 0) AS total FROM refunds
       WHERE merchant_id = $1 AND status = 'succeeded' AND created_at >= $2`,
      [id, since(30)],
    );
    const [invoices] = await db.query(
      `SELECT coalesce(sum(total - amount_paid) FILTER (WHERE status IN ('open', 'partially_paid')), 0) AS open,
              coalesce(sum(total - amount_paid) FILTER (WHERE status = 'overdue'), 0) AS overdue,
              count(*) FILTER (WHERE status = 'overdue')::int AS overdue_count
       FROM invoices WHERE merchant_id = $1`,
      [id],
    );
    const [subscriptions] = await db.query(
      `SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
              count(*) FILTER (WHERE status = 'past_due')::int AS past_due,
              coalesce(sum(amount * 2592000.0 / nullif(interval_seconds, 0)) FILTER (WHERE status = 'active'), 0) AS mrr
       FROM subscriptions WHERE merchant_id = $1`,
      [id],
    );
    const [failedWebhooks] = await db.query(
      `SELECT count(*)::int AS n FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
       WHERE e.merchant_id = $1 AND d.status = 'failed'`,
      [id],
    );
    const [unmatched] = await db.query(
      `SELECT count(*)::int AS n FROM incoming_transfers t
       WHERE t.merchant_id = $1 AND t.manual_reference IS NULL
         AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.tx_hash = t.tx_hash)
         AND NOT EXISTS (SELECT 1 FROM subscription_charges c WHERE c.tx_hash = t.tx_hash)`,
      [id],
    );
    const daily = await db.query(
      `SELECT d::date AS day,
              coalesce((SELECT sum(p.amount) FROM payments p JOIN payment_intents i ON i.id = p.intent_id
                        WHERE i.merchant_id = $1 AND p.confirmed_at::date = d::date), 0)
              + coalesce((SELECT sum(ch.amount) FROM subscription_charges ch JOIN subscriptions s ON s.id = ch.subscription_id
                          WHERE s.merchant_id = $1 AND ch.status = 'succeeded' AND ch.created_at::date = d::date), 0) AS received,
              coalesce((SELECT sum(r.amount) FROM refunds r
                        WHERE r.merchant_id = $1 AND r.status = 'succeeded' AND r.created_at::date = d::date), 0) AS refunded
       FROM generate_series(now() - interval '29 days', now(), interval '1 day') d
       ORDER BY d`,
      [id],
    );
    const activity = await db.query(
      `SELECT id, type, created_at, source_tx FROM events
       WHERE merchant_id = $1 ORDER BY created_at DESC, id LIMIT 10`,
      [id],
    );

    const volume30 = await volume(30);
    const refunded30 = Number(refunds.total);
    const [merchant] = await db.query("SELECT payout_wallet, refund_wallet FROM merchants WHERE id = $1", [id]);

    let wallet = null;
    if (writer) {
      const funding = await writer.refundFunding(merchant.refund_wallet as Address).catch(() => null);
      const native = await client?.getBalance({ address: merchant.refund_wallet as Address }).catch(() => null);
      if (funding) {
        wallet = {
          address: merchant.payout_wallet,
          usdt: Number(formatUnits(funding.balance, 6)),
          wbt: native === null || native === undefined ? null : Number(formatUnits(native, 18)),
          refund_allowance: Number(formatUnits(funding.allowance, 6)),
        };
      }
    }

    const attention: { kind: string; message: string; href: string }[] = [];
    if (invoices.overdue_count > 0) {
      attention.push({ kind: "overdue", message: `${invoices.overdue_count} overdue invoices`, href: "/dashboard/invoices?status=overdue" });
    }
    if (subscriptions.past_due > 0) {
      attention.push({ kind: "renewals", message: `${subscriptions.past_due} failed renewals`, href: "/dashboard/subscriptions" });
    }
    if (failedWebhooks.n > 0) {
      attention.push({ kind: "webhooks", message: `${failedWebhooks.n} failed webhook deliveries`, href: "/dashboard/developers" });
    }
    if (unmatched.n > 0) {
      attention.push({ kind: "unmatched", message: `${unmatched.n} unmatched incoming transfers`, href: "/dashboard/reports" });
    }
    if (wallet && wallet.usdt < 10) {
      attention.push({ kind: "balance", message: "Refund wallet is low on USDT", href: "/dashboard/settings" });
    }

    return {
      volume: { today: await volume(1), week: await volume(7), month: volume30 },
      net: volume30 - refunded30,
      refund_rate: volume30 === 0 ? 0 : (refunded30 / volume30) * 100,
      invoices: { open: Number(invoices.open), overdue: Number(invoices.overdue) },
      subscriptions: { active: subscriptions.active, mrr: Math.round(Number(subscriptions.mrr)) },
      daily: daily.map((row) => ({
        day: new Date(row.day).toISOString().slice(0, 10),
        received: Number(row.received),
        refunded: Number(row.refunded),
      })),
      attention,
      activity: activity.map((row) => ({
        id: row.id,
        type: row.type,
        date: Math.floor(row.created_at.getTime() / 1000),
        explorer_url: row.source_tx ? `${config.explorerUrl}/tx/${row.source_tx}` : null,
      })),
      wallet,
    };
  });

  app.get("/payments", async (request) => {
    const { status, source, q, limit } = paymentsQuery.parse(request.query);
    const params: unknown[] = [request.merchant.id, limit];
    const filters = ["i.merchant_id = $1"];
    if (source) {
      params.push(source);
      filters.push(`i.source = $${params.length}`);
    }
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      const n = params.length;
      filters.push(
        `(lower(p.tx_hash) LIKE $${n} OR lower(p.payer) LIKE $${n} OR lower(i.id) LIKE $${n}
          OR lower(coalesce(i.metadata->>'orderId', '')) LIKE $${n} OR lower(coalesce(inv.number, '')) LIKE $${n})`,
      );
    }
    const rows = await db.query(
      `${PAYMENT_SELECT} WHERE ${filters.join(" AND ")} ORDER BY p.confirmed_at DESC, p.id LIMIT $2`,
      params,
    );
    const data = rows.map(payment).filter((row) => !status || row.status === status);
    return { object: "list", data };
  });

  app.get<{ Params: { id: string } }>("/payments/:id", async (request) => {
    const [row] = await db.query(`${PAYMENT_SELECT} WHERE p.id = $1 AND i.merchant_id = $2`, [
      request.params.id,
      request.merchant.id,
    ]);
    if (!row) throw notFound("payment", request.params.id);

    const refunds = await db.query(
      "SELECT id, amount, reason, note, status, tx_hash, created_at FROM refunds WHERE payment_id = $1 ORDER BY created_at, id",
      [row.id],
    );
    const deliveries = await db.query(
      `SELECT d.id, d.attempt, d.status, d.status_code, e.type, e.created_at
       FROM webhook_deliveries d JOIN events e ON e.id = d.event_id
       WHERE e.payload->'data'->'object'->>'id' = $1 OR e.payload->'data'->'object'->>'payment_intent' = $1
       ORDER BY e.created_at, e.id`,
      [row.intent_id],
    );
    const head = await client?.getBlockNumber({ cacheTime: 0 }).catch(() => undefined);

    return {
      ...payment(row),
      confirmations: head === undefined ? null : Number(head - BigInt(row.block_number)) + 1,
      refunds: refunds.map((refund) => ({
        id: refund.id,
        amount: Number(refund.amount),
        reason: refund.reason,
        note: refund.note,
        status: refund.status,
        date: Math.floor(refund.created_at.getTime() / 1000),
        explorer_url: refund.tx_hash ? `${config.explorerUrl}/tx/${refund.tx_hash}` : null,
      })),
      webhook_deliveries: deliveries.map((delivery) => ({
        id: delivery.id,
        type: delivery.type,
        status: delivery.status,
        status_code: delivery.status_code,
        attempts: delivery.attempt,
      })),
    };
  });

  app.get("/customers", async (request) => {
    const id = request.merchant.id;
    const invoiceCustomers = await db.query(
      `SELECT c.id, c.name, c.email, c.wallets, c.notes,
              coalesce(sum(p.amount), 0)
                + coalesce((SELECT sum(ch.amount) FROM subscription_charges ch JOIN subscriptions s ON s.id = ch.subscription_id
                            WHERE s.customer_id = c.id AND ch.status = 'succeeded'), 0) AS paid,
              min(p.confirmed_at) AS first_payment, max(p.confirmed_at) AS last_payment,
              count(DISTINCT inv.id) FILTER (WHERE inv.status IN ('open', 'partially_paid', 'overdue'))::int AS open_invoices,
              coalesce((SELECT sum(r.amount) FROM refunds r JOIN payments rp ON rp.id = r.payment_id
                        JOIN invoices ri ON ri.id = rp.invoice_id
                        WHERE ri.customer_id = c.id AND r.status = 'succeeded'), 0) AS refunded
       FROM customers c
       LEFT JOIN invoices inv ON inv.customer_id = c.id
       LEFT JOIN payments p ON p.invoice_id = inv.id
       WHERE c.merchant_id = $1
       GROUP BY c.id
       ORDER BY max(p.confirmed_at) DESC NULLS LAST, c.created_at DESC
       LIMIT 200`,
      [id],
    );
    return {
      object: "list",
      data: invoiceCustomers.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        wallets: row.wallets,
        notes: row.notes,
        paid: Number(row.paid),
        refunded: Number(row.refunded),
        open_invoices: row.open_invoices,
        first_payment: row.first_payment ? Math.floor(row.first_payment.getTime() / 1000) : null,
        last_payment: row.last_payment ? Math.floor(row.last_payment.getTime() / 1000) : null,
      })),
    };
  });

  app.post<{ Params: { id: string } }>("/customers/:id/notes", async (request) => {
    const { notes } = noteBody.parse(request.body ?? {});
    const moved = await db.query("UPDATE customers SET notes = $3 WHERE id = $1 AND merchant_id = $2 RETURNING id", [
      request.params.id,
      request.merchant.id,
      notes,
    ]);
    if (moved.length === 0) throw notFound("customer", request.params.id);
    return { id: request.params.id, notes };
  });

  app.get("/webhook_endpoints", async (request) => {
    const rows = await db.query(
      `SELECT e.id, e.url, e.events, e.active,
              count(d.id) FILTER (WHERE d.delivered_at > now() - interval '24 hours')::int AS delivered_24h,
              count(d.id) FILTER (WHERE d.status = 'failed')::int AS failed
       FROM webhook_endpoints e LEFT JOIN webhook_deliveries d ON d.endpoint_id = e.id
       WHERE e.merchant_id = $1
       GROUP BY e.id ORDER BY e.created_at DESC`,
      [request.merchant.id],
    );
    return { object: "list", data: rows };
  });

  app.get("/event_log", async (request) => {
    const rows = await db.query(
      `SELECT ev.id, ev.type, ev.created_at,
              coalesce(json_agg(json_build_object(
                'id', d.id, 'status', d.status, 'status_code', d.status_code, 'attempt', d.attempt,
                'url', e.url
              )) FILTER (WHERE d.id IS NOT NULL), '[]') AS deliveries
       FROM events ev
       LEFT JOIN webhook_deliveries d ON d.event_id = ev.id
       LEFT JOIN webhook_endpoints e ON e.id = d.endpoint_id
       WHERE ev.merchant_id = $1
       GROUP BY ev.id ORDER BY ev.created_at DESC, ev.id LIMIT 50`,
      [request.merchant.id],
    );
    return {
      object: "list",
      data: rows.map((row) => ({ ...row, created_at: Math.floor(row.created_at.getTime() / 1000) })),
    };
  });

  app.get<{ Params: { id: string } }>("/webhook_deliveries/:id/attempts", async (request) => {
    const rows = await db.query(
      `SELECT a.attempt, a.status_code, a.duration_ms, a.response_body, a.created_at
       FROM webhook_attempts a
       JOIN webhook_deliveries d ON d.id = a.delivery_id
       JOIN webhook_endpoints e ON e.id = d.endpoint_id
       WHERE a.delivery_id = $1 AND e.merchant_id = $2
       ORDER BY a.attempt`,
      [request.params.id, request.merchant.id],
    );
    return { object: "list", data: rows };
  });

  /** Sends an event again, keeping its id so a receiver that stored it can ignore the repeat. */
  app.post<{ Params: { id: string } }>("/events/:id/replay", async (request) => {
    const moved = await db.query(
      `UPDATE webhook_deliveries d SET status = 'pending', next_retry_at = now(), attempt = 0
       FROM events ev WHERE ev.id = d.event_id AND ev.id = $1 AND ev.merchant_id = $2
       RETURNING d.id`,
      [request.params.id, request.merchant.id],
    );
    if (moved.length === 0) throw notFound("event", request.params.id);
    return { id: request.params.id, replayed: moved.length };
  });
}
