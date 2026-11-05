import { type Address, createWalletClient, type Hex, http, parseAbi, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Config } from "./config.ts";

const paymentsAbi = parseAbi([
  "struct PermitSignature { uint256 deadline; uint8 v; bytes32 r; bytes32 s; }",
  "function merchants(address) view returns (address payout, address refundWallet, address refundOperator)",
  "function refund(bytes32 intentId, uint256 amount, uint8 reasonCode)",
  "function payWithPermit(bytes32 intentId, address merchant, uint256 amount, uint256 deadline, bytes sig, address payer, bytes payerSig, PermitSignature permit)",
  "error AlreadyPaid()",
  "error IntentExpired()",
  "error BadSignature()",
  "error RefundExceedsPaid()",
  "error NotAuthorised()",
  "error MerchantNotRegistered()",
]);
const usdtAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
]);
export const subscriptionsAbi = parseAbi([
  "function charge(uint256 subId)",
  "function subscriptions(uint256) view returns (address customer, uint96 amount, address merchant, uint32 interval, uint32 maxPeriods, uint32 periodsCharged, uint40 nextChargeAt, bool active)",
  "error NotActive()",
  "error NotDue()",
  "error NotAuthorised()",
]);

export type RelayRequest = {
  intentId: Hex;
  merchant: Address;
  amount: bigint;
  deadline: bigint;
  signature: Hex;
  payer: Address;
  payerSignature: Hex;
  permit: { deadline: bigint; v: number; r: Hex; s: Hex };
};

export type ChainWriter = ReturnType<typeof createChainWriter>;

/** Sends SettleKit's own transactions: refunds, gasless payments and renewals. */
export function createChainWriter(client: PublicClient, config: Config) {
  const account = privateKeyToAccount(config.operatorKey);
  const wallet = createWalletClient({
    account,
    chain: {
      id: config.chainId,
      name: "whitechain",
      nativeCurrency: { name: "WBT", symbol: "WBT", decimals: 18 },
      rpcUrls: { default: { http: [config.rpcUrl] } },
    },
    transport: http(config.rpcUrl),
  });

  // One key sends everything, so transactions go one at a time or they would collide on nonces.
  let queue: Promise<unknown> = Promise.resolve();
  const inOrder = <T>(send: () => Promise<T>) => {
    const result = queue.then(send, send);
    queue = result.catch(() => {});
    return result;
  };

  const payments = { address: config.paymentsAddress, abi: paymentsAbi } as const;

  return {
    operator: account.address,

    /** What a refund needs: USDT in the refund wallet, an allowance, and gas for the operator. */
    async refundFunding(refundWallet: Address) {
      const usdt = { address: config.usdtAddress, abi: usdtAbi } as const;
      const [balance, allowance, gas] = await Promise.all([
        client.readContract({ ...usdt, functionName: "balanceOf", args: [refundWallet] }),
        client.readContract({ ...usdt, functionName: "allowance", args: [refundWallet, config.paymentsAddress] }),
        client.getBalance({ address: account.address }),
      ]);
      return { balance, allowance, gas };
    },

    refund: (intentId: Hex, amount: bigint, reasonCode: number) =>
      inOrder(() => wallet.writeContract({ ...payments, functionName: "refund", args: [intentId, amount, reasonCode] })),

    relay: (request: RelayRequest) =>
      inOrder(() =>
        wallet.writeContract({
          ...payments,
          functionName: "payWithPermit",
          args: [
            request.intentId,
            request.merchant,
            request.amount,
            request.deadline,
            request.signature,
            request.payer,
            request.payerSignature,
            request.permit,
          ],
        }),
      ),

    charge: (subId: bigint) =>
      inOrder(() =>
        wallet.writeContract({
          address: config.subscriptionsAddress,
          abi: subscriptionsAbi,
          functionName: "charge",
          args: [subId],
        }),
      ),
  };
}
