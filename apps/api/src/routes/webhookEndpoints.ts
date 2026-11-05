import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.ts";
import { newId, newSecret } from "../ids.ts";

const createBody = z.object({
  url: z.url({ protocol: /^https?$/ }),
  enabled_events: z.array(z.string()).min(1).default(["*"]),
});

export async function webhookEndpointRoutes(app: FastifyInstance, { db }: Deps) {
  app.post("/webhook_endpoints", async (request) => {
    const input = createBody.parse(request.body ?? {});
    const id = newId("we");
    const secret = newSecret("whsec");
    await db.query(
      "INSERT INTO webhook_endpoints (id, merchant_id, url, secret, events) VALUES ($1, $2, $3, $4, $5::jsonb)",
      [id, request.merchant.id, input.url, secret, JSON.stringify(input.enabled_events)],
    );
    return { id, object: "webhook_endpoint", url: input.url, enabled_events: input.enabled_events, secret };
  });
}
