import { NextResponse } from "next/server";
import { resolveSite } from "@/lib/agent/sites";
import {
  sanitizeSubmissionData,
  storeSubmission,
  submissionRateExceeded,
} from "@/lib/agent/submissions";

export const dynamic = "force-dynamic";

/**
 * PUBLIC endpoint: forms on generated websites POST here.
 * A site's LeadForm sends { form, data }; the row lands in that site's
 * submissions inbox. Public by design (like Formspree): bounded payloads,
 * sanitized flat data, per-IP rate limit, CORS only for the site's own
 * domains (*.veritask.site) and its Vercel previews (*.vercel.app).
 */

function corsOrigin(req: Request): string | null {
  const origin = req.headers.get("origin");
  if (!origin) return null;
  try {
    const host = new URL(origin).hostname;
    if (host.endsWith(".veritask.site") || host === "veritask.site" || host.endsWith(".vercel.app")) {
      return origin;
    }
  } catch { /* ignore */ }
  return null;
}

function withCors(req: Request, res: NextResponse): NextResponse {
  const o = corsOrigin(req);
  if (o) {
    res.headers.set("Access-Control-Allow-Origin", o);
    res.headers.set("Vary", "Origin");
  }
  return res;
}

export async function OPTIONS(req: Request) {
  const res = new NextResponse(null, { status: 204 });
  res.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  res.headers.set("Access-Control-Max-Age", "86400");
  return withCors(req, res);
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const site = await resolveSite(slug).catch(() => null);
  if (!site) {
    return withCors(req, NextResponse.json({ error: "Site not found" }, { status: 404 }));
  }

  const len = Number(req.headers.get("content-length") || 0);
  if (len > 24_000) {
    return withCors(req, NextResponse.json({ error: "Payload too large" }, { status: 413 }));
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return withCors(req, NextResponse.json({ error: "Invalid body" }, { status: 400 }));
  }
  const formName = String((body as any).form || "contact")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 40) || "contact";
  const data = sanitizeSubmissionData((body as any).data);
  if (!data || Object.keys(data).length === 0) {
    return withCors(req, NextResponse.json({ error: "No form data" }, { status: 400 }));
  }

  const ip =
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    null;
  if (await submissionRateExceeded(site.id, ip)) {
    return withCors(
      req,
      NextResponse.json({ error: "Too many submissions — try again later" }, { status: 429 })
    );
  }

  try {
    await storeSubmission(site.id, formName, data, ip);
  } catch {
    return withCors(req, NextResponse.json({ error: "Could not save" }, { status: 500 }));
  }
  return withCors(req, NextResponse.json({ ok: true }));
}
