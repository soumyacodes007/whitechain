import { type Address, type Hex, parseAbiItem, type PublicClient } from "viem";
import type { Config } from "./config.ts";
import type { Db, Queryable } from "./db.ts";
import { emitEvent, type EventSource } from "./events.ts";
import { newId } from "./ids.ts";
import { type IntentRow, serializeIntent, unitsToCents } from "./intents.ts";

const paidEvent = parseAbiItem(
  "event Paid(bytes32 indexed intentId, address indexed merchant, address indexed payer, uint256 amount, uint256 timestamp)",
);
const refundedEvent = parseAbiItem(
  "event Refunded(bytes32 indexed intentId, address indexed merchant, address indexed payer, uint256 amount, uint8 reasonCode, uint256 totalRefunded)",
);

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
          "UPDATE payment_intents SET status = 'processing' WHERE id = $1 AND status = 'requires_payment_method' RETURNING id",
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
        `INSERT INTO payments (id, intent_id, tx_hash, log_index, block_number, payer, amount, confirmed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (tx_hash, log_index) DO NOTHING
         RETURNING id`,
        [newId("pay"), intent.id, log.transactionHash, log.logIndex, log.blockNumber.toString(), args.payer, intent.amount],
      );
      if (inserted.length === 0) return;

      // The contract is the source of truth: a payment that lands after expiry or cancel still happened.
      const late = paidAt > intent.expires_at;
      await q.query("UPDATE payment_intents SET status = 'succeeded', late_settlement = $2 WHERE id = $1", [
        intent.id,
        late,
      ]);
      await emitEvent(
        q,
        intent.merchant_id,
        "payment_intent.succeeded",
        serializeIntent(
          { ...intent, status: "succeeded", late_settlement: late, tx_hash: log.transactionHash, payer: args.payer },
          config,
        ),
        source,
      );
    });
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

      const refundId = newId("re");
      const amount = unitsToCents(args.amount);
      const reason = REFUND_REASONS[args.reasonCode] ?? "other";
      const inserted = await q.query(
        `INSERT INTO refunds (id, payment_id, amount, reason, status, tx_hash, log_index)
         VALUES ($1, $2, $3, $4, 'succeeded', $5, $6)
         ON CONFLICT (tx_hash, log_index) DO NOTHING
         RETURNING id`,
        [refundId, payment.id, amount, reason, log.transactionHash, log.logIndex],
      );
      if (inserted.length === 0) return;

      const source = sourceOf(config, log);
      const amountRefunded = unitsToCents(args.totalRefunded);
      const explorerUrl = `${config.explorerUrl}/tx/${log.transactionHash}`;
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
      await emitEvent(
        q,
        intent.merchant_id,
        "charge.refunded",
        {
          id: payment.id,
          object: "charge",
          amount: Number(intent.amount),
          amount_refunded: amountRefunded,
          currency: intent.currency,
          metadata: intent.metadata,
          payment_intent: intent.id,
          refunded: amountRefunded >= Number(intent.amount),
          settlekit: { chain_id: config.chainId, tx_hash: log.transactionHash, explorer_url: explorerUrl },
        },
        source,
      );
    });
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

    const [paid, refunded] = await Promise.all([
      client.getLogs({ address: config.paymentsAddress, event: paidEvent, fromBlock: cursor, toBlock }),
      client.getLogs({ address: config.paymentsAddress, event: refundedEvent, fromBlock: cursor, toBlock }),
    ]);

    // Paid goes first so a refund in the same batch can find its payment.
    for (const log of paid) await handlePaid(log.args as any, log as LogPosition, head);
    for (const log of refunded) await handleRefunded(log.args as any, log as LogPosition, head);

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
