import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SettleKit, WebhookSignatureError } from "../src/index.ts";

const kit = new SettleKit("sk_test_x", { baseUrl: "http://unused.test" });
const secret = "whsec_test";
const payload = JSON.stringify({ id: "evt_1", object: "event", type: "payment_intent.succeeded", data: { object: {} } });

const header = (body: string, timestamp = Math.floor(Date.now() / 1000), key = secret) =>
  `t=${timestamp},v1=${createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex")}`;

describe("constructEvent", () => {
  it("returns the event for a valid signature, from a string or raw Buffer", () => {
    expect(kit.webhooks.constructEvent(payload, header(payload), secret).id).toBe("evt_1");
    expect(kit.webhooks.constructEvent(Buffer.from(payload), header(payload), secret).id).toBe("evt_1");
  });

  it.each([
    ["a changed payload", () => kit.webhooks.constructEvent(`${payload} `, header(payload), secret)],
    ["the wrong secret", () => kit.webhooks.constructEvent(payload, header(payload, undefined, "other"), secret)],
    ["a missing header", () => kit.webhooks.constructEvent(payload, undefined, secret)],
    ["a garbage header", () => kit.webhooks.constructEvent(payload, "t=abc,v1=zz", secret)],
    ["a short signature", () => kit.webhooks.constructEvent(payload, "t=1700000000,v1=ab", secret)],
  ])("rejects %s", (_name, run) => {
    expect(run).toThrow(WebhookSignatureError);
  });

  it("rejects a replay older than the five minute tolerance", () => {
    const old = Math.floor(Date.now() / 1000) - 301;
    expect(() => kit.webhooks.constructEvent(payload, header(payload, old), secret)).toThrow(/tolerance/);
  });
});
