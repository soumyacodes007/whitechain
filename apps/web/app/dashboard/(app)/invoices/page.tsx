import Link from "next/link";
import { api, Badge, date, label, Title, usdt } from "../../lib";

const TABS = ["", "draft", "open", "partially_paid", "overdue", "paid", "void"];

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const { data } = await api(`/invoices${status ? `?status=${status}` : ""}`);

  return (
    <>
      <Title
        action={
          <Link className="primary" href="/dashboard/invoices/new">
            New invoice
          </Link>
        }
      >
        Invoices
      </Title>

      <nav className="tabs" aria-label="Invoice status">
        {TABS.map((tab) => (
          <Link
            key={tab}
            className={(status ?? "") === tab ? "tab active" : "tab"}
            href={tab ? `/dashboard/invoices?status=${tab}` : "/dashboard/invoices"}
          >
            {tab ? label(tab) : "All"}
          </Link>
        ))}
      </nav>

      <section className="card scroll">
        {data.length === 0 ? (
          <p className="muted">No invoices here.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Number</th>
                <th>Customer</th>
                <th>Amount</th>
                <th>Paid</th>
                <th>Due</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.map((invoice: any) => (
                <tr key={invoice.id}>
                  <td>
                    <Link href={`/dashboard/invoices/${invoice.id}`}>{invoice.number}</Link>
                  </td>
                  <td>{invoice.customer.name}</td>
                  <td>{usdt(invoice.total)}</td>
                  <td>{usdt(invoice.amount_paid)}</td>
                  <td>{date(invoice.due_date)}</td>
                  <td>
                    <Badge status={invoice.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
