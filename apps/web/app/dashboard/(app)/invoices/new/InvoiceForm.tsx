"use client";

import { useState } from "react";
import { ActionForm, Submit } from "../../../ActionForm";
import { createInvoice } from "../../../actions";

type Line = { description: string; quantity: number; price: string };

const lineTotal = (line: Line) => line.quantity * (Number(line.price) || 0);

export function InvoiceForm() {
  const [lines, setLines] = useState<Line[]>([{ description: "", quantity: 1, price: "" }]);
  const [customer, setCustomer] = useState("");
  const [due, setDue] = useState("");

  const update = (index: number, change: Partial<Line>) =>
    setLines(lines.map((line, i) => (i === index ? { ...line, ...change } : line)));
  const total = lines.reduce((sum, line) => sum + lineTotal(line), 0);

  return (
    <div className="columns">
      <section className="card">
        <ActionForm action={createInvoice}>
          <input type="hidden" name="lines" value={JSON.stringify(lines)} />
          <label className="field">
            Customer name
            <input name="customer_name" required value={customer} onChange={(e) => setCustomer(e.target.value)} />
          </label>
          <label className="field">
            Customer email
            <input name="customer_email" type="email" />
          </label>

          {lines.map((line, index) => (
            <div className="line" key={index}>
              <label className="field">
                Description
                <input value={line.description} onChange={(e) => update(index, { description: e.target.value })} />
              </label>
              <label className="field">
                Qty
                <input
                  type="number"
                  min={1}
                  value={line.quantity}
                  onChange={(e) => update(index, { quantity: Number(e.target.value) || 1 })}
                />
              </label>
              <label className="field">
                Unit price
                <input inputMode="decimal" value={line.price} onChange={(e) => update(index, { price: e.target.value })} />
              </label>
            </div>
          ))}
          <button
            type="button"
            className="link"
            onClick={() => setLines([...lines, { description: "", quantity: 1, price: "" }])}
          >
            Add line item
          </button>

          <label className="field">
            Due date
            <input name="due_date" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
          <label className="field">
            Late fee, percent (optional)
            <input name="late_fee_percent" type="number" min={0} max={100} />
          </label>
          <label className="check">
            <input name="allow_partial" type="checkbox" /> Allow partial payments
          </label>
          <label className="check">
            <input name="reminders" type="checkbox" defaultChecked /> Send due date reminders
          </label>
          <label className="field">
            Notes
            <input name="notes" />
          </label>
          <Submit>Save draft</Submit>
        </ActionForm>
      </section>

      <section className="card">
        <h2>Customer sees</h2>
        <div className="muted">Bill to {customer || "…"}</div>
        {lines
          .filter((line) => line.description)
          .map((line, index) => (
            <div className="row" key={index}>
              <span>
                {line.description}
                {line.quantity > 1 ? ` × ${line.quantity}` : ""}
              </span>
              <span>{lineTotal(line).toFixed(2)} USDT</span>
            </div>
          ))}
        <div className="row total">
          <span>Total</span>
          <span>{total.toFixed(2)} USDT</span>
        </div>
        {due && <div className="muted">Due {due}</div>}
      </section>
    </div>
  );
}
