import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { type Address, type Hex, verifyMessage } from "viem";
import { z } from "zod";
import type { Deps } from "../app.ts";
import { enqueueEmail } from "../emails.ts";
import { ApiError, invalidRequest } from "../errors.ts";
import { serializeSubscription, type SubscriptionRow } from "../subscriptions.ts";

const MAX_SESSION_SECONDS = 60 * 60;

const MAGIC_LINK_SECONDS = 30 * 60;

const magicBody = z.object({ email: z.email() });
const signInBody = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  expires: z.coerce.number().int().positive(),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});

export const signInMessage = (address: string, expires: number) =>
  `Sign in to your SettleKit customer portal\nWallet: ${address}\nExpires: ${expires}`;

export async function portalRoutes(app: FastifyInstance, { db, config }: Deps) {
  const mac = (value: string) => createHmac("sha256", `portal:${config.signerKey}`).update(value).digest("hex");

  /** Subjects are base64url so an email's dots can't collide with the token's separators. */
  const issue = (subject: string, expires: number) => {
    const payload = `${Buffer.from(subject).toString("base64url")}.${expires}`;
    return `${payload}.${mac(payload)}`;
  };

  app.post("/magic", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request) => {
    const { email } = magicBody.parse(request.body ?? {});
    const subject = email.toLowerCase();

    const [known] = await db.query(
      `SELECT 1 FROM customers WHERE lower(email) = $1
       UNION ALL SELECT 1 FROM payment_intents WHERE lower(customer_email) = $1
       LIMIT 1`,
      [subject],
    );
    if (known) {
      const token = issue(subject, Math.floor(Date.now() / 1000) + MAGIC_LINK_SECONDS);
      await enqueueEmail(db, {
        to: email,
        kind: "magic_link",
        subject: "Sign in to your payments",
        text: `Open this link to see your payments. It works for 30 minutes.\n${config.checkoutUrl}/portal?token=${token}`,
      });
    }
    // The answer is the same either way, so this can't be used to find out who is a customer.
    return { ok: true };
  });

  app.post("/session", async (request) => {
    const { address, expires, signature } = signInBody.parse(request.body ?? {});
    const now = Math.floor(Date.now() / 1000);
    if (expires <= now || expires > now + MAX_SESSION_SECONDS) {
      throw invalidRequest("sign_in_expired", "This sign-in has expired");
    }
    const valid = await verifyMessage({
      address: address as Address,
      message: signInMessage(address, expires),
      signature: signature as Hex,
    }).catch(() => false);
    if (!valid) throw invalidRequest("bad_signature", "That signature doesn't match this wallet");

    return { token: issue(address.toLowerCase(), expires), expires };
  });

  app.get("/", async (request) => {
    const [, token = ""] = (request.headers.authorization ?? "").split(" ");
    const [encoded, expires, signature] = token.split(".");
    const expected = Buffer.from(mac(`${encoded}.${expires}`));
    const given = Buffer.from(signature ?? "");
    const valid = given.length === expected.length && timingSafeEqual(given, expected);
    if (!valid || Number(expires) < Date.now() / 1000) {
      throw new ApiError(401, "invalid_request_error", "session_invalid", "Please sign in again");
    }
    const address = Buffer.from(encoded!, "base64url").toString();

    const payments = await db.query(
      `SELECT p.id, p.amount, p.tx_hash, p.confirmed_at, i.currency, m.name AS merchant,
              inv.number AS invoice_number,
              coalesce((SELECT sum(r.amount) FROM refunds r WHERE r.payment_id = p.id AND r.status = 'succeeded'), 0) AS refunded
       FROM payments p
       JOIN payment_intents i ON i.id = p.intent_id
       JOIN merchants m ON m.id = i.merchant_id
       LEFT JOIN invoices inv ON inv.id = p.invoice_id
       LEFT JOIN customers c ON c.id = i.customer_id
       WHERE lower(p.payer) = $1 OR lower(i.customer_email) = $1 OR lower(c.email) = $1
       ORDER BY p.confirmed_at DESC LIMIT 100`,
      [address],
    );
    const invoices = await db.query(
      `SELECT DISTINCT inv.id, inv.number, inv.status, inv.total, inv.amount_paid, inv.due_date, m.name AS merchant
       FROM invoices inv
       JOIN payments p ON p.invoice_id = inv.id
       JOIN merchants m ON m.id = inv.merchant_id
       LEFT JOIN customers c ON c.id = inv.customer_id
       WHERE lower(p.payer) = $1 OR lower(c.email) = $1`,
      [address],
    );
    const subscriptions = await db.query<SubscriptionRow & { merchant: string }>(
      `SELECT s.*, m.name AS merchant FROM subscriptions s JOIN merchants m ON m.id = s.merchant_id
       LEFT JOIN customers c ON c.id = s.customer_id
       WHERE lower(s.wallet) = $1 OR lower(c.email) = $1 ORDER BY s.created_at DESC`,
      [address],
    );
    const refunds = await db.query(
      `SELECT r.id, r.amount, r.reason, r.status, r.tx_hash, r.created_at, p.id AS payment_id, m.name AS merchant
       FROM refunds r
       JOIN payments p ON p.id = r.payment_id
       JOIN payment_intents i ON i.id = p.intent_id
       JOIN merchants m ON m.id = i.merchant_id
       LEFT JOIN customers c ON c.id = i.customer_id
       WHERE (lower(p.payer) = $1 OR lower(i.customer_email) = $1 OR lower(c.email) = $1) AND r.status = 'succeeded'
       ORDER BY r.created_at DESC`,
      [address],
    );

    return {
      address,
      payments: payments.map((row) => ({
        id: row.id,
        merchant: row.merchant,
        amount: Number(row.amount),
        refunded: Number(row.refunded),
        reference: row.invoice_number,
        date: Math.floor(row.confirmed_at.getTime() / 1000),
        explorer_url: `${config.explorerUrl}/tx/${row.tx_hash}`,
      })),
      invoices: invoices.map((row) => ({
        id: row.id,
        number: row.number,
        merchant: row.merchant,
        status: row.status,
        total: Number(row.total),
        amount_paid: Number(row.amount_paid),
        due_date: row.due_date ? Math.floor(row.due_date.getTime() / 1000) : null,
      })),
      subscriptions: subscriptions.map((row) => ({
        ...serializeSubscription(row, config),
        merchant: row.merchant,
      })),
      refunds: refunds.map((row) => ({
        id: row.id,
        merchant: row.merchant,
        payment_id: row.payment_id,
        amount: Number(row.amount),
        reason: row.reason,
        date: Math.floor(row.created_at.getTime() / 1000),
        explorer_url: `${config.explorerUrl}/tx/${row.tx_hash}`,
      })),
      token: config.usdtAddress,
      rpc_url: config.rpcUrl,
      chain_id: config.chainId,
    };
  });
}
