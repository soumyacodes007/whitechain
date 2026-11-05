import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";

export const COOKIE = "settlekit_key";
const API_URL = process.env.API_URL ?? "http://localhost:4000";

export const secretKey = async () => (await cookies()).get(COOKIE)?.value;

/** Calls the merchant API with the signed-in key. The key stays in an httpOnly cookie on this server. */
export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const key = await secretKey();
  if (!key) redirect("/dashboard/login");

  const response = await fetch(`${API_URL}/v1${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      authorization: `Bearer ${key}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (response.status === 401) redirect("/dashboard/login");
  if (response.status === 404) notFound();
  if (!response.ok) throw new Error(`API returned ${response.status}`);
  return response.json() as Promise<T>;
}

export const usdt = (cents: number) => `${(cents / 100).toFixed(2)} USDT`;
export const date = (seconds: number | null) =>
  seconds
    ? new Date(seconds * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
    : "–";
export const shortHash = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`;
export const label = (status: string) => status.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());

const TONES: Record<string, string> = {
  succeeded: "good",
  paid: "good",
  active: "good",
  matched: "good",
  sent: "good",
  logged: "warn",
  partially_refunded: "warn",
  partially_paid: "warn",
  pending: "warn",
  past_due: "bad",
  overdue: "bad",
  failed: "bad",
  unmatched: "bad",
};

export const Badge = ({ status }: { status: string }) => (
  <span className={`badge ${TONES[status] ?? ""}`}>{label(status)}</span>
);

export const Kpi = ({ name, value, note }: { name: string; value: string; note?: string }) => (
  <div className="kpi">
    <div className="muted">{name}</div>
    <div className="kpi-value">{value}</div>
    {note && <div className="muted">{note}</div>}
  </div>
);

export const Title = ({ children, action }: { children: ReactNode; action?: ReactNode }) => (
  <div className="row title">
    <h1>{children}</h1>
    {action}
  </div>
);

export function TxLink({ url, hash }: { url: string | null; hash?: string | null }) {
  if (!url) return <span className="muted">–</span>;
  return (
    <a className="mono" href={url} target="_blank" rel="noreferrer">
      {hash ? shortHash(hash) : "Explorer"}
    </a>
  );
}
