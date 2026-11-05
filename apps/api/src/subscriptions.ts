import type { Config } from "./config.ts";
import type { ChainWriter } from "./chain.ts";
import { customerForWallet } from "./customers.ts";
import type { Db, Queryable } from "./db.ts";
import { queueCancelled, queueRenewal } from "./emails.ts";
import { emitEvent, type EventSource } from "./events.ts";
import { newId } from "./ids.ts";
import { unitsToCents } from "./intents.ts";

const DAY = 86_400;
/** Delay before each retry of a failed renewal. One more failure after these cancels the subscription. */
export const RENEWAL_RETRY_SECONDS = [DAY, 3 * DAY];
/** How long a sent renewal stays hidden from the keeper while the indexer catches up. */
const KEEPER_LEASE_SECONDS = 60;

export const INTERVALS: Record<string, number> = { week: 7 * DAY, month: 30 * DAY };

export type SubscriptionRow = {
  id: string;
  merchant_id: string;
  onchain_sub_id: string | number;
  customer_id: string | null;
  status: string;
  next_charge_at: Date | null;
  periods_charged: number;
  plan_name: string | null;
  amount: string | number;
  currency: string;
  interval_seconds: number;
  max_periods: number;
  wallet: string | null;
  metadata: Record<string, string>;
  failed_attempts: number;
  canceled_at: Date | null;
  created_at: Date;
};

export function serializeSubscription(row: SubscriptionRow, config: Pick<Config, "chainId" | "subscriptionsAddress">) {
  const interval = row.interval_seconds === INTERVALS.week ? "week" : "month";
  return {
    id: row.id,
    object: "subscription",
    status: row.status,
    customer: row.customer_id,
    plan: {
      name: row.plan_name,
      amount: Number(row.amount),
      currency: row.currency,
      interval,
      interval_seconds: row.interval_seconds,
    },
    current_period_end: row.next_charge_at ? Math.floor(row.next_charge_at.getTime() / 1000) : null,
    periods_charged: row.periods_charged,
    max_periods: row.max_periods,
    canceled_at: row.canceled_at ? Math.floor(row.canceled_at.getTime() / 1000) : null,
    metadata: row.metadata,
    created: Math.floor(row.created_at.getTime() / 1000),
    livemode: false,
    settlekit: {
      chain_id: config.chainId,
      contract: config.subscriptionsAddress,
      onchain_id: Number(row.onchain_sub_id),
      wallet: row.wallet,
    },
  };
}

const updateSubscription = async (q: Queryable, id: string, set: string, params: unknown[]) =>
  (await q.query<SubscriptionRow>(`UPDATE subscriptions SET ${set} WHERE id = $1 RETURNING *`, [id, ...params]))[0]!;

const contactEmail = async (q: Queryable, customerId: string | null) =>
  customerId
    ? (await q.query<{ email: string | null }>("SELECT email FROM customers WHERE id = $1", [customerId]))[0]?.email
    : null;

export async function cancelSubscription(q: Queryable, config: Config, id: string, source?: EventSource) {
  const [before] = await q.query<SubscriptionRow>("SELECT next_charge_at FROM subscriptions WHERE id = $1", [id]);
  const [row] = await q.query<SubscriptionRow>(
    `UPDATE subscriptions SET status = 'canceled', canceled_at = now(), next_charge_at = NULL
     WHERE id = $1 AND status <> 'canceled' RETURNING *`,
    [id],
  );
  if (!row) return row;

  await emitEvent(q, row.merchant_id, "customer.subscription.deleted", serializeSubscription(row, config), source);
  const to = await contactEmail(q, row.customer_id);
  if (to) {
    await queueCancelled(q, {
      merchantId: row.merchant_id,
      to,
      plan: row.plan_name ?? "subscription",
      endsAt: before?.next_charge_at ?? null,
    });
  }
  return row;
}

type LogRef = { source: EventSource; blockNumber: bigint };

