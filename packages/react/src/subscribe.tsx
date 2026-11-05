"use client";

import { useEffect, useState } from "react";
import { type Address, createPublicClient, createWalletClient, custom, http, parseAbi } from "viem";
import { formatUsdt, friendlyError, isOnChain, money, shorten, styles, usdtAbi, useWallet } from "./shared.tsx";

const POLL_MS = 1_000;
/** With no end date, approve a year of renewals. The customer can lower this from the portal. */
const OPEN_ENDED_PERIODS = 12n;

const subscriptionsAbi = parseAbi([
  "function subscribe(address merchant, uint256 amount, uint32 interval, uint32 maxPeriods) returns (uint256)",
]);

export type SubscribeParams = {
  chain_id: number;
  rpc_url: string;
  explorer_url: string;
  contract: Address;
  token: Address;
  merchant: Address;
  amount: string;
  interval_seconds: number;
  max_periods: number;
};

export function SettleSubscribe({
  sessionId,
  params,
  amount,
  brandColor,
  apiUrl = "https://api.settlekit.dev",
  onSuccess,
}: {
  sessionId: string;
  params: SubscribeParams;
  amount: number;
  brandColor?: string | null;
  apiUrl?: string;
  onSuccess?: () => void;
}) {
  const reader = createPublicClient({ transport: http(params.rpc_url) });
  const [balance, setBalance] = useState<bigint>();
  const [progress, setProgress] = useState<"idle" | "approving" | "subscribing" | "processing" | "active">("idle");
  const [txHash, setTxHash] = useState<string>();

  const wallet = useWallet(params, async (address) => {
    setBalance(
      await reader.readContract({ address: params.token, abi: usdtAbi, functionName: "balanceOf", args: [address] }),
    );
  });
  const { account, phase, setPhase, error, setError } = wallet;

  const processing = progress === "processing";
  useEffect(() => {
    if (!processing) return;
    const timer = setInterval(async () => {
      const response = await fetch(`${apiUrl}/public/checkout/${sessionId}`, { cache: "no-store" }).catch(() => null);
      const session = await response?.json().catch(() => null);
      if (session?.status === "complete") {
        setProgress("active");
        onSuccess?.();
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [processing, apiUrl, sessionId, onSuccess]);

  const submit = async () => {
    if (!account) return;
    setError(undefined);
    const perPeriod = BigInt(params.amount);
    const periods = params.max_periods > 0 ? BigInt(params.max_periods) : OPEN_ENDED_PERIODS;
    const client = createWalletClient({ account, transport: custom(window.ethereum!) });

    try {
      if (!(await isOnChain(params.chain_id))) return setPhase("wrong_network");

      const allowance = await reader.readContract({
        address: params.token,
        abi: usdtAbi,
        functionName: "allowance",
        args: [account, params.contract],
      });
      if (allowance < perPeriod * periods) {
        setProgress("approving");
        const hash = await client.writeContract({
          chain: null,
          address: params.token,
          abi: usdtAbi,
          functionName: "approve",
          args: [params.contract, perPeriod * periods],
        });
        await reader.waitForTransactionReceipt({ hash });
      }

      setProgress("subscribing");
      const hash = await client.writeContract({
        chain: null,
        address: params.contract,
        abi: subscriptionsAbi,
        functionName: "subscribe",
        args: [params.merchant, perPeriod, params.interval_seconds, params.max_periods],
      });
      setTxHash(hash);
      setProgress("processing");
      await fetch(`${apiUrl}/public/checkout/${sessionId}/subscribed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tx_hash: hash }),
      });
    } catch (cause) {
      setError(friendlyError(cause));
      setProgress("idle");
    }
  };

  if (progress === "active") {
    return (
      <div style={styles.box} data-testid="subscribed">
        <strong>Subscribed</strong>
        <p style={styles.note}>You paid the first {money(amount)} USDT. You can cancel anytime from your portal.</p>
      </div>
    );
  }

  const brand = brandColor ?? "#1c1917";
  const shortfall = balance !== undefined && balance < BigInt(params.amount);
  const working = progress === "approving" || progress === "subscribing";

  return (
    <div style={styles.box}>
      {account && (
        <div style={styles.row}>
          <span>Wallet {shorten(account)}</span>
          {balance !== undefined && <span>{formatUsdt(balance)} USDT</span>}
        </div>
      )}
      <p style={styles.note}>
        You'll pay {money(amount)} USDT now, and the same amount each period until you cancel. Starting a subscription
        needs a small WBT gas fee.
      </p>

      {error && (
        <div role="alert" style={styles.error}>
          {error}
        </div>
      )}
      {shortfall && phase === "ready" && (
        <div role="alert" style={styles.error}>
          This wallet doesn't have enough USDT to subscribe.
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
      {phase === "ready" && !processing && (
        <button style={styles.button(brand, working || shortfall)} disabled={working || shortfall} onClick={submit}>
          {progress === "approving"
            ? "Approve in your wallet…"
            : progress === "subscribing"
              ? "Confirm in your wallet…"
              : `Subscribe for ${money(amount)} USDT`}
        </button>
      )}
      {processing && txHash && (
        <p style={styles.note}>
          Starting your subscription…{" "}
          <a href={`${params.explorer_url}/tx/${txHash}`} target="_blank" rel="noreferrer">
            View transaction
          </a>
        </p>
      )}
    </div>
  );
}
