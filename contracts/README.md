# SettleKit contracts

```sh
forge test
forge test --match-path test/RealUsdt.fork.t.sol --fork-url $WHITECHAIN_RPC_URL
forge script script/Deploy.s.sol --rpc-url $WHITECHAIN_RPC_URL --broadcast
```

The fork test is skipped unless it runs against chain 1874.

## Where these differ from the PRD

| PRD | Built | Why |
| --- | --- | --- |
| `payWithPermit(..., permitV, permitR, permitS)` | Also takes `payer` and `payerSig`, an EIP-712 `PaymentAuthorization` over the intent | A permit names a spender but no order. Without this, anyone could copy a permit from the mempool and spend it on their own intent |
| `registerMerchant(payout, refundOperator)` | `registerMerchant(payout, refundWallet, refundOperator)` | Refunds are pulled from a refund wallet, which the original signature had no way to set |
| Invoices accept repeat payments on one intent | One intent per payment, linked by `payments.invoice_id` | Keeps `AlreadyPaid` simple and gives each payment its own refund cap |
| Late payments accepted, yet `IntentExpired` exists | The signed deadline is `expires_at` plus a grace window | Payments inside the window settle and the indexer flags them `late_settlement`. After it, the contract reverts |
| `charge(subId)` keeper-callable | Keeper-only, not public | Funds were never at risk, but anyone could emit `ChargeFailed` and push a healthy subscription to `past_due` |

## Behaviour the backend relies on

- `subscribe` charges the first period immediately, and `charge` handles later periods.
- A renewal that recovers after missed periods bills once and does not catch up.
- `MIN_INTERVAL` is 60 seconds so a renewal can be shown live on testnet. The API should only offer weekly and monthly.
- `cancel` still works while the contract is paused.
- Refund reason codes: 0 `requested_by_customer`, 1 `duplicate`, 2 `cancelled_item`, 3 `other`.
