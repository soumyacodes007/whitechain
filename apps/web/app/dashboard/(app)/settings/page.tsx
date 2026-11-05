import { ActionForm, Submit } from "../../ActionForm";
import { saveSettings } from "../../actions";
import { api, Title } from "../../lib";

export default async function SettingsPage() {
  const account = await api("/account");

  return (
    <>
      <Title>Settings</Title>

      <section className="card">
        <ActionForm action={saveSettings}>
          <h2>Business profile</h2>
          <label className="field">
            Business name
            <input name="name" defaultValue={account.name} required />
          </label>
          <label className="field">
            Logo URL
            <input name="logo" type="url" defaultValue={account.logo ?? ""} />
          </label>
          <label className="field">
            Brand color
            <input name="brand_color" defaultValue={account.brand_color ?? ""} placeholder="#1c1917" pattern="#[0-9a-fA-F]{6}" />
          </label>
          <label className="field">
            Support email
            <input name="support_email" type="email" defaultValue={account.support_email ?? ""} />
          </label>
          <label className="field">
            Timezone
            <input name="timezone" defaultValue={account.timezone} />
          </label>
          <label className="field">
            Invoice prefix
            <input name="invoice_prefix" defaultValue={account.invoice_prefix} maxLength={10} />
          </label>

          <h2>Checkout</h2>
          <label className="check">
            <input name="gasless" type="checkbox" defaultChecked={account.gasless} /> Gasless checkout
          </label>
          <label className="field">
            Required confirmations
            <input name="confirmations" type="number" min={1} max={20} defaultValue={account.confirmations} />
          </label>
          <h2>Reminders</h2>
          <label className="check">
            <input name="reminders_enabled" type="checkbox" defaultChecked={account.reminders_enabled} /> Email 3 days
            before, on the due date, and 3 days after
          </label>
          <Submit>Save settings</Submit>
        </ActionForm>
      </section>

      <section className="card">
        <h2>Wallets</h2>
        <div className="row">
          <span className="muted">Settlement wallet</span>
          <span className="mono">{account.payout_wallet}</span>
        </div>
        <div className="row">
          <span className="muted">Refund wallet</span>
          <span className="mono">{account.refund_wallet}</span>
        </div>
        <div className="row">
          <span className="muted">Refund operator</span>
          <span className="mono">{account.operator ?? "–"}</span>
        </div>
        <p className="muted">Wallets are set onchain with registerMerchant, so they change from the merchant wallet.</p>
      </section>
    </>
  );
}
