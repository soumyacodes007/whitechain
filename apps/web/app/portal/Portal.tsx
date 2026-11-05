"use client";

import { friendlyError, isOnChain, switchToChain, usdtAbi } from "@settlekit/react";
import { useCallback, useState } from "react";
import { type Address, createPublicClient, createWalletClient, custom, http, parseAbi } from "viem";

const subscriptionsAbi = parseAbi(["function cancel(uint256 subId)"]);
const SESSION_SECONDS = 30 * 60;
const TABS = ["Payments", "Invoices", "Subscriptions", "Refunds"] as const;

const money = (cents: number) => (cents / 100).toFixed(2);
const date = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const label = (status: string) => status.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());

function SubscriptionCard({ sub, data, wallet, onChange }: { sub: any; data: any; wallet: Address; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [allowance, setAllowance] = useState<bigint>();
  const client = () => createWalletClient({ account: wallet, transport: custom(window.ethereum!) });
  const reader = createPublicClient({ transport: http(data.rpc_url) });
  const contract = sub.settlekit.contract as Address;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      if (!(await isOnChain(data.chain_id))) {
        await switchToChain({ chain_id: data.chain_id, rpc_url: data.rpc_url, explorer_url: "" });
      }
      await action();
    } catch (cause) {
      setError(friendlyError(cause));
    }
    setBusy(false);
  };

  const cancel = () =>
    run(async () => {
      const hash = await client().writeContract({
        chain: null,
        address: contract,
        abi: subscriptionsAbi,
        functionName: "cancel",
        args: [BigInt(sub.settlekit.onchain_id)],
      });
      await reader.waitForTransactionReceipt({ hash });
      onChange();
    });

  const updateAllowance = () =>
    run(async () => {
      const hash = await client().writeContract({
        chain: null,
        address: data.token,
        abi: usdtAbi,
        functionName: "approve",
        args: [contract, BigInt(sub.plan.amount) * 10_000n * 12n],
      });
      await reader.waitForTransactionReceipt({ hash });
      onChange();
    });

  const checkAllowance = async () =>
    setAllowance(
      await reader.readContract({ address: data.token, abi: usdtAbi, functionName: "allowance", args: [wallet, contract] }),
    );

  const live = sub.status === "active" || sub.status === "past_due";

  return (
    <section className="card">
      <div className="row">
        <strong>{sub.plan.name}</strong>
        <span className={`badge ${sub.status === "active" ? "good" : sub.status === "past_due" ? "bad" : ""}`}>
          {label(sub.status)}
        </span>
      </div>
      <div className="row muted">
        <span>
          {money(sub.plan.amount)} USDT per {sub.plan.interval} · {sub.merchant}
        </span>
        {live && sub.current_period_end && <span>Next charge {date(sub.current_period_end)}</span>}
      </div>
      <div className="muted">
        {sub.periods_charged} {sub.periods_charged === 1 ? "payment" : "payments"} so far
        {allowance !== undefined && ` · ${(Number(allowance) / 1e6).toFixed(2)} USDT allowance left`}{" "}
        {allowance === undefined && (
          <button className="link" onClick={checkAllowance}>
            Check allowance
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {live && (
        <div className="actions">
          {sub.status === "past_due" && (
            <button className="primary" disabled={busy} onClick={updateAllowance}>
              Update allowance
            </button>
          )}
          <button className="secondary" disabled={busy} onClick={cancel}>
            {busy ? "Check your wallet…" : "Cancel subscription"}
          </button>
        </div>
      )}
    </section>
  );
}

export function Portal({ apiUrl }: { apiUrl: string }) {
  const [wallet, setWallet] = useState<Address>();
  const [token, setToken] = useState<string>();
  const [data, setData] = useState<any>();
  const [tab, setTab] = useState<(typeof TABS)[number]>("Payments");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (session: string) => {
      const response = await fetch(`${apiUrl}/public/portal`, {
        headers: { authorization: `Bearer ${session}` },
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Please sign in again");
      setData(await response.json());
    },
    [apiUrl],
  );

  const signIn = async () => {
    setError(undefined);
    if (!window.ethereum) return setError("No wallet found. Install a browser wallet, then refresh this page.");
    setBusy(true);
    try {
      const [address] = await window.ethereum.request({ method: "eth_requestAccounts" });
      const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
      const client = createWalletClient({ account: address as Address, transport: custom(window.ethereum) });
      const signature = await client.signMessage({
        message: `Sign in to your SettleKit customer portal\nWallet: ${address}\nExpires: ${expires}`,
      });
      const response = await fetch(`${apiUrl}/public/portal/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, expires, signature }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error?.message ?? "Sign-in failed");
      setWallet(address as Address);
      setToken(json.token);
      await load(json.token);
    } catch (cause) {
      setError(friendlyError(cause));
    }
    setBusy(false);
  };

  if (!data || !token || !wallet) {
    return (
      <section className="card">
        <p className="muted">Sign with the wallet you paid from to see your payments, refunds and subscriptions.</p>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy} onClick={signIn}>
          {busy ? "Check your wallet…" : "Sign in with wallet"}
        </button>
      </section>
    );
  }

  const refresh = () => {
    // The indexer needs a few seconds to see an onchain change.
    setTimeout(() => void load(token), 4_000);
  };

  return (
    <>
      <nav className="tabs" aria-label="Portal sections">
        {TABS.map((name) => (
          <button key={name} className={tab === name ? "tab active" : "tab"} onClick={() => setTab(name)}>
            {name}
          </button>
        ))}
      </nav>

      {tab === "Payments" && (
        <section className="card">
          {data.payments.length === 0 && <p className="muted">No payments from this wallet yet.</p>}
          {data.payments.map((payment: any) => (
            <div className="row" key={payment.id}>
              <span>
                {money(payment.amount)} USDT · {payment.merchant} · {date(payment.date)}
                {payment.refunded > 0 && ` · ${money(payment.refunded)} refunded`}
              </span>
              <a href={`/r/${payment.id}`}>Receipt</a>
            </div>
          ))}
        </section>
      )}

      {tab === "Invoices" && (
        <section className="card">
          {data.invoices.length === 0 && <p className="muted">No invoices paid from this wallet yet.</p>}
          {data.invoices.map((invoice: any) => (
            <div className="row" key={invoice.id}>
              <span>
                {invoice.number} · {invoice.merchant} · {money(invoice.total)} USDT · {label(invoice.status)}
              </span>
              <a href={`/i/${invoice.id}`}>View</a>
            </div>
          ))}
        </section>
      )}

      {tab === "Subscriptions" && (
        <>
          {data.subscriptions.length === 0 && (
            <section className="card">
              <p className="muted">No subscriptions on this wallet.</p>
            </section>
          )}
          {data.subscriptions.map((sub: any) => (
            <SubscriptionCard key={sub.id} sub={sub} data={data} wallet={wallet} onChange={refresh} />
          ))}
        </>
      )}

      {tab === "Refunds" && (
        <section className="card">
          {data.refunds.length === 0 && <p className="muted">No refunds on this wallet.</p>}
          {data.refunds.map((refund: any) => (
            <div className="row" key={refund.id}>
              <span>
                {money(refund.amount)} USDT · {refund.merchant} · {date(refund.date)}
              </span>
              <span>
                <a href={`/r/${refund.payment_id}`}>Receipt</a> ·{" "}
                <a href={refund.explorer_url} target="_blank" rel="noreferrer">
                  Explorer
                </a>
              </span>
            </div>
          ))}
        </section>
      )}
    </>
  );
}
