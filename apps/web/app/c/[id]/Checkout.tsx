"use client";

import { SettleCheckout } from "@settlekit/react";
import { useEffect, useState } from "react";

function useSecondsLeft(expiresAt: number) {
  const [left, setLeft] = useState<number>();
  useEffect(() => {
    const update = () => setLeft(Math.max(expiresAt - Math.floor(Date.now() / 1000), 0));
    update();
    const timer = setInterval(update, 1_000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  return left;
}

export function Checkout({
  apiUrl,
  clientSecret,
  expiresAt,
  merchantName,
  successUrl,
  cancelUrl,
  paymentId,
}: {
  apiUrl: string;
  clientSecret: string;
  expiresAt: number;
  merchantName: string;
  successUrl: string | null;
  cancelUrl: string | null;
  paymentId: string | null;
}) {
  const [receipt, setReceipt] = useState(paymentId);
  const left = useSecondsLeft(expiresAt);

  return (
    <>
      <SettleCheckout apiUrl={apiUrl} clientSecret={clientSecret} onSuccess={(result) => setReceipt(result.paymentId)} />

      {receipt ? (
        <>
          <a className="primary" href={`/r/${receipt}`}>
            View receipt
          </a>
          {successUrl && <a href={successUrl}>Return to {merchantName}</a>}
        </>
      ) : (
        <div className="row muted">
          {left !== undefined && left > 0 ? (
            <span>
              {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} left
            </span>
          ) : (
            <span />
          )}
          {cancelUrl && <a href={cancelUrl}>Cancel</a>}
        </div>
      )}
    </>
  );
}
