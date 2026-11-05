"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  custom,
  type Hex,
  http,
  parseAbi,
  parseSignature,
} from "viem";
import { formatUsdt, friendlyError, isOnChain, money, shorten, styles, usdtAbi, useWallet } from "./shared.tsx";

export { SettleSubscribe } from "./subscribe.tsx";
export { friendlyError, isOnChain, switchToChain, usdtAbi } from "./shared.tsx";

const POLL_MS = 1_000;

const paymentsAbi = parseAbi([
  "function pay(bytes32 intentId, address merchant, uint256 amount, uint256 deadline, bytes sig)",
  "error AlreadyPaid()",
  "error IntentExpired()",
]);

type PayParams = {
  chain_id: number;
  rpc_url: string;
  explorer_url: string;
  contract: Address;
  token: Address;
  intent_id: Hex;
  merchant: Address;
  amount: string;
  deadline: string;
  signature: Hex;
  gasless: boolean;
  permit_domain: { name: string; version: string };
};

export type PublicIntent = {
  id: string;
  status: string;
  amount: number;
  expired: boolean;
  merchant: { name: string; brand_color: string | null };
  payment_id: string | null;
  tx_hash: string | null;
  explorer_url: string | null;
  pay: PayParams;
};

export type PaymentResult = { txHash: string; paymentId: string; explorerUrl: string | null };

type Progress =
  | { name: "idle" }
  | { name: "signing" }
  | { name: "approving" }
  | { name: "paying" }
  | { name: "processing"; txHash: string }
  | { name: "paid"; result: PaymentResult };

