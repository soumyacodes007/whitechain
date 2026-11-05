import type { Queryable } from "./db.ts";
import { newId } from "./ids.ts";

export type EventSource = { chainId: number; txHash: string; logIndex: number };

/** Records an event and queues it for each subscribed endpoint. Returns false if the event already exists. */
export async function emitEvent(
  q: Queryable,
  merchantId: string,
  type: string,
  object: unknown,
  source?: EventSource,
): Promise<boolean> {
  const id = source ? `evt_${source.chainId}_${source.txHash}_${source.logIndex}_${type}` : newId("evt");
  const payload = { id, object: "event", type, created: Math.floor(Date.now() / 1000), livemode: false, data: { object } };

  const inserted = await q.query(
    `INSERT INTO events (id, merchant_id, type, payload, source_tx, source_log_index)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [id, merchantId, type, JSON.stringify(payload), source?.txHash ?? null, source?.logIndex ?? null],
  );
  if (inserted.length === 0) return false;

  const endpoints = await q.query<{ id: string; events: string[] }>(
    "SELECT id, events FROM webhook_endpoints WHERE merchant_id = $1 AND active",
    [merchantId],
  );
  for (const endpoint of endpoints) {
    if (!endpoint.events.includes("*") && !endpoint.events.includes(type)) continue;
    await q.query("INSERT INTO webhook_deliveries (id, event_id, endpoint_id) VALUES ($1, $2, $3)", [
      newId("whd"),
      id,
      endpoint.id,
    ]);
  }
  return true;
}
