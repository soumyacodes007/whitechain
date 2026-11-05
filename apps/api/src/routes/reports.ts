import type { FastifyInstance } from "fastify";
import ExcelJS from "exceljs";
import { zipSync } from "fflate";
import { z } from "zod";
import type { Deps } from "../app.ts";
import { invalidRequest, notFound } from "../errors.ts";
import { invoicePayments, listInvoices } from "../invoices.ts";
import { invoicePdf } from "../pdf.ts";

const periodQuery = z.object({
  from: z.coerce.number().int().positive(),
  to: z.coerce.number().int().positive(),
  timezone: z.string().default("UTC"),
});

const matchBody = z.object({ reference: z.string().min(1).max(200) });

type LedgerRow = {
  date: Date;
  type: "payment" | "refund" | "renewal";
  reference: string;
  customer: string | null;
  description: string | null;
  gross: number;
  refund: number;
  fee: number;
  net: number;
  currency: string;
  status: string;
  tx_hash: string;
  explorer_url: string;
  block_number: number;
};

const COLUMNS = [
  "Date (UTC)",
  "Date (local)",
  "Type",
  "Invoice or order",
  "Customer",
  "Description",
  "Gross",
  "Refund",
  "Network fee paid by merchant",
  "Net",
  "Currency",
  "Status",
  "Tx hash",
  "Explorer URL",
  "Block",
];

const usdt = (cents: number) => (cents / 100).toFixed(2);

/** A spreadsheet runs a cell starting with these as a formula, and customer names are user input. */
const safeCell = (value: string) => (/^[=+\-@\t\r]/.test(value) ? `'${value}` : value);

const csvCell = (value: string) => (/[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

function localDate(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone, dateStyle: "short", timeStyle: "medium" }).format(date);
}

function assertTimezone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    throw invalidRequest("parameter_invalid", "Unknown timezone", "timezone");
  }
}

function toCells(row: LedgerRow, timeZone: string) {
  return [
    row.date.toISOString(),
    localDate(row.date, timeZone),
    row.type,
    safeCell(row.reference),
    safeCell(row.customer ?? ""),
    safeCell(row.description ?? ""),
    usdt(row.gross),
    usdt(row.refund),
    usdt(row.fee),
    usdt(row.net),
    row.currency,
    row.status,
    row.tx_hash,
    row.explorer_url,
    String(row.block_number),
  ];
}

