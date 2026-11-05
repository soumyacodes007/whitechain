"use client";

import { useState } from "react";

/** Optional email for the receipt. It saves when the field loses focus, so it can't block paying. */
export function EmailField({ apiUrl, sessionId }: { apiUrl: string; sessionId: string }) {
  const [saved, setSaved] = useState(false);

  const save = async (value: string) => {
    if (!value.includes("@")) return setSaved(false);
    const response = await fetch(`${apiUrl}/public/checkout/${sessionId}/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: value }),
    }).catch(() => null);
    setSaved(Boolean(response?.ok));
  };

  return (
    <label className="field">
      Email for your receipt (optional)
      <input type="email" autoComplete="email" onBlur={(event) => save(event.target.value)} />
      {saved && <span className="muted">We'll send your receipt there.</span>}
    </label>
  );
}
