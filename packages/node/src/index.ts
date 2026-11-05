import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TOLERANCE_SECONDS = 300;

type RequestOptions = { idempotencyKey?: string };
type Params = Record<string, unknown>;

export type SettleKitEvent = {
  id: string;
  object: "event";
  type: string;
  created: number;
  data: { object: any };
};

export class SettleKitError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly type?: string,
    readonly param?: string | null,
  ) {
    super(message);
  }
}

export class WebhookSignatureError extends Error {}

function constructEvent(
  payload: string | Buffer,
  header: string | string[] | undefined,
  secret: string,
  tolerance = DEFAULT_TOLERANCE_SECONDS,
): SettleKitEvent {
  const body = typeof payload === "string" ? payload : payload.toString("utf8");
  const parts = new Map(
    String(header ?? "")
      .split(",")
      .map((part) => part.split("=", 2) as [string, string]),
  );
  const timestamp = Number(parts.get("t"));
  const signature = parts.get("v1");
  if (!timestamp || !signature) throw new WebhookSignatureError("Malformed signature header");

  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();
  const given = Buffer.from(signature, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new WebhookSignatureError("Signature does not match the payload");
  }
  if (Math.abs(Date.now() / 1000 - timestamp) > tolerance) {
    throw new WebhookSignatureError("Timestamp is outside the tolerance");
  }
  return JSON.parse(body);
}

export class SettleKit {
  private readonly baseUrl: string;

  constructor(
    private readonly secretKey: string,
    options: { baseUrl?: string } = {},
  ) {
    this.baseUrl = (options.baseUrl ?? process.env.SETTLEKIT_API_URL ?? "https://api.settlekit.dev").replace(/\/$/, "");
  }

  private async request(method: string, path: string, body?: Params, options: RequestOptions = {}) {
    const response = await fetch(`${this.baseUrl}/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        ...(body ? { "content-type": "application/json" } : {}),
        ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json: any = await response.json();
    if (!response.ok) {
      const error = json.error ?? {};
      throw new SettleKitError(error.message ?? "Request failed", response.status, error.code, error.type, error.param);
    }
    return json;
  }

  paymentIntents = {
    create: (params: Params, options?: RequestOptions) => this.request("POST", "/payment_intents", params, options),
    retrieve: (id: string) => this.request("GET", `/payment_intents/${id}`),
    cancel: (id: string, options?: RequestOptions) =>
      this.request("POST", `/payment_intents/${id}/cancel`, {}, options),
  };

  checkout = {
    sessions: {
      create: (params: Params, options?: RequestOptions) =>
        this.request("POST", "/checkout/sessions", params, options),
      retrieve: (id: string) => this.request("GET", `/checkout/sessions/${id}`),
    },
  };

  paymentLinks = {
    create: (params: Params) => this.request("POST", "/payment_links", params),
    list: () => this.request("GET", "/payment_links"),
    deactivate: (id: string) => this.request("POST", `/payment_links/${id}/deactivate`, {}),
  };

  invoices = {
    create: (params: Params, options?: RequestOptions) => this.request("POST", "/invoices", params, options),
    retrieve: (id: string) => this.request("GET", `/invoices/${id}`),
    list: () => this.request("GET", "/invoices"),
    send: (id: string) => this.request("POST", `/invoices/${id}/send`, {}),
    void: (id: string) => this.request("POST", `/invoices/${id}/void`, {}),
  };

  refunds = {
    create: (params: Params, options?: RequestOptions) => this.request("POST", "/refunds", params, options),
    retrieve: (id: string) => this.request("GET", `/refunds/${id}`),
    list: () => this.request("GET", "/refunds"),
  };

  subscriptions = {
    retrieve: (id: string) => this.request("GET", `/subscriptions/${id}`),
    list: () => this.request("GET", "/subscriptions"),
    cancel: (id: string) => this.request("POST", `/subscriptions/${id}/cancel`, {}),
  };

  events = {
    retrieve: (id: string) => this.request("GET", `/events/${id}`),
    list: () => this.request("GET", "/events"),
  };

  webhooks = { constructEvent };
}
