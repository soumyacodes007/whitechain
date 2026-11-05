import { fetchPublic, money, PUBLIC_API_URL, Shell } from "../../lib";
import { BuyLink } from "./BuyLink";

export default async function PaymentLinkPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const link = await fetchPublic(`/links/${code}`);

  return (
    <Shell merchant={link.merchant}>
      <section className="card">
        {link.image && <img src={link.image} alt="" style={{ width: "100%", borderRadius: 8 }} />}
        <h1>{link.name}</h1>
        {link.description && <p className="muted">{link.description}</p>}
        <div className="row total">
          <span>Price</span>
          <span>{money(link.unit_amount)} USDT</span>
        </div>
        {link.available ? (
          <BuyLink apiUrl={PUBLIC_API_URL} code={code} adjustableQuantity={link.adjustable_quantity} />
        ) : (
          <p className="error">This item is no longer available.</p>
        )}
      </section>
    </Shell>
  );
}
