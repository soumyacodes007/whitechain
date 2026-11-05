# Stripe sample on SettleKit

This is Stripe's official [checkout-one-time-payments](https://github.com/stripe-samples/checkout-one-time-payments)
Node sample, unchanged except for the one line marked in `server.js`. It keeps using the official `stripe` package.

`npm run e2e -w @settlekit/web` buys through it in Chrome and checks that its webhook handler runs.
