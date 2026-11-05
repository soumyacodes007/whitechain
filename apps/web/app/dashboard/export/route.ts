import { type NextRequest, NextResponse } from "next/server";
import { secretKey } from "../lib";

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const KINDS = ["export.csv", "export.xlsx", "accountant-pack.zip"];

/** Streams a report through this server, so the secret key never reaches the browser. */
export async function GET(request: NextRequest) {
  const key = await secretKey();
  const params = request.nextUrl.searchParams;
  const kind = params.get("kind") ?? "";
  if (!key || !KINDS.includes(kind)) return new NextResponse("Not found", { status: 404 });

  params.delete("kind");
  const response = await fetch(`${API_URL}/v1/reports/${kind}?${params}`, {
    headers: { authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  return new NextResponse(response.body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/octet-stream",
      "content-disposition": response.headers.get("content-disposition") ?? "attachment",
    },
  });
}
