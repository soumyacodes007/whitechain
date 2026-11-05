# SettleKit

Stripe-compatible USDT payments for businesses. Change one line, settle in seconds on Whitechain.

SettleKit lets an online business get paid in USDT and handle everything after the payment: refunds, invoice reminders, subscription renewals and accountant exports. It's built for cases like an Indian design studio billing US clients, where a wire costs $45 and takes days.

## Why onchain

SettleKit needs onchain USDT settlement on Whitechain because a client anywhere can pay a merchant in seconds for a fraction of a cent in gas, and every payment, partial refund and renewal leaves a public, verifiable receipt tied to the original order. Card and bank rails can't give cross-border businesses instant final settlement, a customer-checkable refund record, or reconciliation straight from the ledger, and they exclude merchants in countries where Stripe or PayPal are unavailable.

## See it on the chain

Everything below ran on Whitechain Sepolia (chain 1874) in USDT `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`, through the real API and indexer.

| What | Link |
| --- | --- |
| SettleKitPayments, verified | [0xD59E...299d](https://explorer.testnet.whitechain.io/address/0xD59EDe989E27d8CaAEebb8305897d51d61Dc299d) |
| SettleKitSubscriptions, verified | [0x5C64...1aD6](https://explorer.testnet.whitechain.io/address/0x5C648cc785526432bec6d6B3C5Fb729cA6311aD6) |
| Payment | [0xfab4...befd](https://explorer.testnet.whitechain.io/tx/0xfab4cb9801a543080d1b19773d315199b019e00fdb3422ee157fc22ce845befd) |
| Partial refund | [0xc8c9...78cc](https://explorer.testnet.whitechain.io/tx/0xc8c9369f19b02fd04fbe73f1d34a3276d10733b44b0cc0cf3ce4b2039d3c78cc) |
| Gasless payment from a wallet with 0 WBT | [0xb033...aa8d](https://explorer.testnet.whitechain.io/tx/0xb033f169ff6149a6d896302fb4a36c401d54b7c77cf433bb0aa8c0195c9daa8d) |
| Refund sent through the API | [0xa0d6...eeaf](https://explorer.testnet.whitechain.io/tx/0xa0d6eb5f479c9553f5500b303dd90674b878753e6b9a885989086507bc07eeaf) |
| Subscribe, with the first charge | [0x45d2...a1db](https://explorer.testnet.whitechain.io/tx/0x45d2d15eb610cf506992317889589e3e770324504f9a6e771229c93df94fa1db) |
| Renewal charged by the keeper | [0x0614...6793](https://explorer.testnet.whitechain.io/tx/0x06141a4605cc07df22dbc4a5014f10d9271f2545d678a7959837b25ad4736793) |
| Customer cancels onchain | [0x1b78...8e56](https://explorer.testnet.whitechain.io/tx/0x1b781366cd9207132454f1191a4e38978248fe4114423cb858c497850d8e8e56) |

## Four ways to integrate

**1. Buy button.** One line of HTML, no backend. The price stays in the payment link, so a buyer can't edit it.

```html
<script src="https://cdn.settlekit.dev/button.js" data-link="plink_7Hk2"></script>
```

**2. React component.**

```jsx
import { SettleCheckout } from "@settlekit/react";

<SettleCheckout clientSecret={intent.client_secret} onSuccess={(r) => router.push(`/thanks?tx=${r.txHash}`)} />;
```

**3. Server SDK and webhooks.** [`examples/pixelforge-store`](examples/pixelforge-store/server.ts) sells with 20 lines of integration, and a test keeps it there.

```js
const kit = new SettleKit(process.env.SETTLEKIT_SECRET_KEY);
const session = await kit.checkout.sessions.create({ line_items, metadata: { orderId } });
const event = kit.webhooks.constructEvent(rawBody, req.headers["settlekit-signature"], secret);
```

**4. Stripe-compatible API.** Keep your code and the official `stripe` package.

```js
const stripe = new Stripe(process.env.SETTLEKIT_SECRET_KEY, {
  host: "api.settlekit.dev", // the one changed line
});
```

[`examples/stripe-sample`](examples/stripe-sample) is Stripe's official Checkout sample with one added line. Running locally also needs a port and protocol, so that line sets all three.

| Stripe endpoint | Supported |
| --- | --- |
| Checkout Sessions, in `payment` and `subscription` mode | Yes |
| Payment Intents: create, get, cancel | Yes |
| Refunds, full and partial | Yes |
| Customers, Products, fixed Prices | Yes |
| Subscriptions: get, cancel | Yes |
| Events, and `Stripe-Signature` webhooks | Yes |
| Cards, payment methods, disputes, Connect, tax, coupons | No. Returns `unsupported_on_settlekit` |

## Architecture

The contracts are the source of truth. Every service reads from or writes to them, and a merchant only ever sees the API and signed webhooks.

```mermaid
flowchart LR
  customer[Customer wallet] -->|pays or signs| checkout[Hosted checkout]
  checkout -->|gasless| relayer[Relayer]
  checkout -->|direct| payments
  relayer --> payments[SettleKitPayments]
  keeper[Keeper] --> subs[SettleKitSubscriptions]
  payments -->|USDT| payout[Merchant wallet]
  subs -->|USDT| payout
  payments -->|events| indexer[Indexer]
  subs -->|events| indexer
  indexer --> db[(Postgres)]
  db --> dispatcher[Webhook dispatcher]
  db --> outbox[Email outbox]
  dispatcher -->|signed webhooks| merchant[Merchant server]
  merchant -->|REST or stripe package| api[API]
  api --> db
```

- **Non-custodial.** USDT moves straight from the payer to the merchant's wallet. The contracts never hold funds.
- **Tamper-proof amounts.** SettleKit signs each intent, so a price can't be changed in the browser.
- **Bound signatures.** A gasless payment needs a permit and a signature over the exact order, so a permit copied from the mempool can't be spent on someone else's order.
- **No duplicate fulfilment.** Event ids come from `chainId:txHash:logIndex:type`, so one log can't produce two events.
- **Reorg handling.** Events fire after two confirmations, and each indexer pass rescans the last 20 blocks.
- **Capped subscriptions.** The amount and interval are fixed onchain, so a compromised keeper can't overcharge.

| Path | What it is |
| --- | --- |
| `contracts/` | Foundry project, deploy script, deployed addresses |
| `apps/api/` | REST and Stripe-compatible API, indexer, dispatcher, relayer, keeper |
| `apps/web/` | Checkout, invoices, receipts, customer portal, merchant dashboard |
| `packages/node`, `packages/react`, `packages/button` | The SDKs and the buy button |
| `examples/` | PixelForge demo store, and Stripe's sample |
| `WHITECHAIN_FEEDBACK.md` | Running notes on building on Whitechain |

## Setup

You need Node 24 and [Foundry](https://getfoundry.sh). Docker is optional.

```sh
git clone https://github.com/soumyacodes007/whitechain.git
cd whitechain
git submodule update --init
npm install
cp .env.example .env
```

Set `DEPLOYER_PRIVATE_KEY` in `.env` to a test wallet funded from the [faucet](https://faucet.testnet.whitechain.io). It signs intents, and sends refunds, gasless payments and renewals. The contracts are already deployed, so you only need to deploy your own if you want to change them.

Create a merchant, then start the API and web app in two terminals:

```sh
npm run seed -w @settlekit/api    # prints your secret key once
npm run dev:api                   # http://localhost:4000
npm run dev:web                   # http://localhost:3000
```

The merchant wallet also has to be registered onchain, and must approve the Payments contract if it will issue refunds. `apps/api/scripts/live-payment.ts` does this and runs a real payment.

Sign in at `http://localhost:3000/dashboard` with the secret key. Customers use `/portal`.

The API uses embedded Postgres by default, stored in `apps/api/data`. To use a server, run `docker compose up -d` and set `DATABASE_URL=postgres://settlekit:settlekit@localhost:55433/settlekit`. Add `RESEND_API_KEY` to send real email. Without one, emails print to the API console and show as logged in the dashboard.

## Tests

```sh
(cd contracts && forge test)     # 30 contract tests, including stolen permit attacks
npm test -w @settlekit/api       # 86 tests against real contracts on a local chain
npm test -w @settlekit/node      # 7 SDK tests
npm run build -w @settlekit/web
npm run e2e -w @settlekit/web    # 13 flows in real Chrome
```

The API tests need `forge build` to have run. The Stripe tests use the official `stripe` package. Set `TEST_DATABASE_URL` to run the API tests on a Postgres server instead of embedded Postgres; they pass on PostgreSQL 17.

`forge test --match-path test/RealUsdt.fork.t.sol --fork-url $WHITECHAIN_RPC_URL` runs gasless payment against the real test USDT.

## Results against the targets

| Metric | Target | Result |
| --- | --- | --- |
| Lines for the demo store to integrate | 20 or fewer | 20, enforced by a test |
| Lines for the no-code button | 1 | 1 |
| Lines changed to migrate Stripe's sample | 1 | 1 |
| Customer click to payment confirmed | Under 15 s | 3.4 to 4.4 s in a local browser test with 1 s blocks |
| Real payment, refund and renewal with explorer links | At least 1 each | Done, see above |
| Duplicate fulfilments in webhook tests | None | None |

On the live chain, a payment was indexed as succeeded 2.6 seconds after its transaction confirmed.

## Limitations

- Testnet only. Test USDT and WBT have no value.
- Only a subset of Stripe's API is supported, as listed above.
- USDT is treated as 1:1 with USD, with no conversion to INR or other local currencies.
- There's no fiat off-ramp, so merchants hold USDT.
- The relayer, indexer and keeper are centralised services run by SettleKit.
- One operator wallet sends refunds, gasless payments and renewals. It pays gas but can't redirect funds, and network fees show as 0 in reports for that reason.
- Starting a subscription needs WBT, because the contract has no permit route. Renewals don't need the customer to hold gas.
- Merchant cancellation stops the keeper, but only the customer can close the onchain mandate. No charge can happen either way.
- Two checkouts open on the same invoice can both be paid, because the contract can't see invoices. Reconciliation flags the overpayment.
- Checkout supports browser wallets. WalletConnect isn't built.
- Team roles and publishable API keys aren't built, and `SETTLEKIT_SECRET_KEY` is the only dashboard login.
- `api.settlekit.dev` and `cdn.settlekit.dev` are placeholders, and the packages aren't published to npm.
