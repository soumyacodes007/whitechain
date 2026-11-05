import QRCode from "qrcode";
import { ActionForm, Submit } from "../../ActionForm";
import { createLink, deactivateLink } from "../../actions";
import { api, date, Title, usdt } from "../../lib";

export default async function LinksPage() {
  const { data } = await api("/payment_links");
  const links = await Promise.all(
    data.map(async (link: any) => ({ ...link, qr: await QRCode.toDataURL(link.url, { margin: 1, width: 120 }) })),
  );

  return (
    <>
      <Title>Payment links</Title>

      <section className="card">
        <h2>New link</h2>
        <ActionForm action={createLink}>
          <label className="field">
            Product name
            <input name="name" required />
          </label>
          <label className="field">
            Price (USDT)
            <input name="price" inputMode="decimal" required />
          </label>
          <label className="field">
            Description
            <input name="description" />
          </label>
          <label className="field">
            Success URL
            <input name="success_url" type="url" />
          </label>
          <label className="check">
            <input name="adjustable_quantity" type="checkbox" /> Let buyers choose a quantity
          </label>
          <Submit>Create link</Submit>
        </ActionForm>
      </section>

      {links.map((link) => {
        const origin = new URL(link.url).origin;
        return (
          <section className="card" key={link.id}>
            <div className="row">
              <strong>{link.name}</strong>
              <span>{usdt(link.unit_amount)}</span>
            </div>
            <div className="muted">
              {link.active ? "Active" : "Inactive"} · paid {link.times_paid} times · collected{" "}
              {usdt(link.times_paid * link.unit_amount)} · created {date(link.created)}
            </div>
            <div className="share">
              <img src={link.qr} alt={`QR code for ${link.name}`} width={120} height={120} />
              <div className="stack">
                <a className="mono" href={link.url}>
                  {link.url}
                </a>
                <code className="mono">{`<script src="${origin}/button.js" data-link="${link.code}"></script>`}</code>
              </div>
            </div>
            {link.active && (
              <form action={deactivateLink.bind(null, link.id)}>
                <button className="secondary">Deactivate</button>
              </form>
            )}
          </section>
        );
      })}
    </>
  );
}
