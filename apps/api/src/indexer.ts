import { type Address, type Hex, parseAbi, parseAbiItem, type PublicClient } from "viem";
import { subscriptionsAbi } from "./chain.ts";
import type { Config } from "./config.ts";
import type { Db, Queryable } from "./db.ts";
import { queueRefund } from "./emails.ts";
import { emitEvent, type EventSource } from "./events.ts";
import { newId } from "./ids.ts";
import { serializeRefund } from "./routes/refunds.ts";
import { type IntentRow, serializeIntent, unitsToCents } from "./intents.ts";
import { applySettlement } from "./settlement.ts";
import { subscriptionLogs } from "./subscriptions.ts";

const paidEvent = parseAbiItem(
  "event Paid(bytes32 indexed intentId, address indexed merchant, address indexed payer, uint256 amount, uint256 timestamp)",
);
const refundedEvent = parseAbiItem(
  "event Refunded(bytes32 indexed intentId, address indexed merchant, address indexed payer, uint256 amount, uint8 reasonCode, uint256 totalRefunded)",
);

const subscriptionEvents = parseAbi([
  "event Subscribed(uint256 indexed subId, address indexed merchant, address indexed customer, uint256 amount, uint256 interval, uint256 maxPeriods)",
  "event Charged(uint256 indexed subId, uint256 period, uint256 amount)",
  "event ChargeFailed(uint256 indexed subId, uint256 period, uint256 amount)",
  "event Cancelled(uint256 indexed subId, address indexed by)",
  "event Completed(uint256 indexed subId)",
]);
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

/** Subscription and transfer logs aren't tied to one merchant's setting, so they use the default depth. */
const DEFAULT_CONFIRMATIONS = 2n;

/** Every tick rescans this many blocks. It is also the highest confirmation count a merchant can set. */
const RESCAN_BLOCKS = 20n;
const MAX_RANGE = 2_000n;
const CURSOR = "payments";

const REFUND_REASONS = ["requested_by_customer", "duplicate", "cancelled_item", "other"];

type IntentWithMerchant = IntentRow & { confirmations: number };

const findIntent = async (q: Queryable, onchainId: Hex) =>
  (
    await q.query<IntentWithMerchant>(
      `SELECT i.*, m.confirmations FROM payment_intents i JOIN merchants m ON m.id = i.merchant_id
       WHERE i.onchain_id = $1`,
      [onchainId],
    )
  )[0];

