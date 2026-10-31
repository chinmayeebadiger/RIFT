import { NextResponse } from "next/server";
import { auditHtml } from "@/lib/audit-html";
import { AuditFetchError, fetchWebsite } from "@/lib/audit-fetch";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    if (Number(request.headers.get("content-length")) > 4096) return NextResponse.json({ error: "The request is too large. Enter a website URL only." }, { status: 413 });
    const raw = await request.text();
    if (raw.length > 4096) return NextResponse.json({ error: "The request is too large. Enter a website URL only." }, { status: 413 });
    let body: { url?: unknown };
    try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "Enter a valid website address." }, { status: 400 }); }
    const result = await fetchWebsite(body?.url);
    return NextResponse.json(auditHtml(result.html, result.url, result.durationMs));
  } catch (error) {
    const known = error instanceof AuditFetchError;
    return NextResponse.json({ error: known ? error.message : "Rift could not reach this website. It may block automated requests or be temporarily unavailable. Check the address and try again." }, { status: known ? 400 : 502 });
  }
}
