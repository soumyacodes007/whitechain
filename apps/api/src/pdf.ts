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

export function receiptPdf(
  receipt: {
    id: string;
    merchant_name: string;
    amount: string | number;
    payer: string;
    tx_hash: string;
    block_number: string | number;
    confirmed_at: Date;
    reference: string;
    refunds: { amount: string | number; reason: string | null; tx_hash: string | null }[];
  },
  config: Pick<Config, "explorerUrl">,
) {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const refunded = receipt.refunds.reduce((sum, refund) => sum + Number(refund.amount), 0);

    doc.fontSize(20).text(receipt.merchant_name);
    doc.moveDown(0.5).fontSize(12).text("Payment receipt");
    doc.fontSize(10).text(`Reference: ${receipt.reference}`);
    doc.text(`Date: ${date(receipt.confirmed_at)}`);
    doc.text(`Paid from: ${receipt.payer}`);
    doc.moveDown().fontSize(12).text(`Amount paid: ${usd(Number(receipt.amount))}`);
    if (refunded > 0) {
      doc.fontSize(10).text(`Refunded: ${usd(refunded)}`);
      doc.text(`Net paid: ${usd(Number(receipt.amount) - refunded)}`);
    }

    doc.moveDown().fontSize(11).text("Verify this payment");
    doc.fontSize(8).text(`Transaction: ${receipt.tx_hash}`);
    doc.text(`Block: ${receipt.block_number}`);
    doc.text(`${config.explorerUrl}/tx/${receipt.tx_hash}`);
    doc.moveDown(0.5).text("This record lives on Whitechain and can be checked without SettleKit.");

    for (const refund of receipt.refunds) {
      doc.moveDown(0.5).text(`Refund ${usd(Number(refund.amount))} (${(refund.reason ?? "other").replaceAll("_", " ")})`);
      if (refund.tx_hash) doc.text(`${config.explorerUrl}/tx/${refund.tx_hash}`);
    }
    doc.end();
  });
}
