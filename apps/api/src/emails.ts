import type { Config } from "./config.ts";
import type { Db, Queryable } from "./db.ts";
import { newId } from "./ids.ts";

const MAX_ATTEMPTS = 5;
const RETRY_SECONDS = 60;

const usdt = (cents: number) => `${(cents / 100).toFixed(2)} USDT`;
const day = (value: Date) => value.toISOString().slice(0, 10);

type Email = { to: string; kind: string; subject: string; text: string; merchantId?: string; invoiceId?: string };

export async function enqueueEmail(q: Queryable, email: Email) {
  await q.query(
    `INSERT INTO emails (id, merchant_id, to_address, kind, subject, body, invoice_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      newId("em"),
      email.merchantId ?? null,
      email.to,
      email.kind,
      email.subject,
      email.text,
      email.invoiceId ?? null,
    ],
  );
}

const merchantName = async (q: Queryable, id: string) =>
  (await q.query<{ name: string }>("SELECT name FROM merchants WHERE id = $1", [id]))[0]!.name;

export async function queueReceipt(
  q: Queryable,
  config: Config,
  input: { merchantId: string; to: string; paymentId: string; amount: number; txHash: string },
) {
  const name = await merchantName(q, input.merchantId);
  await enqueueEmail(q, {
    merchantId: input.merchantId,
    to: input.to,
    kind: "receipt",
    subject: `Your receipt from ${name}`,
    text: [
      `You paid ${usdt(input.amount)} to ${name}.`,
      `Receipt: ${config.checkoutUrl}/r/${input.paymentId}`,
      `Transaction: ${config.explorerUrl}/tx/${input.txHash}`,
    ].join("\n"),
  });
}

export async function queueInvoice(
  q: Queryable,
  config: Config,
  input: { merchantId: string; to: string; invoiceId: string; number: string; amount: number; dueDate: Date | null },
) {
  const name = await merchantName(q, input.merchantId);
  await enqueueEmail(q, {
    merchantId: input.merchantId,
    invoiceId: input.invoiceId,
    to: input.to,
    kind: "invoice",
    subject: `Invoice ${input.number} from ${name}`,
    text: [
      `${name} sent you an invoice for ${usdt(input.amount)}.`,
      input.dueDate ? `Due: ${day(input.dueDate)}` : "",
      `View, pay or download the PDF: ${config.checkoutUrl}/i/${input.invoiceId}`,
    ]
      .filter(Boolean)
      .join("\n"),
  });
}

const REMINDER_OPENERS: Record<string, string> = {
  before_due: "is due soon",
  due_today: "is due today",
  overdue: "is overdue",
  manual: "is waiting for payment",
};

export async function queueReminder(
  q: Queryable,
  config: Config,
  input: {
    merchantId: string;
    to: string;
    invoiceId: string;
    number: string;
    remaining: number;
    dueDate: Date | null;
    kind: string;
  },
) {
  const name = await merchantName(q, input.merchantId);
  await enqueueEmail(q, {
    merchantId: input.merchantId,
    invoiceId: input.invoiceId,
    to: input.to,
    kind: "reminder",
    subject: `Invoice ${input.number} ${REMINDER_OPENERS[input.kind]}`,
    text: [
      `Your invoice from ${name} ${REMINDER_OPENERS[input.kind]}.`,
      `Amount remaining: ${usdt(input.remaining)}`,
      input.dueDate ? `Due date: ${day(input.dueDate)}` : "",
      `Pay here: ${config.checkoutUrl}/i/${input.invoiceId}`,
    ]
      .filter(Boolean)
      .join("\n"),
  });
}

export async function queueRefund(
  q: Queryable,
  config: Config,
  input: { merchantId: string; to: string; amount: number; reason: string; txHash: string; paymentId: string },
) {
  const name = await merchantName(q, input.merchantId);
  await enqueueEmail(q, {
    merchantId: input.merchantId,
    to: input.to,
    kind: "refund",
    subject: `${name} refunded ${usdt(input.amount)}`,
    text: [
      `${name} refunded ${usdt(input.amount)} to your wallet.`,
      `Reason: ${input.reason.replaceAll("_", " ")}`,
      `Transaction: ${config.explorerUrl}/tx/${input.txHash}`,
      `Receipt: ${config.checkoutUrl}/r/${input.paymentId}`,
    ].join("\n"),
  });
}

export async function queueRenewal(
  q: Queryable,
  config: Config,
  input: { merchantId: string; to: string; plan: string; amount: number; nextChargeAt: Date | null; failed: boolean },
) {
  const name = await merchantName(q, input.merchantId);
  await enqueueEmail(q, {
    merchantId: input.merchantId,
    to: input.to,
    kind: input.failed ? "renewal_failed" : "renewal",
    subject: input.failed ? `Your ${input.plan} renewal failed` : `Your ${input.plan} renewed`,
    text: input.failed
      ? [
          `We couldn't charge ${usdt(input.amount)} for ${input.plan} from ${name}.`,
          "Your wallet needs more USDT, or a higher allowance.",
          `Update allowance: ${config.checkoutUrl}/portal`,
        ].join("\n")
      : [
          `We charged ${usdt(input.amount)} for ${input.plan} from ${name}.`,
          input.nextChargeAt ? `Next charge: ${day(input.nextChargeAt)}` : "",
          `Manage: ${config.checkoutUrl}/portal`,
        ]
          .filter(Boolean)
          .join("\n"),
  });
}

export async function queueCancelled(
  q: Queryable,
  input: { merchantId: string; to: string; plan: string; endsAt: Date | null },
) {
  const name = await merchantName(q, input.merchantId);
  await enqueueEmail(q, {
    merchantId: input.merchantId,
    to: input.to,
    kind: "subscription_cancelled",
    subject: `Your ${input.plan} is cancelled`,
    text: [
      `Your ${input.plan} subscription with ${name} is cancelled, and no further charges will be made.`,
      input.endsAt ? `Your paid period ends ${day(input.endsAt)}.` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  });
}

/** Sends the outbox. With no provider key, it marks mail as logged so the rest of the product still works. */
export async function deliverEmails(db: Db, config: Config, limit = 20) {
  const due = await db.query(
    `UPDATE emails SET attempts = attempts + 1, next_attempt_at = now() + make_interval(secs => $2)
     WHERE id IN (
       SELECT id FROM emails WHERE status = 'pending' AND next_attempt_at <= now()
       ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [limit, RETRY_SECONDS],
  );

  for (const email of due) {
    if (!config.resendApiKey) {
      // Printed for local work. Magic links never reach the merchant's email log, only this console.
      console.log(`[email] ${email.to_address}: ${email.subject}
${email.body}`);
      await db.query("UPDATE emails SET status = 'logged', sent_at = now() WHERE id = $1", [email.id]);
      continue;
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${config.resendApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: config.emailFrom,
        to: email.to_address,
        subject: email.subject,
        text: email.body,
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);

    if (response?.ok) {
      await db.query("UPDATE emails SET status = 'sent', sent_at = now() WHERE id = $1", [email.id]);
    } else if (email.attempts >= MAX_ATTEMPTS) {
      await db.query("UPDATE emails SET status = 'failed' WHERE id = $1", [email.id]);
    }
  }
  return due.length;
}