export async function reportRoutes(app: FastifyInstance, { db, config }: Deps) {
  async function ledger(merchantId: string, from: Date, to: Date): Promise<LedgerRow[]> {
    const rows = await db.query(
      `SELECT * FROM (
         SELECT p.confirmed_at AS date, CASE WHEN i.source = 'invoice' THEN 'payment' ELSE 'payment' END AS type,
                coalesce(inv.number, i.metadata->>'orderId', i.id) AS reference,
                coalesce(c.name, c.email, p.payer) AS customer, i.description,
                p.amount AS gross, 0 AS refund, i.currency, i.late_settlement,
                'succeeded' AS status, p.tx_hash, p.block_number
         FROM payments p
         JOIN payment_intents i ON i.id = p.intent_id
         LEFT JOIN invoices inv ON inv.id = p.invoice_id
         LEFT JOIN customers c ON c.id = inv.customer_id
         WHERE i.merchant_id = $1
         UNION ALL
         SELECT r.created_at, 'refund',
                coalesce(inv.number, i.metadata->>'orderId', i.id),
                coalesce(c.name, c.email, p.payer), r.reason,
                0, r.amount, i.currency, false, r.status, r.tx_hash, p.block_number
         FROM refunds r
         JOIN payments p ON p.id = r.payment_id
         JOIN payment_intents i ON i.id = p.intent_id
         LEFT JOIN invoices inv ON inv.id = p.invoice_id
         LEFT JOIN customers c ON c.id = inv.customer_id
         WHERE i.merchant_id = $1 AND r.status = 'succeeded'
         UNION ALL
         SELECT ch.created_at, 'renewal', s.id, s.wallet, s.plan_name,
                ch.amount, 0, s.currency, false, 'succeeded', ch.tx_hash, ch.block_number
         FROM subscription_charges ch
         JOIN subscriptions s ON s.id = ch.subscription_id
         WHERE s.merchant_id = $1 AND ch.status = 'succeeded'
       ) ledger
       WHERE date >= $2 AND date < $3
       ORDER BY date, tx_hash`,
      [merchantId, from, to],
    );
    return rows.map((row) => ({
      date: row.date,
      type: row.type,
      reference: row.reference,
      customer: row.customer,
      description: row.description,
      gross: Number(row.gross),
      refund: Number(row.refund),
      // SettleKit's operator pays gas on refunds and renewals, so a merchant pays no network fee today.
      fee: 0,
      net: Number(row.gross) - Number(row.refund),
      currency: row.currency,
      status: row.late_settlement ? "succeeded (late)" : row.status,
      tx_hash: row.tx_hash,
      explorer_url: `${config.explorerUrl}/tx/${row.tx_hash}`,
      block_number: Number(row.block_number),
    }));
  }

  function summarize(rows: LedgerRow[]) {
    const gross = rows.reduce((sum, row) => sum + row.gross, 0);
    const refunds = rows.reduce((sum, row) => sum + row.refund, 0);
    const fees = rows.reduce((sum, row) => sum + row.fee, 0);
    return {
      gross,
      refunds,
      fees,
      net: gross - refunds - fees,
      payments: rows.filter((row) => row.type !== "refund").length,
    };
  }

  async function reconciliation(merchantId: string, from: Date, to: Date) {
    const rows = await db.query(
      `SELECT t.*, p.id AS payment_id, i.amount AS intent_amount, i.late_settlement,
              inv.number AS invoice_number, inv.amount_paid, inv.total, ch.id AS charge_id,
              coalesce(i.metadata->>'orderId', i.id) AS order_ref,
              (SELECT coalesce(sum(r.amount), 0) FROM refunds r WHERE r.payment_id = p.id AND r.status = 'succeeded') AS refunded
       FROM incoming_transfers t
       LEFT JOIN payments p ON p.tx_hash = t.tx_hash
       LEFT JOIN payment_intents i ON i.id = p.intent_id
       LEFT JOIN invoices inv ON inv.id = p.invoice_id
       LEFT JOIN subscription_charges ch ON ch.tx_hash = t.tx_hash AND ch.status = 'succeeded'
       WHERE t.merchant_id = $1 AND t.created_at >= $2 AND t.created_at < $3
       ORDER BY t.block_number DESC, t.log_index DESC`,
      [merchantId, from, to],
    );

    return rows.map((row) => {
      const amount = Number(row.amount);
      const refunded = Number(row.refunded);
      const flags: string[] = [];
      if (row.payment_id && refunded > 0) flags.push(refunded >= amount ? "refunded" : "partially_refunded");
      if (row.late_settlement) flags.push("late_settlement");
      if (row.invoice_number && Number(row.amount_paid) < Number(row.total)) flags.push("underpaid");
      if (row.invoice_number && Number(row.amount_paid) > Number(row.total)) flags.push("overpaid");

      const matched = row.payment_id || row.charge_id || row.manual_reference;
      return {
        id: row.id,
        status: matched ? "matched" : "unmatched",
        amount,
        from: row.from_address,
        reference: row.manual_reference ?? row.invoice_number ?? row.order_ref ?? (row.charge_id ? "subscription" : null),
        flags,
        date: Math.floor(row.created_at.getTime() / 1000),
        explorer_url: `${config.explorerUrl}/tx/${row.tx_hash}`,
      };
    });
  }

  const parsePeriod = (query: unknown) => {
    const { from, to, timezone } = periodQuery.parse(query);
    assertTimezone(timezone);
    if (to <= from) throw invalidRequest("parameter_invalid", "The end must be after the start", "to");
    return { from: new Date(from * 1000), to: new Date(to * 1000), timezone };
  };

  async function workbook(rows: LedgerRow[], timezone: string) {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Transactions");
    sheet.addRow(COLUMNS).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];

    for (const row of rows) {
      const cells: (string | number)[] = toCells(row, timezone);
      cells[6] = row.gross / 100;
      cells[7] = row.refund / 100;
      cells[8] = row.fee / 100;
      cells[9] = row.net / 100;
      sheet.addRow(cells);
    }

    const summary = summarize(rows);
    sheet.addRow([]);
    const total = sheet.addRow([
      "Summary",
      "",
      `${summary.payments} payments`,
      "",
      "",
      "",
      summary.gross / 100,
      summary.refunds / 100,
      summary.fees / 100,
      summary.net / 100,
      "USDT",
    ]);
    total.font = { bold: true };

    for (const column of [7, 8, 9, 10]) sheet.getColumn(column).numFmt = "0.00";
    COLUMNS.forEach((name, index) => (sheet.getColumn(index + 1).width = Math.max(name.length + 2, 14)));
    return Buffer.from(await book.xlsx.writeBuffer());
  }

  const filename = (from: Date, extension: string) => `settlekit-${from.toISOString().slice(0, 10)}.${extension}`;

  app.get("/reports", async (request) => {
    const { from, to, timezone } = parsePeriod(request.query);
    const rows = await ledger(request.merchant.id, from, to);

    const [invoices] = await db.query(
      `SELECT count(*) FILTER (WHERE last_paid <= due_date OR due_date IS NULL)::int AS on_time,
              count(*) FILTER (WHERE last_paid > due_date)::int AS late
       FROM (
         SELECT inv.due_date, max(p.confirmed_at) AS last_paid
         FROM invoices inv JOIN payments p ON p.invoice_id = inv.id
         WHERE inv.merchant_id = $1 AND inv.status = 'paid'
         GROUP BY inv.id
         HAVING max(p.confirmed_at) >= $2 AND max(p.confirmed_at) < $3
       ) paid`,
      [request.merchant.id, from, to],
    );

    return {
      summary: { ...summarize(rows), invoices_on_time: invoices.on_time, invoices_late: invoices.late },
      transactions: rows.map((row) => ({ ...row, date: Math.floor(row.date.getTime() / 1000) })),
      reconciliation: await reconciliation(request.merchant.id, from, to),
      timezone,
    };
  });

  app.get("/reports/export.csv", async (request, reply) => {
    const { from, to, timezone } = parsePeriod(request.query);
    const rows = await ledger(request.merchant.id, from, to);
    const summary = summarize(rows);

    const lines = [
      COLUMNS.map(csvCell).join(","),
      ...rows.map((row) => toCells(row, timezone).map(csvCell).join(",")),
      "",
      ["Summary", "", `${summary.payments} payments`, "", "", "", usdt(summary.gross), usdt(summary.refunds), usdt(summary.fees), usdt(summary.net), "USDT"]
        .map(csvCell)
        .join(","),
    ];

    // The byte order mark tells Excel the file is UTF-8, so names with accents survive.
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="${filename(from, "csv")}"`)
      .send(`﻿${lines.join("\r\n")}\r\n`);
  });

  app.get("/reports/export.xlsx", async (request, reply) => {
    const { from, to, timezone } = parsePeriod(request.query);
    return reply
      .header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("content-disposition", `attachment; filename="${filename(from, "xlsx")}"`)
      .send(await workbook(await ledger(request.merchant.id, from, to), timezone));
  });

  app.get("/reports/accountant-pack.zip", async (request, reply) => {
    const { from, to, timezone } = parsePeriod(request.query);
    const merchantId = request.merchant.id;
    const files: Record<string, Uint8Array> = {
      [filename(from, "xlsx")]: new Uint8Array(await workbook(await ledger(merchantId, from, to), timezone)),
    };

    const [merchant] = await db.query("SELECT name FROM merchants WHERE id = $1", [merchantId]);
    const invoices = await listInvoices(db, merchantId, undefined, 100);
    for (const invoice of invoices) {
      const issued = invoice.issued_at;
      if (!issued || issued < from || issued >= to) continue;
      const pdf = await invoicePdf(invoice, merchant.name, await invoicePayments(db, invoice.id), config);
      files[`invoices/${invoice.number}.pdf`] = new Uint8Array(pdf);
    }

    return reply
      .header("content-type", "application/zip")
      .header("content-disposition", `attachment; filename="${filename(from, "zip")}"`)
      .send(Buffer.from(zipSync(files)));
  });

  app.post<{ Params: { id: string } }>("/reconciliation/:id/match", async (request) => {
    const { reference } = matchBody.parse(request.body ?? {});
    const moved = await db.query(
      "UPDATE incoming_transfers SET manual_reference = $3 WHERE id = $1 AND merchant_id = $2 RETURNING id",
      [request.params.id, request.merchant.id, reference],
    );
    if (moved.length === 0) throw notFound("transfer", request.params.id);
    return { id: request.params.id, status: "matched", reference };
  });
}
