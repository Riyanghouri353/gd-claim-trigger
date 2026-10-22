import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import {
  listTestAccounts,
  createTestAccount,
  deleteTestAccount,
  generateTestIdentity,
  getTestEmailDomain,
  setTestEmailDomain,
} from "@/lib/agent/test-accounts";

export const dynamic = "force-dynamic";

async function authed() {
  try {
    await requireSession();
    return true;
  } catch {
    return false;
  }
}

/** Test accounts vault — lists SAFE fields only (never passwords). */
export async function GET() {
  if (!(await authed())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const [accounts, emailDomain] = await Promise.all([listTestAccounts(), getTestEmailDomain()]);
    return NextResponse.json({ accounts, emailDomain });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed to load accounts" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!(await authed())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  try {
    if (body.generate) {
      if (!body.site) return NextResponse.json({ error: "site is required" }, { status: 400 });
      const account = await generateTestIdentity(String(body.site), body.label ? String(body.label) : undefined);
      return NextResponse.json({ account });
    }
    if (body.emailDomain !== undefined) {
      await setTestEmailDomain(String(body.emailDomain || "example.com"));
      return NextResponse.json({ ok: true, emailDomain: await getTestEmailDomain() });
    }
    if (!body.site || !body.password) {
      return NextResponse.json({ error: "site and password are required" }, { status: 400 });
    }
    const account = await createTestAccount({
      site: String(body.site),
      label: body.label ? String(body.label) : "",
      email: body.email ? String(body.email) : "",
      username: body.username ? String(body.username) : "",
      password: String(body.password),
    });
    return NextResponse.json({ account });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed to save account" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  if (!(await authed())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  try {
    await deleteTestAccount(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed to delete account" }, { status: 500 });
  }
}
