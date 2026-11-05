// PixelForge Studio's own site. It sells through SettleKit using only the code between the markers.
import { SettleKit } from "@settlekit/node";
import express from "express";

const { SETTLEKIT_SECRET_KEY, SETTLEKIT_WEBHOOK_SECRET, SETTLEKIT_API_URL, SETTLEKIT_LINK, CHECKOUT_ORIGIN } = process.env;
const PORT = Number(process.env.PORT ?? 4300);
const SITE = `http://localhost:${PORT}`;

const app = express();
const orders = new Map<string, string>([["PF-1042", "unpaid"]]);
const fulfilled = new Set<string>();

// SETTLEKIT INTEGRATION START
const kit = new SettleKit(SETTLEKIT_SECRET_KEY!, { baseUrl: SETTLEKIT_API_URL });

app.post("/checkout", express.urlencoded({ extended: true }), async (req, res) => {
  const session = await kit.checkout.sessions.create(
    {
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: 50000, product_data: { name: "Brand Kit" } } }],
      metadata: { orderId: req.body.orderId },
      success_url: `${SITE}/thanks?order=${req.body.orderId}`,
    },
    { idempotencyKey: `checkout-${req.body.orderId}-${Date.now()}` },
  );
  res.redirect(303, session.url);
});

app.post("/webhooks", express.raw({ type: "application/json" }), (req, res) => {
  const event = kit.webhooks.constructEvent(req.body, req.headers["settlekit-signature"], SETTLEKIT_WEBHOOK_SECRET!);
  if (event.type === "checkout.session.completed" && !fulfilled.has(event.id)) {
    fulfilled.add(event.id);
    orders.set(event.data.object.metadata.orderId, "paid");
  }
  res.sendStatus(200);
});
// SETTLEKIT INTEGRATION END

const page = (body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PixelForge Studio</title>
<style>
  body { margin: 0; background: #faf9f7; color: #1c1917; font: 16px/1.5 system-ui, sans-serif; }
  main { display: grid; gap: 20px; max-width: 640px; margin: 0 auto; padding: 48px 16px; }
  section { padding: 24px; border: 1px solid #e7e5e4; border-radius: 12px; background: #fff; }
  h1, h2, p { margin: 0 0 8px; }
  button { padding: 12px 22px; border: 0; border-radius: 8px; background: #1c1917; color: #fff; font: 600 15px system-ui, sans-serif; cursor: pointer; }
</style></head><body><main>${body}</main></body></html>`;

app.get("/", (_req, res) => {
  res.send(
    page(`
      <h1>PixelForge Studio</h1>
      <p>Design and development for startups, from Bengaluru.</p>
      <section>
        <h2>Brand Kit</h2>
        <p>Logo, colours and type, ready in a week. $500.</p>
        <form action="/checkout" method="post">
          <input type="hidden" name="orderId" value="PF-1042">
          <button>Buy Brand Kit</button>
        </form>
      </section>
      ${
        SETTLEKIT_LINK
          ? `<section>
        <h2>Logo Pack</h2>
        <p>One line of HTML, no backend.</p>
        <script src="${CHECKOUT_ORIGIN}/button.js" data-link="${SETTLEKIT_LINK}"></script>
      </section>`
          : ""
      }`),
  );
});

app.get("/thanks", (req, res) => {
  const status = orders.get(String(req.query.order)) ?? "unknown";
  res.send(page(`<h1>Thanks for your order</h1><p>Order ${req.query.order}: <strong id="status">${status}</strong></p>`));
});

app.get("/orders/:id", (req, res) => {
  res.json({ status: orders.get(req.params.id) ?? "unknown" });
});

app.listen(PORT, () => console.log(`PixelForge store on ${SITE}`));
