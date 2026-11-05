import { saveCustomerNote } from "../../actions";
import { api, date, Title, usdt } from "../../lib";

export default async function CustomersPage() {
  const { data } = await api("/customers");

  return (
    <>
      <Title>Customers</Title>
      {data.length === 0 && (
        <section className="card">
          <p className="muted">Customers appear here when you invoice them or they subscribe.</p>
        </section>
      )}
      {data.map((customer: any) => (
        <section className="card" key={customer.id}>
          <div className="row">
            <strong>{customer.name ?? customer.email ?? "Wallet customer"}</strong>
            <span>{usdt(customer.paid)} paid</span>
          </div>
          <div className="muted">
            {customer.email ?? "No email"} · {usdt(customer.refunded)} refunded · {customer.open_invoices} open invoices ·
            first {date(customer.first_payment)} · last {date(customer.last_payment)}
          </div>
          {customer.wallets.map((wallet: string) => (
            <div className="mono" key={wallet}>
              {wallet}
            </div>
          ))}
          <form action={saveCustomerNote.bind(null, customer.id)} className="filters">
            <input name="notes" defaultValue={customer.notes ?? ""} placeholder="Add a note" aria-label="Note" />
            <button className="secondary">Save</button>
          </form>
        </section>
      ))}
    </>
  );
}
