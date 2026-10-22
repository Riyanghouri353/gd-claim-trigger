import { Sandbox } from "@e2b/code-interpreter";
import { runCode } from "./e2b";
import { createAgentImageFile } from "./files";
import { cacheScreenshot } from "./browser";
import { assertPublicUrl } from "./connectors";

/**
 * Python browser automation: a persistent Playwright driver process runs
 * inside an E2B sandbox (stateful page across calls, driven via file IPC).
 * DOM selectors instead of pixel coordinates — reliable form filling,
 * clicking, submitting and scrolling. Screenshots flow through the same
 * storage pipeline as the desktop browser.
 */

const SESSION_TTL_MS = 10 * 60_000;
const PB_DIR = "/tmp/pb";

const DRIVER = `
import json, os, sys, time, subprocess, traceback

BASE = "/tmp/pb"
os.makedirs(BASE, exist_ok=True)
CMD = BASE + "/cmd.json"
RES = BASE + "/res.json"
SHOT = BASE + "/shot.png"

def ensure_pw():
    try:
        import playwright  # noqa: F401
    except ImportError:
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "playwright"], check=False)

def launch():
    from playwright.sync_api import sync_playwright
    pw = sync_playwright().start()
    errs = []
    try:
        return pw, pw.chromium.launch(args=["--no-sandbox"])
    except Exception as e:
        errs.append(str(e)[:150])
    subprocess.run([sys.executable, "-m", "playwright", "install", "chromium"], check=False)
    try:
        return pw, pw.chromium.launch(args=["--no-sandbox"])
    except Exception as e:
        errs.append(str(e)[:150])
    for cand in ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]:
        if os.path.exists(cand):
            return pw, pw.chromium.launch(executable_path=cand, args=["--no-sandbox"])
    raise RuntimeError("no chromium available: " + " | ".join(errs))

ensure_pw()
pw, browser = launch()
ctx = browser.new_context(viewport={"width": 1280, "height": 900})
page = ctx.new_page()

def snap():
    try:
        page.screenshot(path=SHOT)
        return True
    except Exception:
        return False

def page_text():
    try:
        t = page.evaluate("() => document.body ? document.body.innerText : ''")
        return (t or "")[:8000]
    except Exception:
        return ""

def do(cmd):
    a = cmd.get("action")
    args = cmd.get("args") or {}
    if a in ("open", "goto"):
        page.goto(args["url"], wait_until="domcontentloaded", timeout=45000)
    elif a == "fill":
        page.fill(args["selector"], args.get("value", ""), timeout=15000)
    elif a == "type":
        page.locator(args["selector"]).type(args.get("value", ""), timeout=15000)
    elif a == "click":
        page.click(args["selector"], timeout=15000)
    elif a == "submit":
        sel = args.get("selector")
        if sel:
            page.eval_on_selector(sel, "f => f.requestSubmit ? f.requestSubmit() : f.submit()")
        else:
            page.keyboard.press("Enter")
    elif a == "press":
        page.keyboard.press(args.get("key", "Enter"))
    elif a == "scroll":
        d = args.get("direction", "down")
        amt = int(args.get("amount", 600))
        page.mouse.wheel(0, amt if d == "down" else -amt)
    elif a == "wait":
        page.wait_for_timeout(int(args.get("ms", 1000)))
    elif a == "screenshot":
        pass
    elif a == "read":
        pass
    elif a == "close":
        return {"ok": True, "closing": True}
    else:
        return {"ok": False, "error": "unknown action " + str(a)}
    try:
        page.wait_for_timeout(400)
    except Exception:
        pass
    res = {"ok": True, "url": page.url, "title": page.title()}
    if a in ("open", "goto", "read"):
        res["text"] = page_text()
    if args.get("screenshot") or a in ("open", "goto", "click", "submit", "screenshot"):
        if snap():
            res["shot"] = True
    return res

with open(BASE + "/ready", "w") as f:
    f.write("1")

last = 0.0
while True:
    try:
        st = os.stat(CMD)
        if st.st_mtime > last:
            cmd = None
            try:
                with open(CMD) as f:
                    cmd = json.load(f)
            except Exception:
                cmd = None
            if cmd is not None:
                last = st.st_mtime
                try:
                    res = do(cmd)
                except Exception as e:
                    res = {"ok": False, "error": str(e)[:500]}
                    if snap():
                        res["shot"] = True
                    try:
                        res["url"] = page.url
                        res["title"] = page.title()
                    except Exception:
                        pass
                res["id"] = cmd.get("id")
                with open(RES, "w") as f:
                    json.dump(res, f)
                if res.get("closing"):
                    break
    except FileNotFoundError:
        pass
    except Exception:
        traceback.print_exc()
    time.sleep(0.25)
`;

