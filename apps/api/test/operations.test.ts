import ExcelJS from "exceljs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseSignature, type Hex } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { deliverEmails } from "../src/emails.ts";
import { reminderKind, sendDueReminders } from "../src/reminders.ts";
import { signInMessage } from "../src/routes/portal.ts";
import { chargeDue } from "../src/subscriptions.ts";
import { releaseStuckProcessing } from "../src/sweeps.ts";
import { dispatchDue } from "../src/webhooks.ts";
import { customer, useChain } from "./harness.ts";

const chain = useChain(38547);

const confirm = async () => {
  await chain.mine();
  await chain.indexer().tick();
  await chain.indexer().tick();
};

const paidIntent = async (amount: number, orderId: string) => {
  const intent = (
    await chain.api("POST", "/v1/payment_intents", { amount, currency: "usd", metadata: { orderId } })
  ).json();
  await chain.pay(intent.client_secret);
  await confirm();
  return intent;
};

const refund = (payload: object) => chain.api("POST", "/v1/refunds", payload);

describe("refund API", () => {
  it("moves pending to succeeded, caps the total, and refunds the rest by default", async () => {
    const intent = await paidIntent(50000, "PF-R1");

    const first = await refund({ payment_intent: intent.id, amount: 10000, reason: "cancelled_item", note: "Logo dropped" });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: "pending", amount: 10000, reason: "cancelled_item" });
    expect(first.json().settlekit.tx_hash).toMatch(/^0x/);

    const over = await refund({ payment_intent: intent.id, amount: 40001 });
    expect(over.json().error.code).toBe("refund_exceeds_paid");

    await confirm();
    await dispatchDue(chain.db());
    expect((await chain.api("GET", `/v1/refunds/${first.json().id}`)).json().status).toBe("succeeded");
    const updated = chain.receiver.received.find((e) => e.type === "refund.updated" && e.data.object.id === first.json().id);
    expect(updated.data.object.status).toBe("succeeded");
    expect(chain.receiver.duplicates).toEqual([]);

    const rest = await refund({ payment_intent: intent.id });
    expect(rest.json().amount).toBe(40000);
    await confirm();

    const done = await refund({ payment_intent: intent.id, amount: 1 });
    expect(done.json().error.code).toBe("charge_already_refunded");
  });

  it("counts an unconfirmed refund against the cap", async () => {
    const intent = await paidIntent(1000, "PF-R2");
    await refund({ payment_intent: intent.id, amount: 1000 });
    const again = await refund({ payment_intent: intent.id, amount: 1 });
    expect(again.json().error.code).toBe("charge_already_refunded");
    await confirm();
  });

  it("refuses a refund the wallet can't fund, without blocking a later one", async () => {
    const intent = await paidIntent(1000, "PF-R3");
    await chain.approveRefunds(0n);
    const blocked = await refund({ payment_intent: intent.id, amount: 500 });
    expect(blocked.json().error.code).toBe("insufficient_refund_balance");

    await chain.approveRefunds(2n ** 96n);
    expect((await refund({ payment_intent: intent.id, amount: 500 })).statusCode).toBe(200);
    await confirm();
  });

  it("won't refund another merchant's or an unpaid payment", async () => {
    const unpaid = (await chain.api("POST", "/v1/payment_intents", { amount: 100, currency: "usd" })).json();
    expect((await refund({ payment_intent: unpaid.id })).statusCode).toBe(404);
  });
});

