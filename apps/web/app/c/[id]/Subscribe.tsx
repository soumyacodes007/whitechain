"use client";

import { SettleSubscribe } from "@settlekit/react";
import type { ComponentProps } from "react";
import { useState } from "react";

export function Subscribe({
  merchantName,
  successUrl,
  ...props
}: Omit<ComponentProps<typeof SettleSubscribe>, "onSuccess"> & { merchantName: string; successUrl: string | null }) {
  const [done, setDone] = useState(false);
  return (
    <>
      <SettleSubscribe {...props} onSuccess={() => setDone(true)} />
      {done && (
        <>
          <a className="primary" href="/portal">
            Manage subscription
          </a>
          {successUrl && <a href={successUrl}>Return to {merchantName}</a>}
        </>
      )}
    </>
  );
}
