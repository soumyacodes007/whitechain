import Link from "next/link";
import type { ReactNode } from "react";
import { signOut } from "../actions";
import { api } from "../lib";

const NAV = [
  ["Home", "/dashboard"],
  ["Payments", "/dashboard/payments"],
  ["Invoices", "/dashboard/invoices"],
  ["Payment links", "/dashboard/links"],
  ["Subscriptions", "/dashboard/subscriptions"],
  ["Customers", "/dashboard/customers"],
  ["Refunds", "/dashboard/refunds"],
  ["Reports & export", "/dashboard/reports"],
  ["Developers", "/dashboard/developers"],
  ["Settings", "/dashboard/settings"],
];

export const metadata = { title: "Dashboard · SettleKit" };

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const account = await api("/account");
  return (
    <div className="dash">
      <aside className="side">
        <div className="merchant">{account.name}</div>
        <div className="badge warn">Test mode · chain {account.chain_id}</div>
        <nav aria-label="Dashboard">
          {NAV.map(([name, href]) => (
            <Link key={href} href={href!}>
              {name}
            </Link>
          ))}
        </nav>
        <form action={signOut}>
          <button className="link">Sign out</button>
        </form>
      </aside>
      <main className="dash-main">{children}</main>
    </div>
  );
}
