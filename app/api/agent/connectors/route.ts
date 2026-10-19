import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import {
  listConnectors,
  saveConnector,
  testConnector,
  type AuthType,
  type ConnectorConfig,
} from "@/lib/agent/connectors";

export const dynamic = "force-dynamic";

const AUTH_TYPES: AuthType[] = ["bearer", "header", "query", "basic", "none"];

/** List connectors (metadata only — secrets never leave the server). */
export async function GET() {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const connectors = await listConnectors();
    return NextResponse.json({ connectors });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Database error" }, { status: 500 });
  }
}

/** Add a connector: validated, live-tested, then saved encrypted. */
export async function POST(req: Request) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { name, baseUrl, authType, authField, key, testPath } = await req.json();

  const cleanName = String(name || "").trim();
  if (!/^[a-z0-9][a-z0-9 _-]{1,39}$/i.test(cleanName)) {
    return NextResponse.json(
      { error: "Name: 2–40 chars, letters/numbers/spaces/_/-" },
      { status: 400 }
    );
  }
  let url: URL;
  try {
    url = new URL(String(baseUrl || "").trim());
  } catch {
    return NextResponse.json({ error: "Invalid base URL" }, { status: 400 });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return NextResponse.json({ error: "Base URL must be http(s)" }, { status: 400 });
  }
  if (!AUTH_TYPES.includes(authType)) {
    return NextResponse.json({ error: "Invalid auth type" }, { status: 400 });
  }
  const secret = String(key || "").trim();
  if (authType !== "none" && !secret) {
    return NextResponse.json({ error: "API key is required" }, { status: 400 });
  }
  if ((authType === "header" || authType === "query" || authType === "basic") && !String(authField || "").trim()) {
    return NextResponse.json(
      { error: "Auth field required (header name / query param / username)" },
      { status: 400 }
    );
  }

  const cfg: ConnectorConfig = {
    baseUrl: url.toString().replace(/\/+$/, ""),
    authType,
    authField: String(authField || "").trim() || undefined,
    key: secret,
    testPath: String(testPath || "").trim() || undefined,
  };

  const check = await testConnector(cfg);
  if (!check.ok) {
    return NextResponse.json({ error: `Test failed: ${check.detail}` }, { status: 400 });
  }
  try {
    await saveConnector(cleanName, cfg);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Database error" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, detail: check.detail });
}
