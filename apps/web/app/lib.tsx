import { notFound } from "next/navigation";
import type { ReactNode } from "react";

const API_URL = process.env.API_URL ?? "http://localhost:4000";

/** The API origin as the customer's browser reaches it. Read at runtime, so one build runs anywhere. */
export const PUBLIC_API_URL = process.env.PUBLIC_API_URL ?? API_URL;

export async function fetchPublic<T = any>(path: string): Promise<T> {
  const response = await fetch(`${API_URL}/public${path}`, { cache: "no-store" });
  if (response.status === 404) notFound();
  if (!response.ok) throw new Error(`API returned ${response.status}`);
  return response.json() as Promise<T>;
}

export const money = (cents: number) => (cents / 100).toFixed(2);

export const formatDate = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export function Shell({
  merchant,
  wide,
  children,
}: {
  merchant?: { name: string; logo?: string | null };
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <div className="test-banner">Test mode · Whitechain Sepolia</div>
      <main className={wide ? "page wide" : "page"}>
        {merchant && (
          <div className="merchant">
            {merchant.logo && <img src={merchant.logo} alt="" />}
            {merchant.name}
          </div>
        )}
        {children}
      </main>
    </>
  );
}
