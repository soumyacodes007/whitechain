import Fastify, { type FastifyReply } from "fastify";
import qs from "qs";
import type { PublicClient } from "viem";
import { z } from "zod";
import type { ChainWriter } from "./chain.ts";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { ApiError, invalidRequest } from "./errors.ts";
import { type Merchant, merchantForSecretKey } from "./merchants.ts";
import { checkoutSessionRoutes } from "./routes/checkoutSessions.ts";
import { dashboardRoutes } from "./routes/dashboard.ts";
import { eventRoutes } from "./routes/events.ts";
import { invoiceRoutes } from "./routes/invoices.ts";
import { paymentLinkRoutes } from "./routes/paymentLinks.ts";
import { paymentIntentRoutes } from "./routes/paymentIntents.ts";
import { publicRoutes } from "./routes/public.ts";
import { refundRoutes } from "./routes/refunds.ts";
import { reportRoutes } from "./routes/reports.ts";
import { stripeCompatRoutes } from "./routes/stripeCompat.ts";
import { subscriptionRoutes } from "./routes/subscriptions.ts";
import { webhookEndpointRoutes } from "./routes/webhookEndpoints.ts";

declare module "fastify" {
  interface FastifyRequest {
    merchant: Merchant;
  }
}

export type Deps = { db: Db; config: Config; client?: PublicClient; writer?: ChainWriter };

export function send(reply: FastifyReply, result: { status: number; body: unknown; replayed?: boolean }) {
  if (result.replayed) reply.header("idempotent-replayed", "true");
  return reply.code(result.status).send(result.body);
}

export function buildApp(deps: Deps) {
  const app = Fastify({ logger: false });

  // The Stripe SDK sends form-encoded bodies with bracketed keys, such as metadata[orderId]=1.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    done(null, qs.parse(body as string, { arrayLimit: 100 }));
  });

  app.decorateRequest("merchant", undefined as unknown as Merchant);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) return reply.code(error.statusCode).send(error.toBody());
    if (error instanceof z.ZodError) {
      const issue = error.issues[0]!;
      const param = issue.path.join(".");
      return reply.code(400).send(invalidRequest("parameter_invalid", issue.message, param).toBody());
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.code(status).send(invalidRequest("invalid_request", (error as Error).message).toBody());
    }
    console.error(error);
    return reply
      .code(500)
      .send(new ApiError(500, "api_error", "internal_error", "Something went wrong on our side").toBody());
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send(invalidRequest("resource_missing", `Unrecognized request URL: ${request.url}`).toBody()),
  );

  app.register(async (v1) => {
    v1.addHook("onRequest", async (request) => {
      const [scheme, key] = (request.headers.authorization ?? "").split(" ");
      const merchant = scheme === "Bearer" && key ? await merchantForSecretKey(deps.db, key) : undefined;
      if (!merchant) throw new ApiError(401, "invalid_request_error", "api_key_invalid", "Invalid API key");
      request.merchant = merchant;
    });

    v1.register(paymentIntentRoutes, deps);
    v1.register(checkoutSessionRoutes, deps);
    v1.register(paymentLinkRoutes, deps);
    v1.register(invoiceRoutes, deps);
    v1.register(refundRoutes, deps);
    v1.register(subscriptionRoutes, deps);
    v1.register(dashboardRoutes, deps);
    v1.register(reportRoutes, deps);
    v1.register(stripeCompatRoutes, deps);
    v1.register(eventRoutes, deps);
    v1.register(webhookEndpointRoutes, deps);
  }, { prefix: "/v1" });

  app.register(publicRoutes, { ...deps, prefix: "/public" });
  app.get("/health", async () => ({ ok: true }));

  return app;
}
