import { describe, expect, it } from "vitest";
import { expireSessions, markInvoicesOverdue } from "../src/sweeps.ts";
import { dispatchDue } from "../src/webhooks.ts";
import { useChain } from "./harness.ts";

const chain = useChain();

const confirm = async () => {
  await chain.mine();
  await chain.indexer().tick();
  await chain.indexer().tick();
};

describe("checkout sessions", () => {
  const createSession = async (amount = 50000) =>
    (
      await chain.api("POST", "/v1/checkout/sessions", {
        mode: "payment",
        line_items: [
          { quantity: 2, price_data: { currency: "usd", unit_amount: amount / 2, product_data: { name: "Brand Kit" } } },
        ],
        success_url: "https://pixelforge.test/thanks",
        metadata: { orderId: "PF-S1" },
        client_reference_id: "cart_9",
      })
    ).json();

  const publicSession = async (id: string) => (await chain.app().inject({ url: `/public/checkout/${id}` })).json();

  it("returns a hosted url and completes after payment", async () => {
    const session = await createSession();
    expect(session).toMatchObject({ object: "checkout.session", status: "open", amount_total: 50000 });
    expect(session.url).toBe(`http://checkout.test/c/${session.id}`);

    const { intent } = await publicSession(session.id);
    await chain.pay(intent.client_secret);
    await confirm();
    await dispatchDue(chain.db());

    const final = (await chain.api("GET", `/v1/checkout/sessions/${session.id}`)).json();
    expect(final).toMatchObject({ status: "complete", payment_status: "paid", client_reference_id: "cart_9" });

    const event = chain.receiver.received.find(
      (e) => e.type === "checkout.session.completed" && e.data.object.id === session.id,
    );
    expect(event.data.object.metadata.orderId).toBe("PF-S1");
    expect((await publicSession(session.id)).intent.payment_id).toMatch(/^pay_/);
  });

  it("expires an unpaid session once and fires the event", async () => {
    const session = await createSession(1000);
    await chain.db().query("UPDATE payment_intents SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      session.payment_intent,
    ]);
    await expireSessions(chain.db(), chain.config());
    await expireSessions(chain.db(), chain.config());
    await dispatchDue(chain.db());

    expect((await chain.api("GET", `/v1/checkout/sessions/${session.id}`)).json().status).toBe("expired");
    const events = chain.receiver.received.filter(
      (e) => e.type === "checkout.session.expired" && e.data.object.id === session.id,
    );
    expect(events).toHaveLength(1);
  });

  it("still records a payment that lands after the session expired", async () => {
    const session = await createSession(1200);
    const { intent } = await publicSession(session.id);
    await chain.db().query("UPDATE payment_intents SET expires_at = now() - interval '1 minute' WHERE id = $1", [
      session.payment_intent,
    ]);
    await expireSessions(chain.db(), chain.config());

    await chain.pay(intent.client_secret);
    await confirm();

    const final = (await chain.api("GET", `/v1/payment_intents/${session.payment_intent}`)).json();
    expect(final.status).toBe("succeeded");
    expect(final.settlekit.late_settlement).toBe(true);
  });
});

describe("receipts", () => {
  it("shows the payment, its refund and the net paid", async () => {
    const intent = (
      await chain.api("POST", "/v1/payment_intents", { amount: 50000, currency: "usd", metadata: { orderId: "PF-RCPT" } })
    ).json();
    await chain.pay(intent.client_secret);
    await confirm();

    const { payment_id, pay } = (
      await chain.app().inject({ url: `/public/payment_intents/${intent.client_secret}` })
    ).json();
    await chain.refund(pay.intent_id, 100_000000n, 2);
    await confirm();

    const receipt = (await chain.app().inject({ url: `/public/receipts/${payment_id}` })).json();
    expect(receipt).toMatchObject({
      status: "partially_refunded",
      amount: 50000,
      refunded: 10000,
      net: 40000,
      reference: "PF-RCPT",
    });
    expect(receipt.confirmations).toBeGreaterThanOrEqual(3);
    expect(receipt.refunds[0]).toMatchObject({ amount: 10000, reason: "cancelled_item" });
  });
});

describe("payment links", () => {
  const createLink = async (extra = {}) =>
    (await chain.api("POST", "/v1/payment_links", { name: "Logo Pack", unit_amount: 4900, ...extra })).json();
  const checkout = (code: string, payload = {}) =>
    chain.app().inject({ method: "POST", url: `/public/links/${code}/checkout`, payload });

  it("creates a new session per checkout, priced from the database", async () => {
    const link = await createLink();
    const first = (await checkout(link.code)).json();
    const second = (await checkout(link.code, { amount: 1, unit_amount: 1 })).json();
    expect(first.session_id).not.toBe(second.session_id);

    const { intent } = (await chain.app().inject({ url: `/public/checkout/${second.session_id}` })).json();
    expect(intent.amount).toBe(4900);

    await chain.pay(intent.client_secret);
    await confirm();

    const rows = (await chain.api("GET", "/v1/payment_links")).json().data;
    expect(rows.find((row: any) => row.id === link.id).times_paid).toBe(1);
  });

  it("multiplies quantity only when the merchant allows it", async () => {
    const fixed = await createLink();
    expect((await checkout(fixed.code, { quantity: 2 })).statusCode).toBe(400);

    const flexible = await createLink({ adjustable_quantity: true });
    const { session_id } = (await checkout(flexible.code, { quantity: 3 })).json();
    const { intent } = (await chain.app().inject({ url: `/public/checkout/${session_id}` })).json();
    expect(intent.amount).toBe(14700);
  });

  it("stops selling once deactivated or expired", async () => {
    const link = await createLink();
    await chain.api("POST", `/v1/payment_links/${link.id}/deactivate`, {});
    expect((await checkout(link.code)).json().error.code).toBe("payment_link_inactive");

    const expired = await createLink({ expires_at: Math.floor(Date.now() / 1000) - 60 });
    expect((await checkout(expired.code)).statusCode).toBe(400);
  });
});

