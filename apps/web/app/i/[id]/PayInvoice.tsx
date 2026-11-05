"use client";

import { SettleCheckout } from "@settlekit/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function PayInvoice({
  apiUrl,
  invoiceId,
  remaining,
  allowPartial,
}: {
  apiUrl: string;
  invoiceId: string;
  remaining: number;
  allowPartial: boolean;
}) {
  const router = useRouter();
  const [amount, setAmount] = useState((remaining / 100).toFixed(2));
  const [clientSecret, setClientSecret] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const start = async () => {
    setBusy(true);
    setError(undefined);
    const cents = Math.round(Number(amount) * 100);
    const response = await fetch(`${apiUrl}/public/invoices/${invoiceId}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: cents }),
    });
    const json = await response.json();
    setBusy(false);
    if (!response.ok) return setError(json.error?.message ?? "That didn't work. Please try again.");
    setClientSecret(json.client_secret);
  };

  if (clientSecret) {
    return <SettleCheckout key={clientSecret} apiUrl={apiUrl} clientSecret={clientSecret} onSuccess={() => router.refresh()} />;
  }

  return (
    <>
      {allowPartial && (
        <label className="field">
          Amount to pay (USDT)
          <input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} />
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={busy} onClick={start}>
        {busy ? "One moment…" : "Pay this invoice"}
      </button>
    </>
  );
}
