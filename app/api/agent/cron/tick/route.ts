import { NextResponse } from "next/server";
import { runDueTasks } from "@/lib/agent/task-runner";

export const dynamic = "force-dynamic";

/**
 * Cron tick for scheduled agent tasks. Hit every ~5 minutes by an external
 * scheduler (cron-job.org) with the CRON_SECRET bearer. Starts due tasks
 * in the background and returns immediately.
 */
async function handle(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { started } = await runDueTasks(3);
  return NextResponse.json({ ok: true, started });
}

export async function GET(req: Request) {
  return handle(req);
}

export async function POST(req: Request) {
  return handle(req);
}
