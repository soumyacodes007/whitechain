import { createHmac } from "node:crypto";
import type { Db } from "./db.ts";
import { newId } from "./ids.ts";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
/** Delay before each retry. A delivery gets one first try plus one retry per entry, then it fails. */
export const RETRY_DELAYS_SECONDS = [MINUTE, 5 * MINUTE, 30 * MINUTE, 2 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR];

/** How long a claimed delivery stays hidden. If the process dies mid-send, it is retried after this. */
const LEASE_SECONDS = 60;
const REQUEST_TIMEOUT_MS = 10_000;

export function signatureHeader(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

type Claimed = { id: string; attempt: number; url: string; secret: string; payload: unknown };

async function claimDue(db: Db, limit: number) {
  return db.tx((q) =>
    q.query<Claimed>(
      `WITH due AS (
         SELECT id FROM webhook_deliveries
         WHERE status = 'pending' AND next_retry_at <= now()
         ORDER BY next_retry_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       ), claimed AS (
         UPDATE webhook_deliveries d
         SET attempt = d.attempt + 1, next_retry_at = now() + make_interval(secs => $2)
         FROM due WHERE d.id = due.id
         RETURNING d.id, d.attempt, d.event_id, d.endpoint_id
       )
       SELECT c.id, c.attempt, e.url, e.secret, ev.payload
       FROM claimed c
       JOIN webhook_endpoints e ON e.id = c.endpoint_id
       JOIN events ev ON ev.id = c.event_id`,
      [limit, LEASE_SECONDS],
    ),
  );
}

const MAX_LOGGED_BODY = 2_000;

async function send(delivery: Claimed) {
  const body = JSON.stringify(delivery.payload);
  const signature = signatureHeader(body, delivery.secret);
  const started = Date.now();
  try {
    const response = await fetch(delivery.url, {
      method: "POST",
      headers: { "content-type": "application/json", "settlekit-signature": signature, "stripe-signature": signature },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = (await response.text().catch(() => "")).slice(0, MAX_LOGGED_BODY);
    return { statusCode: response.status, text, duration: Date.now() - started };
  } catch (error) {
    return {
      statusCode: null,
      text: error instanceof Error ? error.message : "Request failed",
      duration: Date.now() - started,
    };
  }
}

/** Sends everything that is due. Delivery is at-least-once, so receivers dedupe on the event id. */
export async function dispatchDue(db: Db, limit = 20) {
  const due = await claimDue(db, limit);

  await Promise.all(
    due.map(async (delivery) => {
      const { statusCode, text, duration } = await send(delivery);
      await db.query(
        `INSERT INTO webhook_attempts (id, delivery_id, attempt, status_code, duration_ms, response_body)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [newId("wha"), delivery.id, delivery.attempt, statusCode, duration, text],
      );

      if (statusCode !== null && statusCode >= 200 && statusCode < 300) {
        await db.query(
          "UPDATE webhook_deliveries SET status = 'succeeded', status_code = $2, delivered_at = now() WHERE id = $1",
          [delivery.id, statusCode],
        );
        return;
      }

      const delay = RETRY_DELAYS_SECONDS[delivery.attempt - 1];
      if (delay === undefined) {
        await db.query("UPDATE webhook_deliveries SET status = 'failed', status_code = $2 WHERE id = $1", [
          delivery.id,
          statusCode,
        ]);
        return;
      }
      await db.query(
        "UPDATE webhook_deliveries SET status_code = $2, next_retry_at = now() + make_interval(secs => $3) WHERE id = $1",
        [delivery.id, statusCode, delay],
      );
    }),
  );
  return due.length;
}
