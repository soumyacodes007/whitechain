"use client";

import { useState } from "react";

export function BuyLink({
  apiUrl,
  code,
  adjustableQuantity,
}: {
  apiUrl: string;
  code: string;
  adjustableQuantity: boolean;
}) {
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const buy = async () => {
    setBusy(true);
    setError(undefined);
    const response = await fetch(`${apiUrl}/public/links/${code}/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quantity }),
    });
    const json = await response.json();
    if (!response.ok) {
      setError(json.error?.message ?? "That didn't work. Please try again.");
      setBusy(false);
      return;
    }
    window.location.href = `/c/${json.session_id}`;
  };

  return (
    <>
      {adjustableQuantity && (
        <label className="field">
          Quantity
          <input
            type="number"
            min={1}
            max={100}
            value={quantity}
            onChange={(event) => setQuantity(Number(event.target.value) || 1)}
          />
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={busy} onClick={buy}>
        {busy ? "Starting checkout…" : "Continue to payment"}
      </button>
    </>
  );
}