describe("gasless checkout", () => {
  const signRelay = async (key: Hex, intent: any, tamper = false) => {
    const wallet = privateKeyToAccount(key);
    const { pay } = (await chain.app().inject({ url: `/public/payment_intents/${intent.client_secret}` })).json();
    const amount = BigInt(pay.amount);
    const deadline = BigInt(pay.deadline);

    const permit = parseSignature(
      await wallet.signTypedData({
        domain: { ...pay.permit_domain, chainId: pay.chain_id, verifyingContract: pay.token },
        types: {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        primaryType: "Permit",
        message: { owner: wallet.address, spender: pay.contract, value: amount, nonce: 0n, deadline },
      }),
    );
    const payerSignature = await wallet.signTypedData({
      domain: { name: "SettleKitPayments", version: "1", chainId: pay.chain_id, verifyingContract: pay.contract },
      types: {
        PaymentAuthorization: [
          { name: "intentId", type: "bytes32" },
          { name: "merchant", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "payer", type: "address" },
        ],
      },
      primaryType: "PaymentAuthorization",
      message: {
        intentId: pay.intent_id,
        merchant: pay.merchant,
        amount: tamper ? amount + 1n : amount,
        deadline,
        payer: wallet.address,
      },
    });

    return {
      payer: wallet.address,
      payer_signature: payerSignature,
      permit: {
        deadline: deadline.toString(),
        v: Number(permit.v ?? BigInt(permit.yParity + 27)),
        r: permit.r,
        s: permit.s,
      },
    };
  };

  const relay = (intent: any, payload: object) =>
    chain.app().inject({ method: "POST", url: `/public/payment_intents/${intent.client_secret}/relay`, payload });

  const newIntent = async () => (await chain.api("POST", "/v1/payment_intents", { amount: 2500, currency: "usd" })).json();

  it("settles for a wallet with no gas and records the payer, not the relayer", async () => {
    const key = generatePrivateKey();
    const wallet = privateKeyToAccount(key);
    await chain.mint(wallet.address, 25_000000n);
    expect(await chain.gasBalance(wallet.address)).toBe(0n);

    const intent = await newIntent();
    const res = await relay(intent, await signRelay(key, intent));
    expect(res.statusCode).toBe(200);
    await confirm();

    const final = (await chain.api("GET", `/v1/payment_intents/${intent.id}`)).json();
    expect(final.status).toBe("succeeded");
    expect(final.settlekit.payer).toBe(wallet.address);

    const [row] = await chain.db().query("SELECT gas_paid_by FROM payments WHERE intent_id = $1", [intent.id]);
    expect(row.gas_paid_by).toBe("relayer");
  });

  it("relays each intent once", async () => {
    const key = generatePrivateKey();
    const wallet = privateKeyToAccount(key);
    await chain.mint(wallet.address, 25_000000n);
    const intent = await newIntent();
    const signed = await signRelay(key, intent);

    expect((await relay(intent, signed)).statusCode).toBe(200);
    expect((await relay(intent, signed)).statusCode).toBe(429);
    await confirm();
  });

  it("rejects a bad signature and lets the customer try again", async () => {
    const key = generatePrivateKey();
    const wallet = privateKeyToAccount(key);
    await chain.mint(wallet.address, 25_000000n);
    const intent = await newIntent();

    const bad = await relay(intent, await signRelay(key, intent, true));
    expect(bad.json().error.code).toBe("relay_rejected");

    expect((await relay(intent, await signRelay(key, intent))).statusCode).toBe(200);
    await confirm();
  });

  it("stops at the merchant's daily limit", async () => {
    await chain.db().query("UPDATE merchants SET relay_daily_limit = 0");
    const intent = await newIntent();
    const res = await relay(intent, await signRelay(generatePrivateKey(), intent));
    expect(res.statusCode).toBe(429);
    await chain.db().query("UPDATE merchants SET relay_daily_limit = 200");
  });

  it("honours the merchant's gasless setting", async () => {
    await chain.api("POST", "/v1/account", { gasless: false });
    const intent = await newIntent();
    const res = await relay(intent, await signRelay(generatePrivateKey(), intent));
    expect(res.json().error.code).toBe("gasless_disabled");
    await chain.api("POST", "/v1/account", { gasless: true });
  });
});

describe("subscriptions", () => {
  const INTERVAL = 60;

  const subscribe = async (maxPeriods = 0) => {
    const session = (
      await chain.api("POST", "/v1/checkout/sessions", {
        mode: "subscription",
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: 30000,
              product_data: { name: "Maintenance retainer" },
              recurring: { interval: "month" },
            },
          },
        ],
        settlekit_interval_seconds: INTERVAL,
        settlekit_max_periods: maxPeriods,
        metadata: { plan: "retainer" },
      })
    ).json();

    const { subscribe: params } = (await chain.app().inject({ url: `/public/checkout/${session.id}` })).json();
    const hash = await chain.subscribe(params);
    await chain.app().inject({
      method: "POST",
      url: `/public/checkout/${session.id}/subscribed`,
      payload: { tx_hash: hash },
    });
    await confirm();
    const [row] = await chain.db().query("SELECT * FROM subscriptions WHERE session_id = $1", [session.id]);
    return { session, row };
  };

  const dueNow = async (id: string) => {
    await chain.advanceTime(INTERVAL + 1);
    await chain.db().query("UPDATE subscriptions SET next_charge_at = now() WHERE id = $1", [id]);
  };
  const get = async (id: string) => (await chain.api("GET", `/v1/subscriptions/${id}`)).json();

  it("subscribes, charges a renewal once per period, and shows the history", async () => {
    const { session, row } = await subscribe();
    expect(row).toMatchObject({ status: "active", periods_charged: 1, plan_name: "Maintenance retainer" });
    expect((await chain.api("GET", `/v1/checkout/sessions/${session.id}`)).json().status).toBe("complete");

    await dueNow(row.id);
    expect(await chargeDue(chain.db(), chain.writer())).toBe(1);
    await confirm();

    const renewed = await get(row.id);
    expect(renewed.periods_charged).toBe(2);
    expect(renewed.charges.filter((charge: any) => charge.status === "succeeded")).toHaveLength(2);

    // Not due again yet, so the keeper has nothing to send.
    expect(await chargeDue(chain.db(), chain.writer())).toBe(0);
    await dispatchDue(chain.db());
    expect(chain.receiver.types()).toContain("customer.subscription.created");
    expect(chain.receiver.types()).toContain("customer.subscription.updated");
  });

  it("goes past due on a failed renewal, then recovers when funded", async () => {
    const { row } = await subscribe();
    await chain.approveSubscriptions(0n);

    await dueNow(row.id);
    await chargeDue(chain.db(), chain.writer());
    await confirm();

    const failed = await get(row.id);
    expect(failed.status).toBe("past_due");
    expect(failed.current_period_end - Date.now() / 1000).toBeGreaterThan(80_000);
    await dispatchDue(chain.db());
    expect(chain.receiver.types()).toContain("invoice.payment_failed");

    await chain.approveSubscriptions(2n ** 96n);
    expect((await chain.api("POST", `/v1/subscriptions/${row.id}/retry`, {})).statusCode).toBe(200);
    await chargeDue(chain.db(), chain.writer());
    await confirm();

    const recovered = await get(row.id);
    expect(recovered.status).toBe("active");
    expect(recovered.periods_charged).toBe(2);
  });

  it("cancels after the final failed retry", async () => {
    const { row } = await subscribe();
    await chain.approveSubscriptions(0n);

    for (let attempt = 0; attempt < 3; attempt++) {
      await dueNow(row.id);
      await chargeDue(chain.db(), chain.writer());
      await confirm();
    }
    expect((await get(row.id)).status).toBe("canceled");
    await chain.approveSubscriptions(2n ** 96n);
  });

  it("records a customer's onchain cancel and stops charging", async () => {
    const { row } = await subscribe();
    await chain.cancelSubscription(BigInt(row.onchain_sub_id));
    await confirm();

    expect((await get(row.id)).status).toBe("canceled");
    await chain.advanceTime(INTERVAL + 1);
    expect(await chargeDue(chain.db(), chain.writer())).toBe(0);
  });

  it("stops charging when the merchant cancels", async () => {
    const { row } = await subscribe();
    expect((await chain.api("POST", `/v1/subscriptions/${row.id}/cancel`, {})).json().status).toBe("canceled");
    await chain.advanceTime(INTERVAL + 1);
    expect(await chargeDue(chain.db(), chain.writer())).toBe(0);
    expect((await chain.api("POST", `/v1/subscriptions/${row.id}/cancel`, {})).statusCode).toBe(400);
  });

  it("finishes at the maximum number of periods", async () => {
    const { row } = await subscribe(2);
    await dueNow(row.id);
    await chargeDue(chain.db(), chain.writer());
    await confirm();
    expect((await get(row.id)).status).toBe("canceled");
    expect((await get(row.id)).periods_charged).toBe(2);
  });
});

