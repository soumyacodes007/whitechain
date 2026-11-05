"use client";

import { useState } from "react";

export function ReceiptActions({ apiUrl, paymentId }: { apiUrl: string; paymentId: string }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    setState("sending");
    const response = await fetch(`${apiUrl}/public/receipts/${paymentId}/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    }).catch(() => null);
    setState(response?.ok ? "sent" : "failed");
  };

  return (
    <section className="card">
      <a className="secondary" href={`${apiUrl}/public/receipts/${paymentId}/pdf`}>
        Download receipt PDF
      </a>
      <form className="filters" onSubmit={send}>
        <input
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          aria-label="Email address"
        />
        <button className="secondary" disabled={state === "sending"}>
          Email me this receipt
        </button>
      </form>
      {state === "sent" && <p className="success">Sent.</p>}
      {state === "failed" && <p className="error">That didn't work. Please try again.</p>}
    </section>
  );
}