export function SettleCheckout({
  clientSecret,
  apiUrl = "https://api.settlekit.dev",
  onSuccess,
}: {
  clientSecret: string;
  apiUrl?: string;
  onSuccess?: (result: PaymentResult) => void;
}) {
  const [intent, setIntent] = useState<PublicIntent>();
  const [progress, setProgress] = useState<Progress>({ name: "idle" });
  const [balance, setBalance] = useState<bigint>();
  const notified = useRef(false);

  const pay = intent?.pay;
  const reader = pay ? createPublicClient({ transport: http(pay.rpc_url) }) : undefined;

  const wallet = useWallet(pay, async (address) => {
    const value = await reader!.readContract({
      address: pay!.token,
      abi: usdtAbi,
      functionName: "balanceOf",
      args: [address],
    });
    setBalance(value);
  });
  const { account, phase, setPhase, error, setError } = wallet;

  const load = useCallback(async () => {
    const response = await fetch(`${apiUrl}/public/payment_intents/${clientSecret}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Couldn't load this payment");
    const next = (await response.json()) as PublicIntent;
    setIntent(next);
    return next;
  }, [apiUrl, clientSecret]);

  useEffect(() => {
    load().catch(() => setError("We couldn't load this payment. Please refresh."));
  }, [load, setError]);

  useEffect(() => {
    if (!intent || intent.status !== "succeeded" || !intent.tx_hash || !intent.payment_id) return;
    const result = { txHash: intent.tx_hash, paymentId: intent.payment_id, explorerUrl: intent.explorer_url };
    setProgress({ name: "paid", result });
    if (!notified.current) {
      notified.current = true;
      onSuccess?.(result);
    }
  }, [intent, onSuccess]);

  const waitingForConfirmation = progress.name === "processing";
  useEffect(() => {
    if (!waitingForConfirmation) return;
    const timer = setInterval(() => void load().catch(() => {}), POLL_MS);
    return () => clearInterval(timer);
  }, [waitingForConfirmation, load]);

  /** Signs a permit and a payment message, and SettleKit's relayer pays the gas. */
  async function payGasless(address: Address, params: PayParams) {
    const client = createWalletClient({ account: address, transport: custom(window.ethereum!) });
    const amount = BigInt(params.amount);
    const deadline = BigInt(params.deadline);
    const nonce = await reader!.readContract({
      address: params.token,
      abi: usdtAbi,
      functionName: "nonces",
      args: [address],
    });

    setProgress({ name: "signing" });
    const permit = parseSignature(
      await client.signTypedData({
        domain: { ...params.permit_domain, chainId: params.chain_id, verifyingContract: params.token },
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
        message: { owner: address, spender: params.contract, value: amount, nonce, deadline },
      }),
    );
    const payerSignature = await client.signTypedData({
      domain: { name: "SettleKitPayments", version: "1", chainId: params.chain_id, verifyingContract: params.contract },
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
      message: { intentId: params.intent_id, merchant: params.merchant, amount, deadline, payer: address },
    });

    setProgress({ name: "paying" });
    const response = await fetch(`${apiUrl}/public/payment_intents/${clientSecret}/relay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payer: address,
        payer_signature: payerSignature,
        permit: {
          deadline: deadline.toString(),
          v: Number(permit.v ?? BigInt(permit.yParity + 27)),
          r: permit.r,
          s: permit.s,
        },
      }),
    });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error?.message ?? "Relay failed");
    setProgress({ name: "processing", txHash: json.tx_hash });
  }

  async function payDirectly(address: Address, params: PayParams) {
    const amount = BigInt(params.amount);
    const client = createWalletClient({ account: address, transport: custom(window.ethereum!) });

    const allowance = await reader!.readContract({
      address: params.token,
      abi: usdtAbi,
      functionName: "allowance",
      args: [address, params.contract],
    });
    if (allowance < amount) {
      setProgress({ name: "approving" });
      const hash = await client.writeContract({
        chain: null,
        address: params.token,
        abi: usdtAbi,
        functionName: "approve",
        args: [params.contract, amount],
      });
      await reader!.waitForTransactionReceipt({ hash });
    }

    const payment = {
      address: params.contract,
      abi: paymentsAbi,
      functionName: "pay",
      args: [params.intent_id, params.merchant, amount, BigInt(params.deadline), params.signature],
    } as const;

    // Simulating first means a doomed payment gets a clear message instead of costing gas.
    await reader!.simulateContract({ ...payment, account: address });

    setProgress({ name: "paying" });
    const hash = await client.writeContract({ ...payment, chain: null });
    setProgress({ name: "processing", txHash: hash });
  }

  const submit = async () => {
    if (!pay || !account) return;
    setError(undefined);
    try {
      if (!(await isOnChain(pay.chain_id))) return setPhase("wrong_network");
      await (pay.gasless ? payGasless(account, pay) : payDirectly(account, pay));
    } catch (cause) {
      setError(friendlyError(cause));
      setProgress({ name: "idle" });
    }
  };

  if (!intent) return <div style={styles.box}>{error ? <div style={styles.error}>{error}</div> : "Loading…"}</div>;

  const brand = intent.merchant.brand_color ?? "#1c1917";

  if (progress.name === "paid") {
    return (
      <div style={styles.box} data-testid="paid">
        <strong>Paid {money(intent.amount)} USDT</strong>
        {progress.result.explorerUrl && (
          <a href={progress.result.explorerUrl} target="_blank" rel="noreferrer">
            View on Whitechain explorer
          </a>
        )}
      </div>
    );
  }

  if (intent.expired && phase === "connect") {
    return <div style={styles.error}>This checkout expired. Return to the store and try again.</div>;
  }

  const shortfall = balance !== undefined && balance < BigInt(intent.pay.amount);
  const working = ["signing", "approving", "paying"].includes(progress.name);
  const label =
    progress.name === "signing"
      ? "Sign in your wallet…"
      : progress.name === "approving"
        ? "Approve in your wallet…"
        : progress.name === "paying"
          ? intent.pay.gasless
            ? "Sending your payment…"
            : "Confirm in your wallet…"
          : `Pay ${money(intent.amount)} USDT`;

  return (
    <div style={styles.box}>
      {account && (
        <div style={styles.row}>
          <span>Wallet {shorten(account)}</span>
          {balance !== undefined && <span>{formatUsdt(balance)} USDT</span>}
        </div>
      )}
      {account && intent.pay.gasless && <p style={styles.note}>No gas needed. You only sign.</p>}

      {error && (
        <div role="alert" style={styles.error}>
          {error}
        </div>
      )}
      {shortfall && phase === "ready" && (
        <div role="alert" style={styles.error}>
          This wallet doesn't have enough USDT to pay {money(intent.amount)} USDT.
        </div>
      )}

      {phase === "connect" && (
        <button style={styles.button(brand, false)} onClick={wallet.connect}>
          Connect wallet
        </button>
      )}
      {phase === "wrong_network" && (
        <button style={styles.button(brand, false)} onClick={wallet.switchNetwork}>
          Switch to Whitechain
        </button>
      )}
      {phase === "ready" && progress.name !== "processing" && (
        <button style={styles.button(brand, working || shortfall)} disabled={working || shortfall} onClick={submit}>
          {label}
        </button>
      )}
      {progress.name === "processing" && (
        <p style={styles.note} data-testid="processing">
          Processing your payment…{" "}
          <a href={`${intent.pay.explorer_url}/tx/${progress.txHash}`} target="_blank" rel="noreferrer">
            View transaction
          </a>
        </p>
      )}
    </div>
  );
}
