// Drives the real hosted pages in Chrome against a local chain, the real contracts and the real API.
// Build first with `npm run build -w @settlekit/web`, then run with `npm run e2e -w @settlekit/web`.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium, type Page } from "playwright-core";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  defineChain,
  type Hex,
  http,
  parseAbi,
} from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { SettleKit } from "../../../packages/node/src/index.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const OUT = process.env.E2E_OUT ?? join(ROOT, "apps/web/e2e/out");

const RPC_PORT = 38600;
const API_PORT = 4100;
const WEB_PORT = 3100;
const CHAIN_ID = 31337;
const RPC = `http://127.0.0.1:${RPC_PORT}`;
const API = `http://localhost:${API_PORT}`;
const WEB = `http://localhost:${WEB_PORT}`;
const EXPLORER = "https://explorer.testnet.whitechain.io";

const deployer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const merchant = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
let customer = privateKeyToAccount(`0x${"c0".repeat(32)}`);

const chain = defineChain({
  id: CHAIN_ID,
  name: "anvil",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const reader = createPublicClient({ chain, transport: http(RPC) });
const walletOf = (account: PrivateKeyAccount) => createWalletClient({ account, chain, transport: http(RPC) });

const paymentsAbi = parseAbi([
  "function registerMerchant(address payout, address refundWallet, address refundOperator)",
  "function refund(bytes32 intentId, uint256 amount, uint8 reasonCode)",
]);
const usdtAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const gaslessPayer = privateKeyToAccount(`0x${"d1".repeat(32)}`);

const processes: ChildProcess[] = [];
const results: string[] = [];
const pageErrors: string[] = [];
const consoleErrors: string[] = [];
let openPage: Page | undefined;

function artifact(name: string) {
  const json = JSON.parse(readFileSync(join(ROOT, `contracts/out/${name}.sol/${name}.json`), "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object as Hex };
}

async function deploy(name: string, args: unknown[]) {
  const { abi, bytecode } = artifact(name);
  const hash = await walletOf(deployer).deployContract({ abi, bytecode, args });
  return (await reader.waitForTransactionReceipt({ hash })).contractAddress as Address;
}

async function write(account: PrivateKeyAccount, request: any) {
  const hash = await walletOf(account).writeContract(request);
  await reader.waitForTransactionReceipt({ hash });
  return hash;
}

async function waitFor(url: string, name: string) {
  for (let i = 0; i < 300; i++) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(1000) });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`${name} did not start`);
}

function start(command: string, args: string[], env: Record<string, string>, cwd = ROOT, output?: string[]) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: output ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  child.stdout?.on("data", (chunk) => output?.push(String(chunk)));
  processes.push(child);
}

/** A stand-in for a browser wallet. It starts on the wrong network, as a real customer's often is. */
function installWallet(context: BrowserContext) {
  const state = { chainId: 1, chainAdded: false, rejectNext: false };
  const fail = (code: number, message: string) => ({ error: { code, message } });

  const handle = async (method: string, params: any[]) => {
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return { result: [customer.address] };
      case "eth_chainId":
        return { result: `0x${state.chainId.toString(16)}` };
      case "wallet_switchEthereumChain":
        if (!state.chainAdded) return fail(4902, "Unrecognized chain");
        state.chainId = Number(params[0].chainId);
        return { result: null };
      case "wallet_addEthereumChain":
        state.chainAdded = true;
        state.chainId = Number(params[0].chainId);
        return { result: null };
      case "eth_signTypedData_v4": {
        if (state.rejectNext) {
          state.rejectNext = false;
          return fail(4001, "User rejected the request");
        }
        const { domain, types, primaryType, message } = JSON.parse(params[1]);
        delete types.EIP712Domain;
        return { result: await customer.signTypedData({ domain, types, primaryType, message }) };
      }
      case "personal_sign":
        return { result: await customer.signMessage({ message: { raw: params[0] } }) };
      case "eth_sendTransaction": {
        if (state.rejectNext) {
          state.rejectNext = false;
          return fail(4001, "User rejected the request");
        }
        const { to, data } = params[0];
        return { result: await walletOf(customer).sendTransaction({ to, data }) };
      }
      default: {
        const response = await fetch(RPC, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        return response.json();
      }
    }
  };

  return { state, install: () => context.exposeBinding("__wallet", (_source, method, params) => handle(method, params)) };
}

