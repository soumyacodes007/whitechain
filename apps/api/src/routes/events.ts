import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.ts";
import { notFound } from "../errors.ts";

const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(10) });

export async function eventRoutes(app: FastifyInstance, { db }: Deps) {
  app.get("/events", async (request) => {
    const { limit } = listQuery.parse(request.query);
    const rows = await db.query<{ payload: unknown }>(
      "SELECT payload FROM events WHERE merchant_id = $1 ORDER BY created_at DESC, id LIMIT $2",
      [request.merchant.id, limit + 1],
    );
    return {
      object: "list",
      url: "/v1/events",
      has_more: rows.length > limit,
      data: rows.slice(0, limit).map((row) => row.payload),
    };
  });

  app.get<{ Params: { id: string } }>("/events/:id", async (request) => {
    const [row] = await db.query<{ payload: unknown }>("SELECT payload FROM events WHERE id = $1 AND merchant_id = $2", [
      request.params.id,
      request.merchant.id,
    ]);
    if (!row) throw notFound("event", request.params.id);
    return row.payload;
  });
}
