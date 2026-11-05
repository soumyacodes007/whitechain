"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { COOKIE, secretKey } from "./lib";

const API_URL = process.env.API_URL ?? "http://localhost:4000";

export type ActionState = { error?: string; ok?: string };

async function call(path: string, body: object = {}) {
  const response = await fetch(`${API_URL}/v1${path}`, {
    method: "POST",
    cache: "no-store",
    headers: { authorization: `Bearer ${await secretKey()}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  return response.ok ? { json } : { error: (json.error?.message as string) ?? "That didn't work. Please try again." };
}

const cents = (value: FormDataEntryValue | null) => Math.round(Number(value) * 100);
const text = (form: FormData, name: string) => {
  const value = String(form.get(name) ?? "").trim();
  return value === "" ? undefined : value;
};

export async function signIn(_: ActionState, form: FormData): Promise<ActionState> {
  const key = text(form, "key") ?? "";
  const response = await fetch(`${API_URL}/v1/account`, {
    headers: { authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  if (!response.ok) return { error: "That key wasn't recognised." };

  (await cookies()).set(COOKIE, key, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production" && process.env.INSECURE_COOKIES !== "1",
    path: "/dashboard",
  });
  redirect("/dashboard");
}

export async function signOut() {
  (await cookies()).delete({ name: COOKIE, path: "/dashboard" });
  redirect("/dashboard/login");
}

export async function refund(_: ActionState, form: FormData): Promise<ActionState> {
  const { error } = await call("/refunds", {
    payment_intent: text(form, "payment_intent"),
    amount: cents(form.get("amount")),
    reason: text(form, "reason"),
    note: text(form, "note"),
  });
  if (error) return { error };
  revalidatePath("/dashboard", "layout");
  return { ok: "Refund sent. It will show as succeeded once it confirms." };
}

export async function createInvoice(_: ActionState, form: FormData): Promise<ActionState> {
  const due = text(form, "due_date");
  const lateFee = Number(form.get("late_fee_percent") || 0);
  const lines = JSON.parse(String(form.get("lines"))) as { description: string; quantity: number; price: string }[];

  const { json, error } = await call("/invoices", {
    customer: { name: text(form, "customer_name"), email: text(form, "customer_email") },
    line_items: lines
      .filter((line) => line.description.trim() !== "")
      .map((line) => ({
        description: line.description,
        quantity: line.quantity,
        unit_amount: Math.round(Number(line.price) * 100),
      })),
    due_date: due ? Math.floor(new Date(due).getTime() / 1000) : undefined,
    late_fee: lateFee > 0 ? { type: "percent", value: lateFee } : undefined,
    allow_partial: form.get("allow_partial") === "on",
    reminders: form.get("reminders") === "on",
    notes: text(form, "notes"),
  });
  if (error) return { error };
  redirect(`/dashboard/invoices/${json.id}`);
}

export async function invoiceAction(id: string, action: "send" | "void", _: ActionState): Promise<ActionState> {
  const { error } = await call(`/invoices/${id}/${action}`);
  if (error) return { error };
  revalidatePath("/dashboard", "layout");
  return { ok: action === "send" ? "Invoice sent." : "Invoice voided." };
}

export async function remindInvoice(id: string, _: ActionState): Promise<ActionState> {
  const { error } = await call(`/invoices/${id}/remind`);
  if (error) return { error };
  revalidatePath(`/dashboard/invoices/${id}`);
  return { ok: "Reminder sent." };
}

export async function duplicateInvoice(id: string, _: ActionState): Promise<ActionState> {
  const source = await fetch(`${API_URL}/v1/invoices/${id}`, {
    headers: { authorization: `Bearer ${await secretKey()}` },
    cache: "no-store",
  }).then((response) => response.json());

  const { json, error } = await call("/invoices", {
    customer: { name: source.customer.name, email: source.customer.email ?? undefined },
    line_items: source.line_items,
    allow_partial: source.allow_partial,
    late_fee: source.late_fee ?? undefined,
    notes: source.notes ?? undefined,
  });
  if (error) return { error };
  redirect(`/dashboard/invoices/${json.id}`);
}

export async function resendReceipt(id: string, _: ActionState): Promise<ActionState> {
  const { json, error } = await call(`/payments/${id}/resend_receipt`);
  if (error) return { error };
  return { ok: `Receipt sent to ${json.to}.` };
}

export async function createLink(_: ActionState, form: FormData): Promise<ActionState> {
  const { error } = await call("/payment_links", {
    name: text(form, "name"),
    unit_amount: cents(form.get("price")),
    description: text(form, "description"),
    success_url: text(form, "success_url"),
    adjustable_quantity: form.get("adjustable_quantity") === "on",
  });
  if (error) return { error };
  revalidatePath("/dashboard/links");
  return { ok: "Payment link created." };
}

export async function deactivateLink(id: string) {
  await call(`/payment_links/${id}/deactivate`);
  revalidatePath("/dashboard/links");
}

export async function cancelSubscription(id: string) {
  await call(`/subscriptions/${id}/cancel`);
  revalidatePath("/dashboard/subscriptions");
}

export async function retrySubscription(id: string) {
  await call(`/subscriptions/${id}/retry`);
  revalidatePath("/dashboard/subscriptions");
}

export async function saveCustomerNote(id: string, form: FormData) {
  await call(`/customers/${id}/notes`, { notes: String(form.get("notes") ?? "") });
  revalidatePath("/dashboard/customers");
}

export async function matchTransfer(id: string, form: FormData) {
  await call(`/reconciliation/${id}/match`, { reference: text(form, "reference") });
  revalidatePath("/dashboard/reports");
}

export async function addWebhook(_: ActionState, form: FormData): Promise<ActionState> {
  const { json, error } = await call("/webhook_endpoints", { url: text(form, "url") });
  if (error) return { error };
  revalidatePath("/dashboard/developers");
  return { ok: `Endpoint added. Signing secret, shown once: ${json.secret}` };
}

export async function replayEvent(id: string) {
  await call(`/events/${id}/replay`);
  revalidatePath("/dashboard/developers");
}

export async function rotateKey(_: ActionState): Promise<ActionState> {
  const { json, error } = await call("/api_keys/rotate");
  if (error) return { error };
  (await cookies()).set(COOKIE, json.secret_key, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production" && process.env.INSECURE_COOKIES !== "1",
    path: "/dashboard",
  });
  return { ok: `New secret key, shown once: ${json.secret_key}` };
}

export async function saveSettings(_: ActionState, form: FormData): Promise<ActionState> {
  const { error } = await call("/account", {
    name: text(form, "name"),
    logo: text(form, "logo") ?? null,
    brand_color: text(form, "brand_color") ?? null,
    support_email: text(form, "support_email") ?? null,
    timezone: text(form, "timezone"),
    invoice_prefix: text(form, "invoice_prefix"),
    confirmations: Number(form.get("confirmations")),
    gasless: form.get("gasless") === "on",
    reminders_enabled: form.get("reminders_enabled") === "on",
  });
  if (error) return { error };
  revalidatePath("/dashboard", "layout");
  return { ok: "Settings saved." };
}