interface PySession {
  sandbox: Sandbox;
  lastUsed: number;
}

const sessions = new Map<string, PySession>();

function keyOf(conversationId: string | null): string {
  return conversationId || "default";
}

/** Race a promise against a timeout so a stuck sandbox call can never hang a tool forever. */
async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function ensureSession(key: string, apiKey: string): Promise<PySession> {
  const now = Date.now();
  const stale: string[] = [];
  sessions.forEach((s, k) => {
    if (k !== key && now - s.lastUsed > SESSION_TTL_MS) stale.push(k);
  });
  for (const k of stale) {
    sessions.get(k)?.sandbox.kill().catch(() => {});
    sessions.delete(k);
  }
  const existing = sessions.get(key);
  if (existing) {
    existing.lastUsed = now;
    await existing.sandbox.setTimeout(SESSION_TTL_MS).catch(() => {});
    return existing;
  }

  const sandbox = await Sandbox.create({ apiKey, timeoutMs: SESSION_TTL_MS });
  try {
    await sandbox.commands.run(`mkdir -p ${PB_DIR}`, { timeoutMs: 15_000 });
    await sandbox.files.write(`${PB_DIR}/driver.py`, DRIVER);
    await sandbox.commands.run(
      `nohup python3 ${PB_DIR}/driver.py > ${PB_DIR}/driver.log 2>&1 &`,
      { timeoutMs: 15_000 }
    ).catch(() => {});
    // Wait for the driver to finish installing + launching (worst case minutes).
    // Poll via shell commands (hard per-call timeouts) — never files.read on a
    // file that may not exist yet.
    let ready = false;
    for (let i = 0; i < 60 && !ready; i++) {
      const probe = await withTimeout(
        sandbox.commands.run(`test -f ${PB_DIR}/ready && echo READY || true`, { timeoutMs: 10_000 }),
        12_000,
        null
      );
      if (probe && (probe.stdout || "").includes("READY")) ready = true;
      else await new Promise((r) => setTimeout(r, 2500));
    }
    if (!ready) {
      const log = await sandbox.commands
        .run(`tail -30 ${PB_DIR}/driver.log || true`, { timeoutMs: 15_000 })
        .catch(() => null);
      throw new Error("Python browser failed to start. Log: " + (log?.stdout || "").slice(-600));
    }
  } catch (e) {
    await sandbox.kill().catch(() => {});
    throw e;
  }
  const session: PySession = { sandbox, lastUsed: Date.now() };
  sessions.set(key, session);
  return session;
}

export interface PyBrowserResult {
  ok: boolean;
  action?: string;
  url?: string;
  title?: string;
  text?: string;
  screenshotId?: string;
  screenshotPath?: string;
  error?: string;
}

export async function pyBrowserAction(
  apiKey: string,
  conversationId: string | null,
  action: string,
  args: Record<string, unknown> = {}
): Promise<PyBrowserResult> {
  const key = keyOf(conversationId);
  if (action === "close") {
    const s = sessions.get(key);
    if (s) {
      sessions.delete(key);
      await s.sandbox.kill().catch(() => {});
    }
    return { ok: true, action };
  }
  const session = await ensureSession(key, apiKey);
  session.lastUsed = Date.now();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await withTimeout(
    session.sandbox.files.write(`${PB_DIR}/cmd.json`, JSON.stringify({ id, action, args })),
    20_000,
    undefined
  );
  const timeoutMs = action === "open" || action === "goto" ? 75_000 : 45_000;
  const deadline = Date.now() + timeoutMs;
  let res: any = null;
  while (Date.now() < deadline) {
    const cat = await withTimeout(
      session.sandbox.commands.run(`cat ${PB_DIR}/res.json 2>/dev/null || true`, { timeoutMs: 10_000 }),
      12_000,
      null
    );
    const raw = (cat?.stdout || "").trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.id === id) {
          res = parsed;
          break;
        }
      } catch { /* partial write — keep polling */ }
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  if (!res) {
    return { ok: false, action, error: "Browser action timed out — the page may be slow; try read/screenshot to see the state" };
  }
  const out: PyBrowserResult = {
    ok: !!res.ok,
    action,
    url: res.url,
    title: res.title,
    text: res.text,
    error: res.ok ? undefined : res.error || "Action failed",
  };
  if (res.shot) {
    try {
      const buf = await withTimeout(
        session.sandbox.files.read(`${PB_DIR}/shot.png`, { format: "bytes" }),
        20_000,
        null
      );
      if (buf) {
        const base64 = Buffer.from(buf as ArrayBuffer).toString("base64");
        const file = await createAgentImageFile("py-browser-screenshot.png", base64, "image/png", conversationId);
        cacheScreenshot(file.id, base64);
        out.screenshotId = file.id;
        out.screenshotPath = file.path;
      }
    } catch { /* screenshot best-effort */ }
  }
  return out;
}