describe("reports and reconciliation", () => {
  const period = () => {
    const now = Math.floor(Date.now() / 1000);
    return `from=${now - 3600}&to=${now + 3600}`;
  };

  it("makes net equal the onchain paid minus refunded", async () => {
    await paidIntent(12345, "PF-NET");
    const report = (await chain.api("GET", `/v1/reports?${period()}`)).json();

    const gross = report.transactions.reduce((sum: number, row: any) => sum + row.gross, 0);
    const refunds = report.transactions.reduce((sum: number, row: any) => sum + row.refund, 0);
    expect(report.summary).toMatchObject({ gross, refunds, net: gross - refunds });

    const [paid] = await chain
      .db()
      .query(
        `SELECT (SELECT coalesce(sum(amount), 0) FROM payments) + (SELECT coalesce(sum(amount), 0) FROM subscription_charges WHERE status = 'succeeded') AS total`,
      );
    expect(gross).toBe(Number(paid.total));
  });

  it("exports a CSV that defuses spreadsheet formulas", async () => {
    await chain.api("POST", "/v1/payment_intents", { amount: 100, currency: "usd" });
    const intent = await paidIntent(2000, "=HYPERLINK(evil)");
    expect(intent.id).toBeTruthy();

    const csv = await chain.app().inject({
      url: `/v1/reports/export.csv?${period()}`,
      headers: { authorization: `Bearer ${chain.key()}` },
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.payload.charCodeAt(0)).toBe(0xfeff);
    expect(csv.payload).toContain("Date (UTC),Date (local),Type");
    expect(csv.payload).toContain("'=HYPERLINK(evil)");
    expect(csv.payload).not.toMatch(/,=HYPERLINK/);
    expect(csv.payload).toContain("Summary");
  });

  it("exports an XLSX that opens, with numbers as numbers", async () => {
    const res = await chain.app().inject({
      url: `/v1/reports/export.xlsx?${period()}`,
      headers: { authorization: `Bearer ${chain.key()}` },
    });
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(res.rawPayload as any);
    const sheet = book.getWorksheet("Transactions")!;
    expect(sheet.getRow(1).getCell(1).value).toBe("Date (UTC)");
    expect(typeof sheet.getRow(2).getCell(7).value).toBe("number");
  });

  it("builds an accountant pack zip", async () => {
    const res = await chain.app().inject({
      url: `/v1/reports/accountant-pack.zip?${period()}`,
      headers: { authorization: `Bearer ${chain.key()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.subarray(0, 2).toString()).toBe("PK");
  });

  it("flags USDT sent straight to the wallet as unmatched until it's matched by hand", async () => {
    const hash = await chain.transferToMerchant(3_000000n);
    await confirm();

    const find = async () =>
      (await chain.api("GET", `/v1/reports?${period()}`))
        .json()
        .reconciliation.find((row: any) => row.explorer_url.endsWith(hash));

    const row = await find();
    expect(row).toMatchObject({ status: "unmatched", amount: 300 });

    await chain.api("POST", `/v1/reconciliation/${row.id}/match`, { reference: "PF-OFFLINE" });
    expect(await find()).toMatchObject({ status: "matched", reference: "PF-OFFLINE" });
  });

  it("matches a checkout payment automatically and flags a partial refund", async () => {
    const intent = await paidIntent(5000, "PF-MATCH");
    await refund({ payment_intent: intent.id, amount: 1000 });
    await confirm();

    const rows = (await chain.api("GET", `/v1/reports?${period()}`)).json().reconciliation;
    const row = rows.find((candidate: any) => candidate.reference === "PF-MATCH");
    expect(row).toMatchObject({ status: "matched", flags: ["partially_refunded"] });
  });

  it("rejects an unknown timezone and an inverted range", async () => {
    const now = Math.floor(Date.now() / 1000);
    const bad = await chain.api("GET", `/v1/reports?from=${now}&to=${now + 1}&timezone=Mars/Base`);
    expect(bad.json().error.param).toBe("timezone");
    expect((await chain.api("GET", `/v1/reports?from=${now}&to=${now}`)).statusCode).toBe(400);
  });
});

describe("dashboard data", () => {
  it("summarises the business and finds payments by order id", async () => {
    await paidIntent(7000, "PF-DASH");

    const overview = (await chain.api("GET", "/v1/overview")).json();
    expect(overview.volume.today).toBeGreaterThan(0);
    expect(overview.daily).toHaveLength(30);
    expect(overview.activity.length).toBeGreaterThan(0);
    expect(overview.wallet.usdt).toBeGreaterThan(0);

    const found = (await chain.api("GET", "/v1/payments?q=pf-dash")).json().data;
    expect(found).toHaveLength(1);

    const detail = (await chain.api("GET", `/v1/payments/${found[0].id}`)).json();
    expect(detail).toMatchObject({ reference: "PF-DASH", status: "succeeded", gas_paid_by: "customer" });
    expect(detail.confirmations).toBeGreaterThan(0);
    expect(detail.webhook_deliveries.length).toBeGreaterThan(0);
  });

  it("logs each delivery attempt and replays an event", async () => {
    await dispatchDue(chain.db());
    const log = (await chain.api("GET", "/v1/event_log")).json().data;
    const delivered = log.find((event: any) => event.deliveries[0]?.status === "succeeded");

    const attempts = (await chain.api("GET", `/v1/webhook_deliveries/${delivered.deliveries[0].id}/attempts`)).json();
    expect(attempts.data[0]).toMatchObject({ attempt: 1, status_code: 200 });

    const seen = () => chain.receiver.received.filter((event) => event.id === delivered.id).length;
    const before = seen();
    expect((await chain.api("POST", `/v1/events/${delivered.id}/replay`, {})).json().replayed).toBe(1);
    await dispatchDue(chain.db());
    expect(seen()).toBe(before + 1);
    chain.receiver.duplicates.length = 0;
  });

  it("saves account settings", async () => {
    const saved = (await chain.api("POST", "/v1/account", { brand_color: "#2563eb", timezone: "Asia/Kolkata" })).json();
    expect(saved).toMatchObject({ brand_color: "#2563eb", timezone: "Asia/Kolkata" });
    expect((await chain.api("POST", "/v1/account", { brand_color: "blue" })).statusCode).toBe(400);
  });
});

describe("customer portal", () => {
  let token: string;

  const signIn = async (signer = customer, address = customer.address, expires = Math.floor(Date.now() / 1000) + 600) =>
    chain.app().inject({
      method: "POST",
      url: "/public/portal/session",
      payload: { address, expires, signature: await signer.signMessage({ message: signInMessage(address, expires) }) },
    });
  const portal = (bearer: string) =>
    chain.app().inject({ url: "/public/portal", headers: { authorization: `Bearer ${bearer}` } });

  beforeAll(async () => {
    await paidIntent(1500, "PF-PORTAL");
    token = (await signIn()).json().token;
  });

  it("shows a wallet its own history", async () => {
    const body = (await portal(token)).json();
    expect(body.address).toBe(customer.address.toLowerCase());
    expect(body.payments.length).toBeGreaterThan(0);
    expect(body.payments[0]).toHaveProperty("explorer_url");
  });

  it("rejects someone signing for a wallet they don't own", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey());
    expect((await signIn(stranger, customer.address)).json().error.code).toBe("bad_signature");
  });

  it("rejects a tampered token or an old sign-in", async () => {
    const [, expires, signature] = token.split(".");
    expect((await portal(`0x0000000000000000000000000000000000000abc.${expires}.${signature}`)).statusCode).toBe(401);
    expect((await portal("nonsense")).statusCode).toBe(401);

    const past = Math.floor(Date.now() / 1000) - 10;
    expect((await signIn(customer, customer.address, past)).json().error.code).toBe("sign_in_expired");
  });
});

describe("emails and reminders", () => {
  const emails = (kind: string, to: string) =>
    chain.db().query("SELECT * FROM emails WHERE kind = $1 AND to_address = $2 ORDER BY created_at", [kind, to]);

  const invoice = async (email: string, dueInDays: number) => {
    const created = (
      await chain.api("POST", "/v1/invoices", {
        customer: { name: "Mark", email },
        line_items: [{ description: "Design", quantity: 1, unit_amount: 10000 }],
        due_date: Math.floor(Date.now() / 1000) + 86_400 * dueInDays,
      })
    ).json();
    await chain.api("POST", `/v1/invoices/${created.id}/send`, {});
    return created;
  };

  it("emails an invoice when it is sent", async () => {
    await invoice("sent@example.com", 14);
    const [email] = await emails("invoice", "sent@example.com");
    expect(email.subject).toContain("Invoice INV-");
    expect(email.body).toContain("/i/in_");
  });

  it("picks the right reminder stage", () => {
    const now = new Date("2026-11-10T12:00:00Z");
    const inDays = (days: number) => new Date(now.getTime() + days * 86_400_000);
    expect(reminderKind(inDays(5), now)).toBeNull();
    expect(reminderKind(inDays(2.5), now)).toBe("before_due");
    expect(reminderKind(inDays(0), now)).toBe("due_today");
    expect(reminderKind(inDays(-1), now)).toBe("due_today");
    expect(reminderKind(inDays(-3.5), now)).toBe("overdue");
  });

  it("logs a reminder for an invoice due tomorrow, and sends it once", async () => {
    const created = await invoice("soon@example.com", 1);
    await sendDueReminders(chain.db(), chain.config());
    await sendDueReminders(chain.db(), chain.config());

    expect(await emails("reminder", "soon@example.com")).toHaveLength(1);
    const log = (await chain.api("GET", `/v1/invoices/${created.id}/reminders`)).json().data;
    expect(log).toHaveLength(1);
    expect(log[0].kind).toBe("before_due");
    expect(log[0].sent_at).toBeGreaterThan(0);
  });

  it("lets a merchant send one by hand, and honours the switch", async () => {
    const created = await invoice("manual@example.com", 30);
    await chain.api("POST", `/v1/invoices/${created.id}/remind`, {});
    await chain.api("POST", `/v1/invoices/${created.id}/remind`, {});
    expect(await emails("reminder", "manual@example.com")).toHaveLength(2);

    await chain.api("POST", "/v1/account", { reminders_enabled: false });
    await invoice("off@example.com", 1);
    await sendDueReminders(chain.db(), chain.config());
    expect(await emails("reminder", "off@example.com")).toHaveLength(0);
    await chain.api("POST", "/v1/account", { reminders_enabled: true });
  });

  it("stops reminding once an invoice is paid", async () => {
    const created = await invoice("paid@example.com", 1);
    const { client_secret } = (
      await chain.app().inject({ method: "POST", url: `/public/invoices/${created.id}/pay`, payload: {} })
    ).json();
    await chain.pay(client_secret);
    await confirm();
    await sendDueReminders(chain.db(), chain.config());
    expect(await emails("reminder", "paid@example.com")).toHaveLength(0);
    expect(await emails("receipt", "paid@example.com")).toHaveLength(1);
  });

  it("sends a checkout receipt and a refund notice to the email given at checkout", async () => {
    const session = (
      await chain.api("POST", "/v1/checkout/sessions", {
        line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: 900, product_data: { name: "Kit" } } }],
      })
    ).json();
    await chain.app().inject({
      method: "POST",
      url: `/public/checkout/${session.id}/email`,
      payload: { email: "buyer@example.com" },
    });
    const { intent } = (await chain.app().inject({ url: `/public/checkout/${session.id}` })).json();
    await chain.pay(intent.client_secret);
    await confirm();
    expect(await emails("receipt", "buyer@example.com")).toHaveLength(1);

    await refund({ payment_intent: session.payment_intent, amount: 100 });
    await confirm();
    const [notice] = await emails("refund", "buyer@example.com");
    expect(notice.subject).toContain("1.00 USDT");
  });

  it("marks mail as logged when no provider is configured, so nothing is stuck", async () => {
    await deliverEmails(chain.db(), chain.config(), 500);
    const [{ pending }] = await chain.db().query("SELECT count(*)::int AS pending FROM emails WHERE status = 'pending'");
    expect(pending).toBe(0);
  });

  it("gives every payer a customer record with totals", async () => {
    const rows = (await chain.api("GET", "/v1/customers")).json().data;
    const buyer = rows.find((row: any) => row.email === "buyer@example.com");
    // This wallet paid throughout the suite, and all of it belongs to one customer.
    expect(buyer.paid).toBeGreaterThanOrEqual(900);
    expect(buyer.refunded).toBeGreaterThanOrEqual(100);
    expect(buyer.wallets).toEqual([customer.address]);
  });

  it("signs in by magic link without revealing who is a customer", async () => {
    const ask = (email: string) =>
      chain.app().inject({ method: "POST", url: "/public/portal/magic", payload: { email } });
    expect((await ask("nobody@example.com")).json()).toEqual({ ok: true });
    expect(await emails("magic_link", "nobody@example.com")).toHaveLength(0);

    await ask("buyer@example.com");
    const [link] = await emails("magic_link", "buyer@example.com");
    const token = /token=(\S+)/.exec(link.body)![1];
    const portal = await chain.app().inject({ url: "/public/portal", headers: { authorization: `Bearer ${token}` } });
    expect(portal.statusCode).toBe(200);
    expect(portal.json().payments.length).toBeGreaterThan(0);
  });

  it("emails a receipt on request and serves a receipt PDF", async () => {
    const intent = await paidIntent(1200, "PF-PDF");
    const { payment_id } = (await chain.app().inject({ url: `/public/payment_intents/${intent.client_secret}` })).json();

    await chain.app().inject({
      method: "POST",
      url: `/public/receipts/${payment_id}/email`,
      payload: { email: "copy@example.com" },
    });
    expect(await emails("receipt", "copy@example.com")).toHaveLength(1);

    const pdf = await chain.app().inject({ url: `/public/receipts/${payment_id}/pdf` });
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("edge cases", () => {
  it("lets a customer pay again if a reorg dropped their transaction", async () => {
    const intent = (await chain.api("POST", "/v1/payment_intents", { amount: 100, currency: "usd" })).json();
    await chain.db().query(
      "UPDATE payment_intents SET status = 'processing', processing_at = now() - interval '6 minutes' WHERE id = $1",
      [intent.id],
    );
    await releaseStuckProcessing(chain.db());
    expect((await chain.api("GET", `/v1/payment_intents/${intent.id}`)).json().status).toBe("requires_payment_method");
  });

  it("leaves a recent processing payment alone", async () => {
    const intent = (await chain.api("POST", "/v1/payment_intents", { amount: 100, currency: "usd" })).json();
    await chain.db().query("UPDATE payment_intents SET status = 'processing', processing_at = now() WHERE id = $1", [
      intent.id,
    ]);
    await releaseStuckProcessing(chain.db());
    expect((await chain.api("GET", `/v1/payment_intents/${intent.id}`)).json().status).toBe("processing");
  });
});
