import { PUBLIC_API_URL, Shell } from "../lib";
import { Portal } from "./Portal";

// Rendered per request, because the API address comes from the runtime environment.
export const dynamic = "force-dynamic";

export const metadata = { title: "Your payments · SettleKit" };

export default async function PortalPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <Shell wide>
      <h1>Your payments</h1>
      <Portal apiUrl={PUBLIC_API_URL} initialToken={token} />
    </Shell>
  );
}
