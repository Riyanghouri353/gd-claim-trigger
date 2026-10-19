import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import { deleteConnector, setConnectorEnabled } from "@/lib/agent/connectors";

export const dynamic = "force-dynamic";

/** Delete a connector. */
export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  try {
    await deleteConnector(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Database error" }, { status: 500 });
  }
}

/** Enable / disable a connector. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const { enabled } = await req.json();
  try {
    await setConnectorEnabled(id, !!enabled);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Database error" }, { status: 500 });
  }
}