const walletScript = `
  window.ethereum = {
    request: async ({ method, params = [] }) => {
      const reply = await window.__wallet(method, params);
      if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
      return reply.result;
    },
    on() {},
    removeListener() {},
  };
`;

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function step(name: string, run: () => Promise<void>) {
  const started = Date.now();
  try {
    await run();
  } catch (error) {
    if (openPage) {
      await shot(openPage, "failure").catch(() => {});
      console.error(`Page at failure (${openPage.url()}):
${await openPage.locator("body").innerText().catch(() => "")}`);
      console.error(`Console errors:
${consoleErrors.join(String.fromCharCode(10))}`);
    }
    throw error;
  }
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join("; ")}`);
  results.push(`ok  ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  console.log(results.at(-1));
}

const shot = (page: Page, name: string) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });

async function main() {
  mkdirSync(OUT, { recursive: true });
  assert(existsSync(join(ROOT, "apps/web/.next/BUILD_ID")), "build the web app first");

  const localAnvil = join(homedir(), ".foundry", "bin", "anvil.exe");
  start(existsSync(localAnvil) ? localAnvil : "anvil", ["--port", String(RPC_PORT), "--block-time", "1", "--silent"], {});
  await waitFor(RPC, "anvil");

  await createTestFunds();
  const usdt = await deploy("MockUSDT", []);
  const payments = await deploy("SettleKitPayments", [usdt, deployer.address, deployer.address]);
  const subscriptions = await deploy("SettleKitSubscriptions", [usdt, payments, deployer.address, deployer.address]);
  await write(merchant, {
    address: payments,
    abi: paymentsAbi,
    functionName: "registerMerchant",
    args: [merchant.address, merchant.address, deployer.address],
  });
  await write(deployer, { address: usdt, abi: usdtAbi, functionName: "mint", args: [customer.address, 5_000_000000n] });
  await write(deployer, { address: usdt, abi: usdtAbi, functionName: "mint", args: [merchant.address, 1_000_000000n] });
  await write(deployer, { address: usdt, abi: usdtAbi, functionName: "mint", args: [gaslessPayer.address, 100_000000n] });
  await write(merchant, { address: usdt, abi: usdtAbi, functionName: "approve", args: [payments, 2n ** 96n] });

  const apiEnv = {
    DATA_DIR: mkdtempSync(join(tmpdir(), "settlekit-e2e-")),
    PORT: String(API_PORT),
    WHITECHAIN_RPC_URL: RPC,
    EXPLORER_URL: EXPLORER,
    CHECKOUT_URL: WEB,
    CHAIN_ID: String(CHAIN_ID),
    PAYMENTS_ADDRESS: payments,
    USDT_ADDRESS: usdt,
    SUBSCRIPTIONS_ADDRESS: subscriptions,
    INDEXER_START_BLOCK: "0",
    INTENT_SIGNER_PRIVATE_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    MERCHANT_WALLET: merchant.address,
  };
  const tsx = join(ROOT, "node_modules/tsx/dist/cli.mjs");
  const apiDir = join(ROOT, "apps/api");
  const seeded = spawnSync(process.execPath, [tsx, "src/seed.ts"], {
    cwd: apiDir,
    env: { ...process.env, ...apiEnv },
    encoding: "utf8",
  });
  const secretKey = /Secret key \(shown once\): (\S+)/.exec(seeded.stdout)?.[1];
  assert(secretKey, `seed failed: ${seeded.stderr}`);

  const apiOutput: string[] = [];
  start(process.execPath, [tsx, "src/index.ts"], apiEnv, apiDir, apiOutput);
  await waitFor(`${API}/health`, "API");
  start(process.execPath, [join(ROOT, "node_modules/next/dist/bin/next"), "start", "-p", String(WEB_PORT)], {
    API_URL: API,
    PUBLIC_API_URL: API,
    NEXT_TELEMETRY_DISABLED: "1",
    INSECURE_COOKIES: "1",
  }, join(ROOT, "apps/web"));
  await waitFor(WEB, "web");

  const kit = new SettleKit(secretKey!, { baseUrl: API });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const wallet = installWallet(context);
  await wallet.install();
  await context.addInitScript({ content: walletScript });
  const page = await context.newPage();
  openPage = page;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const lineItem = (name: string, cents: number) => ({
    quantity: 1,
    price_data: { currency: "usd", unit_amount: cents, product_data: { name } },
  });

  let receiptUrl = "";
  await step("hosted checkout: connect, switch network, reject, pay, receipt", async () => {
    const session = await kit.checkout.sessions.create({
      mode: "payment",
      line_items: [lineItem("Brand Kit", 50000)],
      success_url: "https://pixelforge.example/thanks",
      cancel_url: "https://pixelforge.example/cart",
      metadata: { orderId: "PF-1042" },
    });
    await page.goto(session.url);
    await page.getByText("Brand Kit").waitFor();
    await page.getByText("PixelForge Studio").waitFor();
    await page.getByText("Test mode · Whitechain Sepolia").waitFor();
    await page.getByLabel("Email for your receipt").fill("mark@example.com");
    await page.getByLabel("Email for your receipt").blur();
    await page.getByText("We'll send your receipt there").waitFor();
    await shot(page, "1-checkout");

    await page.getByRole("button", { name: "Connect wallet" }).click();
    await page.getByRole("button", { name: "Switch to Whitechain" }).click();
    const payButton = page.getByRole("button", { name: "Pay 500.00 USDT" });
    await payButton.waitFor();
    await page.getByText("5000.00 USDT").waitFor();

    wallet.state.rejectNext = true;
    await payButton.click();
    await page.getByRole("alert").getByText("You cancelled that in your wallet").waitFor();
    await shot(page, "2-rejected");

    const clicked = Date.now();
    await payButton.click();
    await page.getByTestId("paid").waitFor({ timeout: 30_000 });
    const seconds = (Date.now() - clicked) / 1000;
    console.log(`    click to paid: ${seconds.toFixed(1)}s`);
    assert(seconds < 15, `click to paid took ${seconds}s`);
    await shot(page, "3-paid");

    await page.getByRole("link", { name: "View receipt" }).click();
    await page.getByTestId("receipt-status").waitFor();
    assert((await page.getByTestId("receipt-status").textContent()) === "Paid", "receipt says Paid");
    await page.getByText("This record lives on Whitechain").waitFor();
    await page.getByText("PF-1042").waitFor();
    receiptUrl = page.url();
    await shot(page, "4-receipt");

    const final = await kit.checkout.sessions.retrieve(session.id);
    assert(final.status === "complete" && final.payment_status === "paid", "session completed");

    const [pdf] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download receipt PDF" }).click()]);
    assert(readFileSync(await pdf.path()).subarray(0, 4).toString() === "%PDF", "receipt PDF downloads");

    await page.getByLabel("Email address").fill("copy@example.com");
    await page.getByRole("button", { name: "Email me this receipt" }).click();
    await page.getByText("Sent.").waitFor();
  });

  await step("dashboard: sign in, see the payment, refund part of it, receipt updates", async () => {
    await page.goto(`${WEB}/dashboard`);
    await page.getByLabel("Secret key").fill("sk_test_wrong");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("alert").getByText("wasn't recognised").waitFor();

    await page.getByLabel("Secret key").fill(secretKey!);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Home" }).waitFor();
    await page.getByText("Net after refunds").waitFor();
    await shot(page, "12-dashboard-home");

    await page.getByRole("link", { name: "Payments", exact: true }).click();
    await page.getByRole("link", { name: "500.00 USDT" }).click();
    await page.getByRole("heading", { name: "Onchain" }).waitFor();
    assert((await page.getByText("Relayer").count()) === 1, "gas shown as paid by the relayer");

    await page.getByLabel(/^Amount, up to/).fill("100.00");
    await page.getByLabel("Reason").selectOption("cancelled_item");
    await page.getByRole("button", { name: "Send refund" }).click();
    await page.getByRole("status").getByText("Refund sent").waitFor();
    await shot(page, "13-dashboard-refund");

    for (let i = 0; i < 30; i++) {
      await page.goto(receiptUrl);
      if ((await page.getByTestId("receipt-status").textContent()) === "Partially refunded") break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert((await page.getByTestId("receipt-status").textContent()) === "Partially refunded", "receipt shows refund");
    await page.getByText("Item cancelled").waitFor();
    await page.getByText("400.00 USDT").waitFor();
    await shot(page, "5-refund");
  });

  await step("gasless: a wallet with 0 WBT pays", async () => {
    const funded = customer;
    customer = gaslessPayer;
    assert((await reader.getBalance({ address: gaslessPayer.address })) === 0n, "payer has no gas");

    const session = await kit.checkout.sessions.create({ line_items: [lineItem("Icon Set", 2500)] });
    await page.goto(session.url);
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await page.getByText("No gas needed").waitFor();
    await page.getByRole("button", { name: "Pay 25.00 USDT" }).click();
    await page.getByTestId("paid").waitFor({ timeout: 30_000 });

    assert((await reader.getBalance({ address: gaslessPayer.address })) === 0n, "payer still has no gas");
    customer = funded;
  });

  await step("not enough USDT disables the pay button", async () => {
    const session = await kit.checkout.sessions.create({ line_items: [lineItem("Big Retainer", 900000)] });
    await page.goto(session.url);
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await page.getByRole("alert").getByText("doesn't have enough USDT").waitFor();
    assert(await page.getByRole("button", { name: "Pay 9000.00 USDT" }).isDisabled(), "pay disabled");
  });

  await step("one-line buy button opens a payment link and pays", async () => {
    const link = await kit.paymentLinks.create({ name: "Logo Pack", unit_amount: 4900, description: "Six logo files" });
    await page.goto(`${WEB}/`);
    await page.setContent(
      `<!doctype html><title>shop</title><h1>Shop</h1><script src="${WEB}/button.js" data-link="${link.code}"></script>`,
    );
    const button = page.getByRole("link", { name: "Pay with USDT" });
    await button.waitFor();
    await shot(page, "6-button");
    await button.click();

    await page.getByRole("heading", { name: "Logo Pack" }).waitFor();
    await shot(page, "7-link");
    await page.getByRole("button", { name: "Continue to payment" }).click();
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await page.getByRole("button", { name: "Pay 49.00 USDT" }).click();
    await page.getByTestId("paid").waitFor({ timeout: 30_000 });

    const rows = (await kit.paymentLinks.list()).data;
    assert(rows.find((row: any) => row.id === link.id).times_paid === 1, "link counted the payment");
  });

  await step("invoice paid in two parts, with both payments listed", async () => {
    const invoice = await kit.invoices.create({
      customer: { name: "Mark Rivera", email: "mark@example.com" },
      line_items: [
        { description: "Landing page design", quantity: 1, unit_amount: 50000 },
        { description: "Revision hours", quantity: 3, unit_amount: 10000 },
      ],
      due_date: Math.floor(Date.now() / 1000) + 14 * 86400,
      allow_partial: true,
      notes: "Thanks for working with PixelForge.",
    });
    const sent = await kit.invoices.send(invoice.id);
    await page.goto(sent.hosted_invoice_url);
    await page.getByTestId("remaining").waitFor();
    await shot(page, "8-invoice");

    const payPart = async (amount: string | null) => {
      if (amount) await page.getByLabel("Amount to pay (USDT)").fill(amount);
      await page.getByRole("button", { name: "Pay this invoice" }).click();
      await page.getByRole("button", { name: "Connect wallet" }).click();
      await page.getByRole("button", { name: /^Pay \d/ }).click();
    };

    await payPart("300.00");
    await page.getByText("Partially paid").waitFor({ timeout: 30_000 });
    await page.getByTestId("remaining").getByText("500.00 USDT").waitFor();

    await page.reload();
    await payPart(null);
    await page.locator(".badge.good", { hasText: "Paid" }).waitFor({ timeout: 30_000 });
    await page.getByRole("link", { name: "Receipt" }).nth(1).waitFor();
    await shot(page, "9-invoice-paid");

    const pdf = await fetch(`${API}/public/invoices/${invoice.id}/pdf`);
    assert(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString() === "%PDF", "pdf downloads");
    assert((await kit.invoices.retrieve(invoice.id)).status === "paid", "invoice paid");
  });

  let invoiceCreatedInDashboard = "";
  await step("dashboard: create and send an invoice", async () => {
    await page.goto(`${WEB}/dashboard/invoices/new`);
    await page.getByLabel("Customer name").fill("Acme Inc");
    await page.getByLabel("Description").fill("Website audit");
    await page.getByLabel("Unit price").fill("120.00");
    await page.getByRole("heading", { name: "Customer sees" }).waitFor();
    await page.getByText("120.00 USDT").first().waitFor();
    await shot(page, "14-dashboard-new-invoice");

    await page.getByRole("button", { name: "Save draft" }).click();
    await page.getByRole("button", { name: "Send invoice" }).click();
    await page.locator(".title .badge", { hasText: "Open" }).waitFor();
    invoiceCreatedInDashboard = page.url();
    assert(invoiceCreatedInDashboard.includes("/dashboard/invoices/in_"), "landed on the invoice");
  });

  await step("subscription: subscribe, automatic renewal, cancel from the portal", async () => {
    const session = await kit.checkout.sessions.create({
      mode: "subscription",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: 3000,
            product_data: { name: "Maintenance retainer" },
            recurring: { interval: "month" },
          },
        },
      ],
      settlekit_interval_seconds: 60,
    });
    await page.goto(session.url);
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await page.getByRole("button", { name: "Subscribe for 30.00 USDT" }).click();
    await page.getByTestId("subscribed").waitFor({ timeout: 30_000 });
    await shot(page, "15-subscribed");

    console.log("    waiting for the keeper to charge a renewal");
    let periods = 0;
    for (let i = 0; i < 90 && periods < 2; i++) {
      periods = (await kit.subscriptions.list()).data[0]?.periods_charged ?? 0;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert(periods >= 2, "keeper charged a renewal");

    await page.goto(`${WEB}/dashboard/subscriptions`);
    await page.getByText("Period 2").waitFor();
    await shot(page, "16-dashboard-subscriptions");

    await page.goto(`${WEB}/portal`);
    await page.getByRole("button", { name: "Sign in with wallet" }).click();
    await page.getByRole("button", { name: "Subscriptions" }).click();
    await page.getByRole("button", { name: "Check allowance" }).click();
    await page.getByText("allowance left").waitFor();
    await shot(page, "17-portal");
    await page.getByRole("button", { name: "Cancel subscription" }).click();

    let status = "";
    for (let i = 0; i < 30 && status !== "canceled"; i++) {
      status = (await kit.subscriptions.list()).data[0].status;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert(status === "canceled", "onchain cancel reached the dashboard");
  });

  await step("reports: export, reconcile, developer tools", async () => {
    await page.goto(`${WEB}/dashboard/reports`);
    await page.getByRole("heading", { name: "Reconciliation" }).waitFor();
    await shot(page, "18-dashboard-reports");

    const [csv] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Export CSV" }).click()]);
    const text = readFileSync(await csv.path(), "utf8");
    assert(text.includes("Date (UTC)") && text.includes("PF-1042") && text.includes("Summary"), "CSV has the ledger");

    const [xlsx] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Export XLSX" }).click()]);
    assert(readFileSync(await xlsx.path()).subarray(0, 2).toString() === "PK", "XLSX downloads");

    await page.goto(`${WEB}/dashboard/developers`);
    await page.getByRole("heading", { name: "Event log" }).waitFor();
    await page.getByLabel("Endpoint URL").fill("http://localhost:4242/webhook");
    await page.getByRole("button", { name: "Add endpoint" }).click();
    await page.getByRole("status").getByText("Signing secret").waitFor();
    await shot(page, "19-dashboard-developers");

    for (const path of ["customers", "refunds", "links", "settings", "invoices"]) {
      const response = await page.goto(`${WEB}/dashboard/${path}`);
      assert(response?.ok(), `/dashboard/${path} loads`);
    }
  });

  await step("email: outbox, reminders and magic link sign-in", async () => {
    const authed = { authorization: `Bearer ${secretKey}` };
    const emails = async () => (await (await fetch(`${API}/v1/emails`, { headers: authed })).json()).data;

    const receipt = (await emails()).find((email: any) => email.kind === "receipt" && email.to_address === "mark@example.com");
    assert(receipt?.status === "logged", "receipt went through the outbox");

    const invoice = await kit.invoices.create({
      customer: { name: "Mark Rivera", email: "mark@example.com" },
      line_items: [{ description: "Audit", quantity: 1, unit_amount: 10000 }],
      due_date: Math.floor(Date.now() / 1000) + 86_400,
    });
    await kit.invoices.send(invoice.id);

    await page.goto(`${WEB}/dashboard/invoices/${invoice.id}`);
    await page.getByRole("button", { name: "Send reminder now" }).click();
    await page.getByRole("status").getByText("Reminder sent").waitFor();
    await shot(page, "21-dashboard-reminder");

    await page.goto(`${WEB}/portal`);
    await page.getByLabel("Email address").fill("mark@example.com");
    await page.getByRole("button", { name: "Email me a link" }).click();
    await page.getByText("a sign-in link is on its way").waitFor();

    let link = "";
    for (let i = 0; i < 20 && !link; i++) {
      link = /http[^\s]+token=[^\s]+/.exec(apiOutput.join(""))?.[0] ?? "";
      if (!link) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert(link, "magic link was issued");
    assert(!(await emails()).some((email: any) => email.kind === "magic_link"), "merchants can't read sign-in links");
    await page.goto(link);
    await page.getByRole("button", { name: "Refunds" }).waitFor();
  });

  await step("PixelForge demo store sells with 20 lines or fewer", async () => {
    const storeDir = join(ROOT, "examples/pixelforge-store");
    const source = readFileSync(join(storeDir, "server.ts"), "utf8").replaceAll("\r\n", "\n");
    const integration = source.split("// SETTLEKIT INTEGRATION START\n")[1]!.split("// SETTLEKIT INTEGRATION END")[0]!;
    const lines = integration.split("\n").filter((line) => line.trim() !== "").length;
    console.log(`    integration lines: ${lines}`);

    const webhook = await fetch(`${API}/v1/webhook_endpoints`, {
      method: "POST",
      headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
      body: JSON.stringify({ url: "http://localhost:4300/webhooks", enabled_events: ["checkout.session.completed"] }),
    }).then((response) => response.json());
    const link = await kit.paymentLinks.create({ name: "Logo Pack", unit_amount: 4900 });

    start(process.execPath, [tsx, "server.ts"], {
      SETTLEKIT_SECRET_KEY: secretKey!,
      SETTLEKIT_WEBHOOK_SECRET: webhook.secret,
      SETTLEKIT_API_URL: API,
      SETTLEKIT_LINK: link.code,
      CHECKOUT_ORIGIN: WEB,
    }, storeDir);
    await waitFor("http://localhost:4300", "store");

    await page.goto("http://localhost:4300");
    await page.getByRole("link", { name: "Pay with USDT" }).waitFor();
    await shot(page, "22-pixelforge-store");
    await page.getByRole("button", { name: "Buy Brand Kit" }).click();
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await page.getByRole("button", { name: "Pay 500.00 USDT" }).click();
    await page.getByTestId("paid").waitFor({ timeout: 30_000 });

    let status = "";
    for (let i = 0; i < 30 && status !== "paid"; i++) {
      status = (await (await fetch("http://localhost:4300/orders/PF-1042")).json()).status;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert(status === "paid", "the store fulfilled the order from its webhook");
    assert(lines <= 20, `integration is ${lines} lines`);
  });

  await step("Stripe's official sample app runs with one changed line", async () => {
    const webhook = await fetch(`${API}/v1/webhook_endpoints`, {
      method: "POST",
      headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
      body: JSON.stringify({ url: "http://localhost:4242/webhook", enabled_events: ["checkout.session.completed"] }),
    }).then((response) => response.json());
    const price = await fetch(`${API}/v1/prices`, {
      method: "POST",
      headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
      body: JSON.stringify({ unit_amount: 2000, currency: "usd", product_data: { name: "Stubborn Attachments" } }),
    }).then((response) => response.json());

    const sampleDir = join(ROOT, "examples/stripe-sample");
    const logs: string[] = [];
    const sample = spawn(process.execPath, ["server.js"], {
      cwd: sampleDir,
      env: {
        ...process.env,
        STRIPE_SECRET_KEY: secretKey,
        STRIPE_PUBLISHABLE_KEY: "pk_test_unused",
        STRIPE_WEBHOOK_SECRET: webhook.secret,
        PRICE: price.id,
        DOMAIN: "http://localhost:4242",
        STATIC_DIR: join(sampleDir, "client"),
        SETTLEKIT_HOST: "localhost",
        SETTLEKIT_PORT: String(API_PORT),
        SETTLEKIT_PROTOCOL: "http",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    processes.push(sample);
    sample.stdout.on("data", (chunk) => logs.push(String(chunk)));
    await waitFor("http://localhost:4242", "sample");

    await page.goto("http://localhost:4242");
    await page.getByRole("button", { name: /Buy/ }).click();
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await page.getByRole("button", { name: "Pay 20.00 USDT" }).click();
    await page.getByTestId("paid").waitFor({ timeout: 30_000 });
    await page.getByRole("link", { name: /Return to/ }).click();
    await page.waitForURL(/success\.html\?session_id=cs_/);
    await page.getByText("cs_").first().waitFor();
    await shot(page, "20-stripe-sample-success");

    for (let i = 0; i < 30 && !logs.join("").includes("Payment received"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert(logs.join("").includes("Payment received"), "the sample verified and handled the webhook");
  });

  await step("checkout fits a phone screen with no sideways scroll", async () => {
    const session = await kit.checkout.sessions.create({ line_items: [lineItem("Brand Kit", 50000)] });
    await page.setViewportSize({ width: 375, height: 700 });
    await page.goto(session.url);
    await page.getByRole("button", { name: "Connect wallet" }).waitFor();
    await shot(page, "10-mobile");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 0, `page overflows by ${overflow}px`);

    await page.goto(receiptUrl);
    await page.getByTestId("receipt-status").waitFor();
    await shot(page, "11-mobile-receipt");
    const receiptOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(receiptOverflow <= 0, `receipt overflows by ${receiptOverflow}px`);
  });

  await browser.close();
  console.log(`\n${results.length} scenarios passed. Screenshots in ${OUT}`);
}

async function createTestFunds() {
  await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [customer.address, "0xde0b6b3a7640000"] }),
  });
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  for (const child of processes) child.kill();
}
process.exit(failed ? 1 : 0);