export function createIndexer(db: Db, client: PublicClient, config: Config) {
  async function handlePaid(args: { intentId: Hex; payer: Address; timestamp: bigint }, log: LogPosition, head: bigint) {
    await db.tx(async (q) => {
      const intent = await findIntent(q, args.intentId);
      if (!intent) return;

      const source = sourceOf(config, log);
      if (head - log.blockNumber < BigInt(intent.confirmations)) {
        const moved = await q.query(
          "UPDATE payment_intents SET status = 'processing', processing_at = now() WHERE id = $1 AND status IN ('requires_payment_method', 'canceled') RETURNING id",
          [intent.id],
        );
        if (moved.length > 0) {
          await emitEvent(
            q,
            intent.merchant_id,
            "payment_intent.processing",
            serializeIntent({ ...intent, status: "processing", tx_hash: log.transactionHash, payer: args.payer }, config),
            source,
          );
        }
        return;
      }

      const paidAt = new Date(Number(args.timestamp) * 1000);
      const inserted = await q.query(
        `INSERT INTO payments
           (id, intent_id, invoice_id, tx_hash, log_index, block_number, payer, amount, confirmed_at, gas_paid_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(),
           CASE WHEN EXISTS (SELECT 1 FROM relayed_txs WHERE intent_id = $2) THEN 'relayer' ELSE 'customer' END)
         ON CONFLICT (tx_hash, log_index) DO NOTHING
         RETURNING id`,
        [
          newId("pay"),
          intent.id,
          intent.invoice_id,
          log.transactionHash,
          log.logIndex,
          log.blockNumber.toString(),
          args.payer,
          intent.amount,
        ],
      );
      if (inserted.length === 0) return;

      // The contract is the source of truth: a payment that lands after expiry or cancel still happened.
      const late = paidAt > intent.expires_at;
      await q.query("UPDATE payment_intents SET status = 'succeeded', late_settlement = $2 WHERE id = $1", [
        intent.id,
        late,
      ]);
      const settled = {
        ...intent,
        status: "succeeded",
        late_settlement: late,
        tx_hash: log.transactionHash as string,
        payer: args.payer as string,
      };
      await emitEvent(q, intent.merchant_id, "payment_intent.succeeded", serializeIntent(settled, config), source);
      await applySettlement(q, config, settled, inserted[0].id, source);
    });
  }

  async function emailRefund(q: Queryable, intent: IntentWithMerchant, paymentId: string, amount: number, reason: string, txHash: string) {
    const [contact] = await q.query<{ email: string | null }>(
      "SELECT coalesce($2, c.email) AS email FROM payment_intents i LEFT JOIN customers c ON c.id = i.customer_id WHERE i.id = $1",
      [intent.id, intent.customer_email],
    );
    if (!contact?.email) return;
    await queueRefund(q, config, { merchantId: intent.merchant_id, to: contact.email, amount, reason, txHash, paymentId });
  }

  async function handleRefunded(
    args: { intentId: Hex; amount: bigint; reasonCode: number; totalRefunded: bigint },
    log: LogPosition,
    head: bigint,
  ) {
    await db.tx(async (q) => {
      const intent = await findIntent(q, args.intentId);
      if (!intent || head - log.blockNumber < BigInt(intent.confirmations)) return;

      const [payment] = await q.query<{ id: string }>("SELECT id FROM payments WHERE intent_id = $1", [intent.id]);
      if (!payment) return; // The Paid log is older, so this resolves on a later tick.

      const source = sourceOf(config, log);
      const amountRefunded = unitsToCents(args.totalRefunded);
      const explorerUrl = `${config.explorerUrl}/tx/${log.transactionHash}`;
      const charge = {
        id: payment.id,
        object: "charge",
        amount: Number(intent.amount),
        amount_refunded: amountRefunded,
        currency: intent.currency,
        metadata: intent.metadata,
        payment_intent: intent.id,
        refunded: amountRefunded >= Number(intent.amount),
        settlekit: { chain_id: config.chainId, tx_hash: log.transactionHash, explorer_url: explorerUrl },
      };

      // A refund made through the API already has a row. This log confirms it.
      const [pending] = await q.query(
        "UPDATE refunds SET status = 'succeeded', log_index = $2 WHERE tx_hash = $1 AND status = 'pending' RETURNING *",
        [log.transactionHash, log.logIndex],
      );
      if (pending) {
        const refund = serializeRefund({ ...pending, intent_id: intent.id, currency: intent.currency }, config);
        await emitEvent(q, intent.merchant_id, "refund.updated", refund, source);
        await emitEvent(q, intent.merchant_id, "charge.refunded", charge, source);
        await emailRefund(q, intent, payment.id, Number(pending.amount), pending.reason ?? "other", log.transactionHash);
        return;
      }

      const refundId = newId("re");
      const amount = unitsToCents(args.amount);
      const reason = REFUND_REASONS[args.reasonCode] ?? "other";
      const inserted = await q.query(
        `INSERT INTO refunds (id, payment_id, merchant_id, amount, reason, status, tx_hash, log_index)
         VALUES ($1, $2, $7, $3, $4, 'succeeded', $5, $6)
         ON CONFLICT (tx_hash, log_index) DO NOTHING
         RETURNING id`,
        [refundId, payment.id, amount, reason, log.transactionHash, log.logIndex, intent.merchant_id],
      );
      if (inserted.length === 0) return;

      await emitEvent(
        q,
        intent.merchant_id,
        "refund.created",
        {
          id: refundId,
          object: "refund",
          amount,
          currency: intent.currency,
          payment_intent: intent.id,
          reason,
          status: "succeeded",
          settlekit: { chain_id: config.chainId, tx_hash: log.transactionHash, explorer_url: explorerUrl },
        },
        source,
      );
      await emitEvent(q, intent.merchant_id, "charge.refunded", charge, source);
      await emailRefund(q, intent, payment.id, amount, reason, log.transactionHash);
    });
  }

  const nextChargeAt = async (subId: bigint) => {
    const [, , , , , , next] = await client.readContract({
      address: config.subscriptionsAddress,
      abi: subscriptionsAbi,
      functionName: "subscriptions",
      args: [subId],
    });
    return new Date(Number(next) * 1000);
  };

  async function handleSubscriptionLog(log: any, head: bigint) {
    if (head - log.blockNumber < DEFAULT_CONFIRMATIONS) return;
    const ref = { source: sourceOf(config, log), blockNumber: log.blockNumber as bigint };
    // Read before opening the transaction, because a transaction shouldn't wait on the network.
    const next = log.eventName === "Subscribed" || log.eventName === "Charged" ? await nextChargeAt(log.args.subId) : null;

    await db.tx(async (q) => {
      if (log.eventName === "Subscribed") await subscriptionLogs.subscribed(q, config, ref, log.args, next!);
      if (log.eventName === "Charged") await subscriptionLogs.charged(q, config, ref, log.args, next!);
      if (log.eventName === "ChargeFailed") await subscriptionLogs.chargeFailed(q, config, ref, log.args);
      if (log.eventName === "Cancelled") await subscriptionLogs.cancelled(q, config, ref, log.args);
      if (log.eventName === "Completed") await subscriptionLogs.completed(q, config, ref, log.args);
    });
  }

  async function recordIncomingTransfers(fromBlock: bigint, toBlock: bigint, head: bigint) {
    const merchants = await db.query<{ id: string; payout_wallet: Address }>("SELECT id, payout_wallet FROM merchants");
    if (merchants.length === 0) return;
    const byWallet = new Map(merchants.map((m) => [m.payout_wallet.toLowerCase(), m.id]));

    const logs = await client.getLogs({
      address: config.usdtAddress,
      event: transferEvent,
      args: { to: merchants.map((m) => m.payout_wallet) },
      fromBlock,
      toBlock,
    });
    for (const log of logs) {
      if (head - log.blockNumber < DEFAULT_CONFIRMATIONS) continue;
      const merchantId = byWallet.get(log.args.to!.toLowerCase());
      if (!merchantId) continue;
      await db.query(
        `INSERT INTO incoming_transfers (id, merchant_id, tx_hash, log_index, block_number, from_address, amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tx_hash, log_index) DO NOTHING`,
        [
          newId("xfer"),
          merchantId,
          log.transactionHash,
          log.logIndex,
          log.blockNumber.toString(),
          log.args.from,
          unitsToCents(log.args.value!),
        ],
      );
    }
  }

  async function readCursor() {
    const [row] = await db.query<{ next_block: string | number }>(
      "SELECT next_block FROM indexer_state WHERE name = $1",
      [CURSOR],
    );
    return row ? BigInt(row.next_block) : config.startBlock;
  }

  /** Scans from the cursor to the head. The rescan is safe because every write above is idempotent. */
  async function tick() {
    const head = await client.getBlockNumber({ cacheTime: 0 });
    const cursor = await readCursor();
    const toBlock = head < cursor + MAX_RANGE ? head : cursor + MAX_RANGE;
    if (toBlock < cursor) return;

    const [paid, refunded, subscriptions] = await Promise.all([
      client.getLogs({ address: config.paymentsAddress, event: paidEvent, fromBlock: cursor, toBlock }),
      client.getLogs({ address: config.paymentsAddress, event: refundedEvent, fromBlock: cursor, toBlock }),
      client.getLogs({ address: config.subscriptionsAddress, events: subscriptionEvents, fromBlock: cursor, toBlock }),
    ]);

    // Paid goes first so a refund in the same batch can find its payment.
    for (const log of paid) await handlePaid(log.args as any, log as LogPosition, head);
    for (const log of refunded) await handleRefunded(log.args as any, log as LogPosition, head);
    for (const log of subscriptions) await handleSubscriptionLog(log, head);
    await recordIncomingTransfers(cursor, toBlock, head);

    const floor = toBlock > RESCAN_BLOCKS ? toBlock - RESCAN_BLOCKS : 0n;
    const next = floor > cursor ? floor : cursor;
    await db.query(
      `INSERT INTO indexer_state (name, next_block) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET next_block = EXCLUDED.next_block`,
      [CURSOR, next.toString()],
    );
  }

  return { tick };
}

type LogPosition = { blockNumber: bigint; transactionHash: Hex; logIndex: number };

function sourceOf(config: Pick<Config, "chainId">, log: LogPosition): EventSource {
  return { chainId: config.chainId, txHash: log.transactionHash, logIndex: log.logIndex };
}
