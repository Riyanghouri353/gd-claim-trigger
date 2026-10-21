import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import {
  getHostingConfig,
  setHostingConfig,
  deleteHostingConfig,
  testVercelToken,
  testCloudflareToken,
} from "@/lib/agent/hosting";

export const dynamic = "force-dynamic";

async function status() {
  const cfg = await getHostingConfig();
  return {
    vercel: !!cfg.vercelToken,
    vercelTeamId: cfg.vercelTeamId ?? "",
    cloudflare: !!cfg.cloudflareToken,
  };
}

/** Hosting-token status for the website builder. Tokens are never returned. */
export async function GET() {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await status());
}

/** Save hosting tokens. Provided tokens are verified against their APIs first. */
export async function POST(req: Request) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}) as any);
  const patch: Record<string, string | undefined> = {};

  if (typeof body.vercelToken === "string" && body.vercelToken.trim()) {
    const test = await testVercelToken(body.vercelToken.trim());
    if (!test.ok) {
      return NextResponse.json({ error: `Vercel token rejected: ${test.error}` }, { status: 400 });
    }
    patch.vercelToken = body.vercelToken;
  }
  if (typeof body.vercelTeamId === "string") patch.vercelTeamId = body.vercelTeamId;
  if (typeof body.cloudflareToken === "string" && body.cloudflareToken.trim()) {
    const test = await testCloudflareToken(body.cloudflareToken.trim());
    if (!test.ok) {
      return NextResponse.json({ error: `Cloudflare token rejected: ${test.error}` }, { status: 400 });
    }
    patch.cloudflareToken = body.cloudflareToken;
  }

  await setHostingConfig(patch);
  return NextResponse.json(await status());
}

export async function DELETE() {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  await deleteHostingConfig();
  return NextResponse.json({ ok: true });
}
