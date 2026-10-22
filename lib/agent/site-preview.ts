import { Sandbox } from "@e2b/code-interpreter";
import { getE2BKey } from "./e2b";
import { getAllFiles, resolveSite, syncScaffoldFiles, type SiteRow } from "./sites";

/**
 * Live preview WITHOUT Vercel: a site's files are synced into an E2B
 * sandbox, built there (build output = the agent's test report), smoke-
 * tested with Python from inside the sandbox, then served — E2B exposes
 * the port on a public URL the user can open for ~10 minutes.
 */

const PREVIEW_TTL_MS = 10 * 60_000;
const WORKDIR = "/home/user/site";

interface PreviewSession {
  siteId: string;
  slug: string;
  sandbox: Sandbox;
  url: string;
  startedAt: number;
}

const sessions = new Map<string, PreviewSession>();

export interface PreviewResult {
  ok: boolean;
  site?: string;
  url?: string;
  buildOk?: boolean;
  buildLog?: string;
  smoke?: { status: number; title: string } | null;
  expiresInMin?: number;
  error?: string;
}

function tail(text: string, n = 2500): string {
  return text.length > n ? text.slice(-n) : text;
}

async function killSession(siteId: string): Promise<void> {
  const s = sessions.get(siteId);
  if (!s) return;
  sessions.delete(siteId);
  try {
    await s.sandbox.kill();
  } catch { /* already gone */ }
}

export async function stopSitePreview(siteId: string): Promise<{ ok: boolean }> {
  await killSession(siteId);
  return { ok: true };
}

export function getSitePreview(siteId: string): PreviewResult | null {
  const s = sessions.get(siteId);
  if (!s) return null;
  if (Date.now() - s.startedAt > PREVIEW_TTL_MS) {
    void killSession(siteId);
    return null;
  }
  return {
    ok: true,
    site: s.slug,
    url: s.url,
    expiresInMin: Math.max(0, Math.round((PREVIEW_TTL_MS - (Date.now() - s.startedAt)) / 60000)),
  };
}

export async function startSitePreview(idOrSlug: string): Promise<PreviewResult> {
  const site: SiteRow | null = await resolveSite(idOrSlug).catch(() => null);
  if (!site) return { ok: false, error: "Site not found" };
  const apiKey = await getE2BKey().catch(() => null);
  if (!apiKey) {
    return { ok: false, site: site.slug, error: "E2B is not configured — add the E2B API key in Settings first" };
  }

  await killSession(site.id);
  await syncScaffoldFiles(site).catch(() => {});
  const files = await getAllFiles(site.id);
  if (files.length === 0) return { ok: false, site: site.slug, error: "Site has no files" };

  let sandbox: Sandbox | null = null;
  try {
    sandbox = await Sandbox.create({ apiKey, timeoutMs: PREVIEW_TTL_MS });

    // Node is required for a Next.js site; check before doing real work.
    const nodeCheck = await sandbox.commands.run("node -v && npm -v", { timeoutMs: 30_000 }).catch(() => null);
    if (!nodeCheck || nodeCheck.exitCode !== 0) {
      await sandbox.kill().catch(() => {});
      return { ok: false, site: site.slug, error: "The E2B sandbox has no Node.js runtime, so it cannot build a Next.js site" };
    }

    // Write the site's files
    const dirs = new Set<string>();
    for (const f of files) {
      const parts = f.path.split("/").slice(0, -1);
      if (parts.length) dirs.add(parts.join("/"));
    }
    if (dirs.size) {
      await sandbox.commands.run(
        "mkdir -p " + Array.from(dirs).map((d) => `${WORKDIR}/${d}`).join(" "),
        { timeoutMs: 30_000 }
      );
    }
    for (const f of files) {
      await sandbox.files.write(`${WORKDIR}/${f.path}`, f.content);
    }

    // Install + build — the build IS the agent's automated test of the site.
    const install = await sandbox.commands.run("cd " + WORKDIR + " && npm install --no-audit --no-fund", {
      timeoutMs: 420_000,
    });
    if (install.exitCode !== 0) {
      const log = tail((install.stdout || "") + "\n" + (install.stderr || ""));
      await sandbox.kill().catch(() => {});
      return { ok: false, site: site.slug, buildOk: false, buildLog: log, error: "npm install failed in the sandbox" };
    }
    const build = await sandbox.commands.run("cd " + WORKDIR + " && npm run build", { timeoutMs: 300_000 });
    const buildLog = tail((build.stdout || "") + "\n" + (build.stderr || ""));
    if (build.exitCode !== 0) {
      await sandbox.kill().catch(() => {});
      return { ok: false, site: site.slug, buildOk: false, buildLog, error: "Site build FAILED — fix the errors in the build log and preview again" };
    }

    // Serve the production build
    await sandbox.commands.run(
      `cd ${WORKDIR} && nohup npx next start -p 3000 -H 0.0.0.0 > /tmp/next.log 2>&1 &`,
      { timeoutMs: 30_000 }
    ).catch(() => {});

    // Wait until it answers locally
    let up = false;
    for (let i = 0; i < 24 && !up; i++) {
      const probe = await sandbox.commands
        .run("curl -s -o /dev/null -w '%{http_code}' http://localhost:3000 || true", { timeoutMs: 15_000 })
        .catch(() => null);
      if (probe && /200|301|302|307|308/.test(probe.stdout || "")) up = true;
      else await new Promise((r) => setTimeout(r, 2500));
    }
    if (!up) {
      const log = await sandbox.commands.run("tail -50 /tmp/next.log || true", { timeoutMs: 15_000 }).catch(() => null);
      await sandbox.kill().catch(() => {});
      return { ok: false, site: site.slug, buildOk: true, buildLog, error: "Server did not come up. Log: " + tail(log?.stdout || "", 1200) };
    }

    // Python smoke test from inside the sandbox (status + page title)
    let smoke: { status: number; title: string } | null = null;
    try {
      const py = [
        "import requests, re",
        "r = requests.get('http://localhost:3000', timeout=20)",
        "m = re.search(r'<title>(.*?)</title>', r.text, re.I | re.S)",
        "print(r.status_code)",
        "print((m.group(1).strip() if m else '')[:120])",
      ].join("\n");
      const exec = await sandbox.runCode(py, { language: "python" });
      const lines = (exec.logs?.stdout || []).join("\n").split("\n").filter(Boolean);
      if (lines.length) {
        smoke = { status: parseInt(lines[0], 10) || 0, title: lines[1] || "" };
      }
    } catch { /* smoke test is best-effort */ }

    const host = (sandbox as any).getHost?.(3000);
    if (!host) {
      await sandbox.kill().catch(() => {});
      return { ok: false, site: site.slug, buildOk: true, error: "Sandbox did not expose a public host for the preview port" };
    }
    const url = "https://" + host;
    sessions.set(site.id, { siteId: site.id, slug: site.slug, sandbox, url, startedAt: Date.now() });
    return {
      ok: true,
      site: site.slug,
      url,
      buildOk: true,
      buildLog: tail(buildLog, 1200),
      smoke,
      expiresInMin: Math.round(PREVIEW_TTL_MS / 60000),
    };
  } catch (e: any) {
    try {
      await sandbox?.kill();
    } catch { /* ignore */ }
    return { ok: false, site: site.slug, error: `Preview failed: ${e?.message || e}` };
  }
}