// --- API testing ------------------------------------------------------------

export interface ApiTestSpec {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  expectStatus?: number;
  bodyContains?: string;
  jsonPath?: string;
  jsonEquals?: unknown;
}

export interface ApiTestResult {
  ok: boolean;
  status?: number;
  timeMs?: number;
  headers?: Record<string, string>;
  body?: unknown;
  checks?: { check: string; pass: boolean; detail: string }[];
  error?: string;
}

export async function apiTest(apiKey: string, spec: ApiTestSpec): Promise<ApiTestResult> {
  const url = new URL(spec.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "Only http(s) URLs are allowed" };
  }
  await assertPublicUrl(url); // blocks private/loopback targets

  const py = `
import requests, json, time

spec = json.loads(${JSON.stringify(JSON.stringify(spec))})
method = (spec.get("method") or "GET").upper()
kwargs = {"headers": spec.get("headers") or {}, "timeout": 30}
if spec.get("body") is not None:
    if isinstance(spec["body"], (dict, list)):
        kwargs["json"] = spec["body"]
    else:
        kwargs["data"] = spec["body"]
t0 = time.time()
try:
    r = requests.request(method, spec["url"], **kwargs)
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)[:400]}))
    raise SystemExit
ms = int((time.time() - t0) * 1000)
body_text = r.text or ""
parsed = None
try:
    parsed = r.json()
except Exception:
    parsed = None
checks = []
if spec.get("expectStatus") is not None:
    checks.append({"check": "status == %s" % spec["expectStatus"], "pass": r.status_code == spec["expectStatus"], "detail": "got %s" % r.status_code})
if spec.get("bodyContains"):
    checks.append({"check": "body contains", "pass": spec["bodyContains"] in body_text, "detail": spec["bodyContains"][:60]})
if spec.get("jsonPath"):
    cur = parsed
    okp = True
    for part in str(spec["jsonPath"]).split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        elif isinstance(cur, list) and part.isdigit() and int(part) < len(cur):
            cur = cur[int(part)]
        else:
            okp = False
            break
    detail = ("value: " + json.dumps(cur)[:200]) if okp else "path not found"
    if spec.get("jsonEquals") is not None:
        checks.append({"check": "json %s equals" % spec["jsonPath"], "pass": okp and cur == spec["jsonEquals"], "detail": detail})
    else:
        checks.append({"check": "json path exists: %s" % spec["jsonPath"], "pass": okp, "detail": detail})
out = {
    "ok": all(c["pass"] for c in checks) if checks else True,
    "status": r.status_code,
    "timeMs": ms,
    "headers": {k: v for k, v in list(r.headers.items())[:20]},
    "body": parsed if parsed is not None else body_text[:4000],
    "checks": checks,
}
print(json.dumps(out))
`;
  const result = await runCode(apiKey, py, "python");
  const stdout = (result.stdout || "").trim();
  const line = stdout.split("\n").filter(Boolean).pop();
  if (!line) {
    return { ok: false, error: result.error || result.stderr?.slice(0, 400) || "API test produced no output" };
  }
  try {
    return JSON.parse(line) as ApiTestResult;
  } catch {
    return { ok: false, error: "Unparseable API test output: " + line.slice(0, 300) };
  }
}