describe("invoices", () => {
  const body = {
    customer: { name: "Mark", email: "mark@example.com" },
    line_items: [
      { description: "Design", quantity: 1, unit_amount: 50000 },
      { description: "Hours", quantity: 3, unit_amount: 10000 },
    ],
    allow_partial: true,
  };
  const createInvoice = async (extra = {}) => (await chain.api("POST", "/v1/invoices", { ...body, ...extra })).json();
  const sendInvoice = async (id: string) => (await chain.api("POST", `/v1/invoices/${id}/send`, {})).json();
  const publicInvoice = (id: string) => chain.app().inject({ url: `/public/invoices/${id}` });
  const startPayment = (id: string, payload = {}) =>
    chain.app().inject({ method: "POST", url: `/public/invoices/${id}/pay`, payload });

  const payPart = async (id: string, amount?: number) => {
    const { client_secret } = (await startPayment(id, amount ? { amount } : {})).json();
    const hash = await chain.pay(client_secret);
    await confirm();
    return hash;
  };

  it("numbers invoices in sequence and totals line items", async () => {
    const first = await createInvoice();
    const second = await createInvoice();
    expect(first.number).toMatch(/^INV-\d{4}-\d{4}$/);
    expect(Number(second.number.slice(-4))).toBe(Number(first.number.slice(-4)) + 1);
    expect(first).toMatchObject({ status: "draft", total: 80000, amount_remaining: 80000 });
  });

  it("hides drafts from the public until they are sent", async () => {
    const invoice = await createInvoice();
    expect((await publicInvoice(invoice.id)).statusCode).toBe(404);
    await sendInvoice(invoice.id);
    expect((await publicInvoice(invoice.id)).json()).toMatchObject({ status: "open", amount_remaining: 80000 });
  });

  it("becomes paid across two payments and shows both transactions", async () => {
    const invoice = await createInvoice();
    await sendInvoice(invoice.id);

    const firstTx = await payPart(invoice.id, 30000);
    const partial = (await publicInvoice(invoice.id)).json();
    expect(partial).toMatchObject({ status: "partially_paid", amount_paid: 30000, amount_remaining: 50000 });

    const secondTx = await payPart(invoice.id);
    const paid = (await publicInvoice(invoice.id)).json();
    expect(paid).toMatchObject({ status: "paid", amount_paid: 80000, amount_remaining: 0 });
    expect(paid.payments.map((payment: any) => payment.tx_hash)).toEqual([firstTx, secondTx]);

    await dispatchDue(chain.db());
    const types = chain.receiver.received.filter((e) => e.data.object.id === invoice.id).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(["invoice.created", "invoice.sent", "invoice.payment_partially_paid", "invoice.paid"]),
    );
  });

  it("refuses overpayment, part payment when disallowed, and paying a settled invoice", async () => {
    const invoice = await createInvoice();
    await sendInvoice(invoice.id);
    expect((await startPayment(invoice.id, { amount: 80001 })).json().error.code).toBe("amount_too_large");

    const full = await createInvoice({ allow_partial: false });
    await sendInvoice(full.id);
    expect((await startPayment(full.id, { amount: 100 })).json().error.code).toBe("partial_not_allowed");

    await payPart(full.id);
    expect((await startPayment(full.id)).json().error.code).toBe("invoice_not_payable");
  });

  it("goes overdue once, adds the late fee, and stays overdue on a part payment", async () => {
    const invoice = await createInvoice({
      due_date: Math.floor(Date.now() / 1000) + 3600,
      late_fee: { type: "percent", value: 5 },
    });
    await sendInvoice(invoice.id);
    await chain.db().query("UPDATE invoices SET due_date = now() - interval '1 day' WHERE id = $1", [invoice.id]);

    await markInvoicesOverdue(chain.db(), chain.config());
    expect((await publicInvoice(invoice.id)).json()).toMatchObject({
      status: "overdue",
      late_fee_amount: 4000,
      total: 84000,
    });

    await payPart(invoice.id, 1000);
    await markInvoicesOverdue(chain.db(), chain.config());
    await dispatchDue(chain.db());
    expect((await publicInvoice(invoice.id)).json().status).toBe("overdue");
    expect(
      chain.receiver.received.filter((e) => e.type === "invoice.overdue" && e.data.object.id === invoice.id),
    ).toHaveLength(1);

    await payPart(invoice.id);
    expect((await publicInvoice(invoice.id)).json()).toMatchObject({ status: "paid", amount_paid: 84000 });
  });

  it("voids only unpaid invoices", async () => {
    const unpaid = await createInvoice();
    await sendInvoice(unpaid.id);
    expect((await chain.api("POST", `/v1/invoices/${unpaid.id}/void`, {})).json().status).toBe("void");
    expect((await startPayment(unpaid.id)).statusCode).toBe(400);

    const part = await createInvoice();
    await sendInvoice(part.id);
    await payPart(part.id, 100);
    expect((await chain.api("POST", `/v1/invoices/${part.id}/void`, {})).statusCode).toBe(400);
  });

  it("serves a PDF once sent", async () => {
    const invoice = await createInvoice({ allow_partial: false });
    await sendInvoice(invoice.id);
    await payPart(invoice.id);

    const res = await chain.app().inject({ url: `/public/invoices/${invoice.id}/pdf` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
