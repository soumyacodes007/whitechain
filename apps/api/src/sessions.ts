import type { Config } from "./config.ts";
import type { Queryable } from "./db.ts";
import { newId } from "./ids.ts";
import { createIntent, type IntentRow } from "./intents.ts";

export type LineItem = { name: string; quantity: number; unit_amount: number };

export type SessionRow = {
  id: string;
  intent_id: string;
  merchant_id: string;
  line_items: LineItem[];
  success_url: string | null;
  cancel_url: string | null;
  mode: string;
  status: string;
  payment_link_id: string | null;
  client_reference_id: string | null;
  customer_email: string | null;
  amount: string | number | null;
  currency: string | null;
  metadata: Record<string, string>;
  interval_seconds: number | null;
  max_periods: number;
  expires_at: Date | null;
  created_at: Date;
};

export async function createSession(
  q: Queryable,
  config: Config,
  merchant: { id: string; merchant_address: string },
  input: {
    lineItems: LineItem[];
    currency: string;
    metadata: Record<string, string>;
    successUrl?: string | null;
    cancelUrl?: string | null;
    clientReferenceId?: string;
    paymentLinkId?: string;
    source?: string;
  },
) {
  const amount = input.lineItems.reduce((sum, item) => sum + item.quantity * item.unit_amount, 0);
  const intent = await createIntent(q, config, merchant, {
    amount,
    currency: input.currency,
    metadata: input.metadata,
    source: input.source ?? "checkout",
  });
  const id = newId("cs");
  const [session] = await q.query<SessionRow>(
    `INSERT INTO checkout_sessions
       (id, intent_id, merchant_id, line_items, success_url, cancel_url, client_reference_id, payment_link_id)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
     RETURNING *`,
    [
      id,
      intent.id,
      merchant.id,
      JSON.stringify(input.lineItems),
      // Stripe fills in this template, and its own samples rely on that.
      input.successUrl?.replaceAll("{CHECKOUT_SESSION_ID}", id) ?? null,
      input.cancelUrl ?? null,
      input.clientReferenceId ?? null,
      input.paymentLinkId ?? null,
    ],
  );
  return { session: session!, intent };
}

export function serializeSubscriptionSession(
  session: SessionRow,
  config: Pick<Config, "chainId" | "checkoutUrl" | "explorerUrl">,
) {
  return {
    ...serializeSession(
      session,
      {
        id: "",
        amount: session.amount ?? 0,
        currency: session.currency ?? "usd",
        status: session.status === "complete" ? "succeeded" : "requires_payment_method",
        metadata: session.metadata,
        expires_at: session.expires_at ?? session.created_at,
      },
      config,
    ),
    payment_intent: null,
  };
}

export function serializeSession(
  session: SessionRow,
  intent: Pick<IntentRow, "id" | "amount" | "currency" | "status" | "metadata" | "expires_at"> & {
    tx_hash?: string | null;
    payer?: string | null;
  },
  config: Pick<Config, "chainId" | "checkoutUrl" | "explorerUrl">,
) {
  const txHash = intent.tx_hash ?? null;
  return {
    id: session.id,
    object: "checkout.session",
    url: `${config.checkoutUrl}/c/${session.id}`,
    mode: session.mode,
    status: session.status,
    payment_status: intent.status === "succeeded" ? "paid" : "unpaid",
    amount_total: Number(intent.amount),
    currency: intent.currency,
    payment_intent: intent.id,
    success_url: session.success_url,
    cancel_url: session.cancel_url,
    client_reference_id: session.client_reference_id,
    metadata: intent.metadata,
    created: Math.floor(session.created_at.getTime() / 1000),
    expires_at: Math.floor(intent.expires_at.getTime() / 1000),
    livemode: false,
    settlekit: {
      chain_id: config.chainId,
      tx_hash: txHash,
      payer: intent.payer ?? null,
      explorer_url: txHash ? `${config.explorerUrl}/tx/${txHash}` : null,
    },
  };
}
