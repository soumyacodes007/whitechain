"use client";

import { type CSSProperties, useState } from "react";
import { type Address, BaseError, type EIP1193Provider, formatUnits, parseAbi } from "viem";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

const CHAIN_NOT_ADDED = 4902;
const USER_REJECTED = 4001;

export const usdtAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function nonces(address) view returns (uint256)",
]);

export const money = (cents: number) => (cents / 100).toFixed(2);
export const shorten = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;

export const styles = {
  box: { display: "grid", gap: 12, font: "15px/1.5 system-ui, sans-serif", color: "#1c1917" } as CSSProperties,
  button: (color: string, disabled: boolean): CSSProperties => ({
    padding: "13px 18px",
    border: 0,
    borderRadius: 8,
    background: color,
    color: "#fff",
    font: "600 15px system-ui, sans-serif",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.6 : 1,
  }),
  row: { display: "flex", justifyContent: "space-between", gap: 12, fontSize: 14, color: "#57534e" } as CSSProperties,
  error: { padding: "10px 12px", borderRadius: 8, background: "#fef2f2", color: "#991b1b", fontSize: 14 } as CSSProperties,
  note: { fontSize: 14, color: "#57534e", margin: 0 } as CSSProperties,
};

export function friendlyError(error: unknown) {
  // viem nests the wallet's error several causes deep, so the code has to be searched for.
  const rejected =
    error instanceof BaseError
      ? error.walk((cause) => (cause as { code?: number }).code === USER_REJECTED) !== null
      : (error as { code?: number }).code === USER_REJECTED;
  if (rejected) return "You cancelled that in your wallet. Nothing was charged.";

  const message = error instanceof Error ? error.message : "";
  if (message.includes("AlreadyPaid")) return "This order has already been paid.";
  if (message.includes("IntentExpired")) return "This checkout expired. Return to the store and try again.";
  return "That didn't go through, and nothing was charged. Please try again.";
}

type ChainParams = { chain_id: number; rpc_url: string; explorer_url: string };

export const isOnChain = async (chainId: number) =>
  Number(await window.ethereum!.request({ method: "eth_chainId" })) === chainId;

export async function switchToChain({ chain_id, rpc_url, explorer_url }: ChainParams) {
  const chainId = `0x${chain_id.toString(16)}` as const;
  try {
    await window.ethereum!.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (cause) {
    if ((cause as { code?: number }).code !== CHAIN_NOT_ADDED) throw cause;
    await window.ethereum!.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: "Whitechain Sepolia",
          nativeCurrency: { name: "WBT", symbol: "WBT", decimals: 18 },
          rpcUrls: [rpc_url],
          blockExplorerUrls: [explorer_url],
        },
      ],
    });
  }
}

/** Connects the browser wallet and moves it onto the right chain. */
export function useWallet(params: ChainParams | undefined, onConnected?: (address: Address) => Promise<void>) {
  const [account, setAccount] = useState<Address>();
  const [phase, setPhase] = useState<"connect" | "wrong_network" | "ready">("connect");
  const [error, setError] = useState<string>();

  const connect = async () => {
    setError(undefined);
    if (!window.ethereum) {
      setError("No wallet found. Install a browser wallet such as MetaMask, then refresh this page.");
      return;
    }
    try {
      const [address] = await window.ethereum.request({ method: "eth_requestAccounts" });
      setAccount(address as Address);
      await onConnected?.(address as Address);
      setPhase((await isOnChain(params!.chain_id)) ? "ready" : "wrong_network");
    } catch (cause) {
      setError(friendlyError(cause));
    }
  };

  const switchNetwork = async () => {
    setError(undefined);
    try {
      await switchToChain(params!);
      setPhase("ready");
    } catch (cause) {
      setError(friendlyError(cause));
    }
  };

  return { account, phase, setPhase, error, setError, connect, switchNetwork };
}

export const formatUsdt = (units: bigint) => Number(formatUnits(units, 6)).toFixed(2);
