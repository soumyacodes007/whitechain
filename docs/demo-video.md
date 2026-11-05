# Demo video guide

The track asks for 2 to 4 minutes showing each party. This follows the PRD's story of PixelForge Studio, and runs about 3.5 minutes.

## Before recording

1. Install MetaMask, add Whitechain Sepolia (chain 1874, RPC `https://rpc.testnet.whitechain.io`), and import the customer wallet. Its key is `CUSTOMER_PRIVATE_KEY` in `.env`.
2. For the "no gas" moment, also import `GASLESS_PRIVATE_KEY`. That wallet has USDT and 0 WBT.
3. Start everything:
   ```sh
   npm run dev:api
   npm run dev:web
   npm start -w pixelforge-store
   ```
   The store needs `SETTLEKIT_SECRET_KEY`, `SETTLEKIT_API_URL=http://localhost:4000`, and a `SETTLEKIT_WEBHOOK_SECRET` from an endpoint added in Developers. Set `SETTLEKIT_LINK` and `CHECKOUT_ORIGIN=http://localhost:3000` to show the one-line button.
4. In Settings, set the brand colour and logo. Have an explorer tab ready.
5. Do a full run first. Real MetaMask hasn't been tested yet, and this is the time to find any surprises.

## Script

| Time | Who | Show | Say |
| --- | --- | --- | --- |
| 0:00 | Problem | A slide or text | A wire from New York to Bengaluru costs $45 and takes 3 to 5 days, and Stripe is limited for Indian freelancers. |
| 0:20 | Developer | The buy button on the store, then the one-line diff in `examples/stripe-sample/server.js` | One line of HTML for a button. One changed line moves an existing Stripe integration. |
| 0:50 | Customer | Buy Brand Kit, sign, Paid, then the receipt and its explorer link | No gas needed. Signed, settled, and the receipt can be checked without us. |
| 1:10 | Merchant | Split screen: the dashboard updates, and the store's order page shows paid | The agency's site got the webhook and fulfilled the order. |
| 1:30 | Merchant | Create an $800 invoice with 3 line items, due in 14 days, and send it | Invoices have numbers, due dates and late fees. |
| 1:45 | Customer | Open the invoice and pay it | Reminders go out automatically before and after the due date. |
| 2:10 | Merchant | Refund $100 from the payment page | One line item was cancelled, so it's a one-click partial refund. |
| 2:25 | Customer | Reload the receipt to show the refund and its own explorer link | The customer can verify the refund too. |
| 2:40 | Customer | Subscribe to the retainer, show a renewal, then Cancel in the portal | Renewals are capped onchain, and customers can cancel anytime. |
| 3:05 | Accountant | Reports, Export XLSX, open in Excel | Gross, refunds and net, matched to invoice numbers. |
| 3:25 | Close | The explorer | Read the "why onchain" line from the README. |

Show at least two edge cases, as the PRD asks. Good ones are rejecting a signature in the wallet, which shows a clear message, and the reconciliation table flagging USDT sent directly to the wallet.

For a quick renewal on camera, create the subscription with `settlekit_interval_seconds: 60` through the SDK, so a charge lands a minute later.

## Before submitting

- Make the explorer links in the README open correctly.
- Check that `WHITECHAIN_FEEDBACK.md` is up to date.
- Collect the 5 to 10 Reddit validation replies the PRD lists.
