import { NextResponse } from "next/server";
import { requireSession } from "@/lib/agent/auth";
import { getSetting, setSetting } from "@/lib/agent/keys";

export async function GET() {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const [chat_model, system_prompt] = await Promise.all([
    getSetting("chat_model"),
    getSetting("system_prompt"),
  ]);
  return NextResponse.json({
    chat_model: chat_model || "openai/gpt-oss-120b",
    system_prompt: system_prompt || "",
  });
}

export async function POST(req: Request) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { chat_model, system_prompt } = await req.json();
  if (chat_model) await setSetting("chat_model", String(chat_model));
  if (system_prompt !== undefined) await setSetting("system_prompt", String(system_prompt));
  return NextResponse.json({ ok: true });
}
