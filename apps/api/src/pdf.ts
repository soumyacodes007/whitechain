import PDFDocument from "pdfkit";
import type { Config } from "./config.ts";
import { amountDue, type InvoicePayment, type InvoiceRow, lateFeeAmount } from "./invoices.ts";

const usd = (cents: number) => `${(cents / 100).toFixed(2)} USDT`;
const date = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : "-");

export function invoicePdf(
  invoice: InvoiceRow,
  merchantName: string,
  payments: InvoicePayment[],
  config: Pick<Config, "explorerUrl">,
) {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(20).text(merchantName);
    doc.moveDown(0.5).fontSize(12).text(`Invoice ${invoice.number}`);
    doc.fontSize(10).text(`Status: ${invoice.status.replace("_", " ")}`);
    doc.text(`Issued: ${date(invoice.issued_at ?? invoice.created_at)}`);
    doc.text(`Due: ${date(invoice.due_date)}`);

    doc.moveDown().fontSize(11).text("Bill to");
    doc.fontSize(10).text(invoice.customer_name ?? "-");
    if (invoice.customer_email) doc.text(invoice.customer_email);

    doc.moveDown().fontSize(11).text("Items");
    doc.fontSize(10);
    for (const line of invoice.line_items) {
      doc.text(`${line.quantity} x ${line.description}: ${usd(line.quantity * line.unit_amount)}`);
    }

    const due = amountDue(invoice);
    const paid = Number(invoice.amount_paid);
    doc.moveDown().text(`Subtotal: ${usd(Number(invoice.total))}`);
    const fee = lateFeeAmount(invoice);
    if (fee > 0) doc.text(`Late fee: ${usd(fee)}`);
    doc.text(`Total: ${usd(due)}`);
    doc.text(`Paid: ${usd(paid)}`);
    doc.text(`Remaining: ${usd(Math.max(due - paid, 0))}`);

    if (payments.length > 0) {
      doc.moveDown().fontSize(11).text("Settlement");
      doc.fontSize(8);
      for (const payment of payments) {
        doc.text(`${usd(Number(payment.amount))}  tx ${payment.tx_hash}`);
        doc.fillColor("#555555").text(`${config.explorerUrl}/tx/${payment.tx_hash}`).fillColor("#000000");
      }
    }

    if (invoice.notes) doc.moveDown().fontSize(10).text(invoice.notes);
    doc.end();
  });
}