/** Handlers for the Subscriptions contract's events, called once each log has enough confirmations. */
export const subscriptionLogs = {
  async subscribed(
    q: Queryable,
    config: Config,
    log: LogRef,
    args: { subId: bigint; merchant: string; customer: string; amount: bigint; interval: bigint; maxPeriods: bigint },
    firstChargeDueAt: Date,
  ) {
    const [existing] = await q.query("SELECT id FROM subscriptions WHERE onchain_sub_id = $1", [args.subId.toString()]);
    if (existing) return;

    const amount = unitsToCents(args.amount);
    const [session] = await q.query(
      `SELECT s.* FROM checkout_sessions s JOIN merchants m ON m.id = s.merchant_id
       WHERE s.mode = 'subscription' AND s.status IN ('open', 'expired') AND lower(m.merchant_address) = lower($1)
         AND s.amount = $2 AND s.interval_seconds = $3
         AND (s.subscribe_tx = $4 OR s.subscribe_tx IS NULL)
       ORDER BY (s.subscribe_tx = $4) DESC NULLS LAST, s.created_at
       LIMIT 1`,
      [args.merchant, amount, Number(args.interval), log.source.txHash],
    );
    if (!session) return;

    const customerId = await customerForWallet(q, session.merchant_id, args.customer, session.customer_email);

    const [row] = await q.query<SubscriptionRow>(
      `INSERT INTO subscriptions
         (id, merchant_id, onchain_sub_id, customer_id, status, next_charge_at, session_id, plan_name, amount, currency,
          interval_seconds, max_periods, wallet, metadata)
       VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
       RETURNING *`,
      [
        newId("sub"),
        session.merchant_id,
        args.subId.toString(),
        customerId,
        firstChargeDueAt,
        session.id,
        session.line_items[0]?.name ?? null,
        amount,
        session.currency,
        Number(args.interval),
        Number(args.maxPeriods),
        args.customer,
        JSON.stringify(session.metadata),
      ],
    );
    await q.query("UPDATE checkout_sessions SET status = 'complete' WHERE id = $1", [session.id]);
    await emitEvent(q, row!.merchant_id, "customer.subscription.created", serializeSubscription(row!, config), log.source);
  },

  async charged(
    q: Queryable,
    config: Config,
    log: LogRef,
    args: { subId: bigint; period: bigint; amount: bigint },
    nextChargeAt: Date,
  ) {
    const [sub] = await q.query<SubscriptionRow>("SELECT * FROM subscriptions WHERE onchain_sub_id = $1", [
      args.subId.toString(),
    ]);
    if (!sub) return;

    const inserted = await q.query(
      `INSERT INTO subscription_charges (id, subscription_id, period, amount, status, tx_hash, log_index, block_number)
       VALUES ($1, $2, $3, $4, 'succeeded', $5, $6, $7)
       ON CONFLICT (tx_hash, log_index) DO NOTHING
       RETURNING id`,
      [
        newId("chg"),
        sub.id,
        Number(args.period),
        unitsToCents(args.amount),
        log.source.txHash,
        log.source.logIndex,
        log.blockNumber.toString(),
      ],
    );
    if (inserted.length === 0) return;

    const row = await updateSubscription(
      q,
      sub.id,
      "periods_charged = GREATEST(periods_charged, $2), failed_attempts = 0, next_charge_at = $3, status = CASE WHEN status = 'past_due' THEN 'active' ELSE status END",
      [Number(args.period), nextChargeAt],
    );
    if (Number(args.period) > 1) {
      await emitEvent(q, row.merchant_id, "customer.subscription.updated", serializeSubscription(row, config), log.source);
      const to = await contactEmail(q, row.customer_id);
      if (to) {
        await queueRenewal(q, config, {
          merchantId: row.merchant_id,
          to,
          plan: row.plan_name ?? "subscription",
          amount: unitsToCents(args.amount),
          nextChargeAt,
          failed: false,
        });
      }
    }
  },

  async chargeFailed(q: Queryable, config: Config, log: LogRef, args: { subId: bigint; period: bigint; amount: bigint }) {
    const [sub] = await q.query<SubscriptionRow>("SELECT * FROM subscriptions WHERE onchain_sub_id = $1", [
      args.subId.toString(),
    ]);
    if (!sub) return;

    const inserted = await q.query(
      `INSERT INTO subscription_charges (id, subscription_id, period, amount, status, tx_hash, log_index, block_number)
       VALUES ($1, $2, $3, $4, 'failed', $5, $6, $7)
       ON CONFLICT (tx_hash, log_index) DO NOTHING
       RETURNING id`,
      [
        newId("chg"),
        sub.id,
        Number(args.period),
        unitsToCents(args.amount),
        log.source.txHash,
        log.source.logIndex,
        log.blockNumber.toString(),
      ],
    );
    if (inserted.length === 0) return;

    await emitEvent(
      q,
      sub.merchant_id,
      "invoice.payment_failed",
      { ...serializeSubscription(sub, config), attempt: sub.failed_attempts + 1, period: Number(args.period) },
      log.source,
    );

    const to = await contactEmail(q, sub.customer_id);
    if (to) {
      await queueRenewal(q, config, {
        merchantId: sub.merchant_id,
        to,
        plan: sub.plan_name ?? "subscription",
        amount: unitsToCents(args.amount),
        nextChargeAt: null,
        failed: true,
      });
    }

    const retry = RENEWAL_RETRY_SECONDS[sub.failed_attempts];
    if (retry === undefined) {
      await cancelSubscription(q, config, sub.id, log.source);
      return;
    }
    const row = await updateSubscription(
      q,
      sub.id,
      "status = 'past_due', failed_attempts = failed_attempts + 1, next_charge_at = now() + make_interval(secs => $2)",
      [retry],
    );
    await emitEvent(q, row.merchant_id, "customer.subscription.updated", serializeSubscription(row, config), log.source);
  },

  async cancelled(q: Queryable, config: Config, log: LogRef, args: { subId: bigint }) {
    const [sub] = await q.query("SELECT id FROM subscriptions WHERE onchain_sub_id = $1", [args.subId.toString()]);
    if (sub) await cancelSubscription(q, config, sub.id, log.source);
  },

  async completed(q: Queryable, config: Config, log: LogRef, args: { subId: bigint }) {
    const [sub] = await q.query("SELECT id FROM subscriptions WHERE onchain_sub_id = $1", [args.subId.toString()]);
    if (sub) await cancelSubscription(q, config, sub.id, log.source);
  },
};

/** Sends a charge for every due subscription. The contract rejects anything not actually due. */
export async function chargeDue(db: Db, writer: ChainWriter, limit = 20) {
  const due = await db.query<{ id: string; onchain_sub_id: string | number }>(
    `UPDATE subscriptions SET next_charge_at = now() + make_interval(secs => $2)
     WHERE id IN (
       SELECT id FROM subscriptions
       WHERE status IN ('active', 'past_due') AND next_charge_at <= now()
       ORDER BY next_charge_at LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     RETURNING id, onchain_sub_id`,
    [limit, KEEPER_LEASE_SECONDS],
  );

  for (const sub of due) {
    try {
      await writer.charge(BigInt(sub.onchain_sub_id));
    } catch (error) {
      // NotDue is normal when the database and chain clocks differ, so the lease just retries it.
      console.error(`charge ${sub.id} failed:`, error instanceof Error ? error.message.split("\n")[0] : error);
    }
  }
  return due.length;
}
