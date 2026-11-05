import type { FastifyRequest } from "fastify";
import type { Db } from "./db.ts";
import { ApiError, invalidRequest } from "./errors.ts";
import { sha256 } from "./ids.ts";

type Result = { status: number; body: unknown; replayed?: boolean };

/** Runs a mutating handler at most once per Idempotency-Key. Replays within 24 h get the first response. */
export async function idempotent(
  db: Db,
  request: FastifyRequest,
  merchantId: string,
  handler: () => Promise<Omit<Result, "replayed">>,
): Promise<Result> {
  const key = request.headers["idempotency-key"];
  if (typeof key !== "string" || key === "") return handler();

  const requestHash = sha256(`${request.method} ${request.url} ${JSON.stringify(request.body)}`);
  await db.query(
    "DELETE FROM idempotency_keys WHERE merchant_id = $1 AND key = $2 AND created_at < now() - interval '24 hours'",
    [merchantId, key],
  );

  // Claiming the key first means two concurrent requests can't both run the handler.
  const claimed = await db.query(
    `INSERT INTO idempotency_keys (key, merchant_id, request_hash) VALUES ($1, $2, $3)
     ON CONFLICT (merchant_id, key) DO NOTHING
     RETURNING key`,
    [key, merchantId, requestHash],
  );

  if (claimed.length === 0) {
    const [existing] = await db.query(
      "SELECT request_hash, response, status_code FROM idempotency_keys WHERE merchant_id = $1 AND key = $2",
      [merchantId, key],
    );
    if (existing.request_hash !== requestHash) {
      throw invalidRequest("idempotency_key_reused", "This Idempotency-Key was used with different parameters");
    }
    if (existing.response === null) {
      throw new ApiError(409, "idempotency_error", "idempotency_key_in_use", "The first request is still running");
    }
    return { status: existing.status_code, body: existing.response, replayed: true };
  }

  try {
    const result = await handler();
    await db.query(
      "UPDATE idempotency_keys SET response = $3::jsonb, status_code = $4 WHERE merchant_id = $1 AND key = $2",
      [merchantId, key, JSON.stringify(result.body), result.status],
    );
    return result;
  } catch (error) {
    await db.query("DELETE FROM idempotency_keys WHERE merchant_id = $1 AND key = $2", [merchantId, key]);
    throw error;
  }
}
