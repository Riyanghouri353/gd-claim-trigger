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
    args = ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
    errs = []
    try:
        return pw, pw.chromium.launch(args=args)
    except Exception as e:
        errs.append(str(e)[:150])
    # Root in the sandbox: --with-deps also apt-installs Chromium's system
    # libraries (libnss3, libnspr4, ...) which the base image lacks.
    subprocess.run([sys.executable, "-m", "playwright", "install", "--with-deps", "chromium-headless-shell"], check=False)
    try:
        return pw, pw.chromium.launch(args=args)
    except Exception as e:
        errs.append(str(e)[:150])
    subprocess.run([sys.executable, "-m", "playwright", "install", "chromium"], check=False)
    try:
        return pw, pw.chromium.launch(args=args)
    except Exception as e:
        errs.append(str(e)[:150])
    for cand in ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]:
        if os.path.exists(cand):
            return pw, pw.chromium.launch(executable_path=cand, args=args)
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

INSPECT_JS = r"""
() => {
  function selFor(el) {
    if (el.id) return "#" + el.id;
    if (el.name) return el.tagName.toLowerCase() + "[name='" + el.name + "']";
    const ph = el.getAttribute("placeholder");
    if (ph) return "[placeholder='" + ph + "']";
    const al = el.getAttribute("aria-label");
    if (al) return "[aria-label='" + al + "']";
    return el.tagName.toLowerCase();
  }
  function labelFor(el) {
    if (el.labels && el.labels.length) return (el.labels[0].innerText || "").trim().slice(0, 60);
    return "";
  }
  const forms = [];
  document.querySelectorAll("form").forEach((f, i) => {
    const fields = [];
    f.querySelectorAll("input, select, textarea").forEach((el) => {
      fields.push({
        tag: el.tagName.toLowerCase(), type: el.getAttribute("type") || "",
        name: el.getAttribute("name") || "", id: el.id || "",
        placeholder: el.getAttribute("placeholder") || "",
        label: labelFor(el), required: !!el.required, selector: selFor(el)
      });
    });
    forms.push({ index: i, action: f.getAttribute("action") || "", method: (f.getAttribute("method") || "get").toLowerCase(), id: f.id || "", selector: f.id ? "#" + f.id : "form", fields: fields });
  });
  const clickables = [];
  document.querySelectorAll("button, input[type='submit'], input[type='button'], a[href], [role='button']").forEach((el) => {
    const text = (el.innerText || el.value || "").trim().slice(0, 50);
    if (clickables.length < 40) clickables.push({ tag: el.tagName.toLowerCase(), text: text, selector: selFor(el) });
  });
  const loose = [];
  document.querySelectorAll("input, select, textarea").forEach((el) => {
    if (!el.closest("form") && loose.length < 30) {
      loose.push({ tag: el.tagName.toLowerCase(), type: el.getAttribute("type") || "", name: el.getAttribute("name") || "", id: el.id || "", placeholder: el.getAttribute("placeholder") || "", label: labelFor(el), selector: selFor(el) });
    }
  });
  return { url: location.href, title: document.title, forms: forms, clickables: clickables, looseFields: loose };
}
"""

def do(cmd):
    a = cmd.get("action")
    args = cmd.get("args") or {}
    if a in ("open", "goto"):
        page.goto(args["url"], wait_until="domcontentloaded", timeout=45000)
    elif a == "inspect":
        res0 = {"ok": True, "url": page.url, "title": page.title(), "elements": page.evaluate(INSPECT_JS)}
        if args.get("screenshot"):
            if snap():
                res0["shot"] = True
        return res0
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
        if args.get("selector"):
            page.locator(args["selector"]).scroll_into_view_if_needed(timeout=10000)
        else:
            d = args.get("direction", "down")
            amt = int(args.get("amount", 600))
            page.mouse.wheel(0, amt if d == "down" else -amt)
    elif a == "wait_for":
        import time as _t
        deadline = _t.time() + int(args.get("ms", 10000)) / 1000.0
        met = False
        while _t.time() < deadline and not met:
            try:
                if args.get("selector"):
                    loc = page.locator(args["selector"])
                    if loc.count() > 0 and loc.first.is_visible():
                        met = True
                elif args.get("text"):
                    if args["text"] in page.content():
                        met = True
                elif args.get("urlContains"):
                    if args["urlContains"] in page.url:
                        met = True
                else:
                    page.wait_for_load_state("networkidle", timeout=1500)
                    met = True
            except Exception:
                pass
            if not met:
                page.wait_for_timeout(300)
        res1 = {"ok": met, "url": page.url, "title": page.title(),
                "error": None if met else "wait_for timed out (selector/text/url condition not met)"}
        if args.get("screenshot") or not met:
            if snap():
                res1["shot"] = True
        return res1
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
    if a in ("click", "submit"):
        try:
            page.wait_for_load_state("networkidle", timeout=6000)
        except Exception:
            pass
    res = {"ok": True, "url": page.url, "title": page.title()}
    if a in ("open", "goto", "read", "click", "submit"):
        res["text"] = page_text()
    if a in ("fill", "type") and args.get("selector"):
        try:
            res["value"] = page.input_value(args["selector"], timeout=3000)
        except Exception:
            res["value"] = ""
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
    // Run the driver as root: it must pip-install Playwright and apt-install
    // Chromium's system libraries on first run.
    await sandbox.commands.run(
      `nohup python3 ${PB_DIR}/driver.py > ${PB_DIR}/driver.log 2>&1 &`,
      { timeoutMs: 15_000, user: "root" } as any
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
  /** fill/type read-back: the field's actual value after the action */
  value?: string;
  /** inspect action: the page's forms/fields/clickables map */
  elements?: unknown;
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
    value: res.value,
    elements: res.elements,
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
  /** Multi-step mode: run these steps in order in one session. A step may
   *  `extract` values from its JSON response ({varName: "dot.path"}) and use
   *  them in later steps as {{varName}} in url/headers/body. */
  steps?: ApiTestStepSpec[];
}

export interface ApiTestStepSpec {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  expectStatus?: number;
  bodyContains?: string;
  jsonPath?: string;
  jsonEquals?: unknown;
  extract?: Record<string, string>;
}

export interface ApiStepResult {
  step: number;
  ok: boolean;
  status?: number;
  timeMs?: number;
  checks?: { check: string; pass: boolean; detail: string }[];
  body?: unknown;
  extracted?: string[];
  error?: string;
}

export interface ApiTestResult {
  ok: boolean;
  status?: number;
  timeMs?: number;
  headers?: Record<string, string>;
  body?: unknown;
  checks?: { check: string; pass: boolean; detail: string }[];
  steps?: ApiStepResult[];
  vars?: Record<string, string>;
  error?: string;
}

const API_PY = `
import requests, json, time, re

spec = json.loads(SPEC_JSON)
steps = spec.get("steps") or [spec]
vars = {}

def sub(obj):
    if isinstance(obj, str):
        def rep(m):
            v = vars.get(m.group(1))
            return "" if v is None else str(v)
        return re.sub(r"\\{\\{(\\w+)\\}\\}", rep, obj)
    if isinstance(obj, dict):
        return {k: sub(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [sub(v) for v in obj]
    return obj

def get_path(obj, path):
    cur = obj
    for part in str(path).split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        elif isinstance(cur, list) and part.isdigit() and int(part) < len(cur):
            cur = cur[int(part)]
        else:
            return None, False
    return cur, True

results = []
all_ok = True
for i, raw_step in enumerate(steps):
    step = sub(raw_step)
    method = (step.get("method") or "GET").upper()
    kwargs = {"headers": step.get("headers") or {}, "timeout": 30}
    if step.get("body") is not None:
        if isinstance(step["body"], (dict, list)):
            kwargs["json"] = step["body"]
        else:
            kwargs["data"] = step["body"]
    t0 = time.time()
    try:
        r = requests.request(method, step["url"], **kwargs)
    except Exception as e:
        results.append({"step": i + 1, "ok": False, "error": str(e)[:400]})
        all_ok = False
        break
    ms = int((time.time() - t0) * 1000)
    body_text = r.text or ""
    parsed = None
    try:
        parsed = r.json()
    except Exception:
        parsed = None
    checks = []
    if step.get("expectStatus") is not None:
        checks.append({"check": "status == %s" % step["expectStatus"], "pass": r.status_code == step["expectStatus"], "detail": "got %s" % r.status_code})
    if step.get("bodyContains"):
        checks.append({"check": "body contains", "pass": step["bodyContains"] in body_text, "detail": step["bodyContains"][:60]})
    if step.get("jsonPath"):
        cur, okp = get_path(parsed, step["jsonPath"])
        detail = ("value: " + json.dumps(cur)[:200]) if okp else "path not found"
        if step.get("jsonEquals") is not None:
            checks.append({"check": "json %s equals" % step["jsonPath"], "pass": okp and cur == step["jsonEquals"], "detail": detail})
        else:
            checks.append({"check": "json path exists: %s" % step["jsonPath"], "pass": okp, "detail": detail})
    extracted = []
    for name, path in (step.get("extract") or {}).items():
        val, okp = get_path(parsed, path)
        vars[name] = val if okp else None
        extracted.append(name)
    step_ok = all(c["pass"] for c in checks) if checks else True
    entry = {
        "step": i + 1, "ok": step_ok, "status": r.status_code, "timeMs": ms,
        "checks": checks,
        "body": parsed if parsed is not None else body_text[:1500],
        "extracted": extracted,
    }
    if i == 0:
        entry["headers"] = {k: v for k, v in list(r.headers.items())[:20]}
    results.append(entry)
    if not step_ok:
        all_ok = False
        break

out = {"ok": all_ok, "steps": results,
       "vars": {k: (str(v)[:16] + "..." if v is not None and len(str(v)) > 16 else v) for k, v in vars.items()}}
if results:
    first = results[0]
    out["status"] = first.get("status")
    out["timeMs"] = first.get("timeMs")
    out["headers"] = first.get("headers")
    out["body"] = first.get("body")
    out["checks"] = first.get("checks")
print(json.dumps(out))
`;

export async function apiTest(apiKey: string, spec: ApiTestSpec): Promise<ApiTestResult> {
  const allSteps = spec.steps && spec.steps.length > 0 ? spec.steps : [spec];
  for (const s of allSteps) {
    const url = new URL(s.url.replace(/\{\{\w+\}\}/g, "x")); // template-safe parse
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, error: "Only http(s) URLs are allowed" };
    }
    if (!/\{\{/.test(s.url)) {
      await assertPublicUrl(new URL(s.url)); // blocks private/loopback targets
    }
  }
  const normalized = { ...spec, steps: allSteps };
  const py = API_PY.replace("SPEC_JSON", JSON.stringify(JSON.stringify(normalized)));
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

// --- Structured site tests ---------------------------------------------------

export interface SiteTestStep {
  action: "open" | "inspect" | "fill" | "type" | "click" | "submit" | "press" | "scroll" | "wait_for" | "read" | "screenshot";
  url?: string;
  selector?: string;
  value?: string;
  key?: string;
  direction?: "up" | "down";
  amount?: number;
  note?: string;
  expect?: {
    textContains?: string;
    urlContains?: string;
    titleContains?: string;
    valueEquals?: string;
  };
}

export interface SiteTestReport {
  ok: boolean;
  totalSteps: number;
  passedCount: number;
  stoppedAtStep?: number;
  results: {
    step: number;
    action: string;
    note?: string;
    ok: boolean;
    observed: { url?: string; title?: string; value?: string };
    failures: string[];
    error?: string;
    screenshotPath?: string;
  }[];
}

/**
 * Execute a planned site test in the py_browser session: each step runs,
 * its expectations are checked against what was actually observed, and the
 * run stops at the first failure with a screenshot for diagnosis.
 */
export async function runSiteTest(
  apiKey: string,
  conversationId: string | null,
  steps: SiteTestStep[]
): Promise<SiteTestReport> {
  const results: SiteTestReport["results"] = [];
  let stoppedAtStep: number | undefined;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const r = await pyBrowserAction(apiKey, conversationId, step.action, {
      url: step.url,
      selector: step.selector,
      value: step.value,
      key: step.key,
      direction: step.direction,
      amount: step.amount,
      text: step.expect?.textContains,
      urlContains: step.expect?.urlContains,
    });
    const failures: string[] = [];
    if (!r.ok) failures.push(r.error || "action failed");
    const exp = step.expect || {};
    if (exp.textContains && !(r.text || "").includes(exp.textContains)) {
      failures.push(`expected page text to contain "${exp.textContains}"`);
    }
    if (exp.urlContains && !(r.url || "").includes(exp.urlContains)) {
      failures.push(`expected URL to contain "${exp.urlContains}", got "${r.url || ""}"`);
    }
    if (exp.titleContains && !(r.title || "").includes(exp.titleContains)) {
      failures.push(`expected title to contain "${exp.titleContains}", got "${r.title || ""}"`);
    }
    if (exp.valueEquals !== undefined && r.value !== exp.valueEquals) {
      failures.push(`expected field value "${exp.valueEquals}", got "${r.value ?? ""}"`);
    }
    const ok = failures.length === 0;
    const entry: SiteTestReport["results"][number] = {
      step: i + 1,
      action: step.action,
      note: step.note,
      ok,
      observed: { url: r.url, title: r.title, value: r.value },
      failures,
      error: r.ok ? undefined : r.error,
      screenshotPath: r.screenshotPath,
    };
    if (!ok) {
      if (!entry.screenshotPath) {
        const shot = await pyBrowserAction(apiKey, conversationId, "screenshot", {}).catch(() => null);
        if (shot?.screenshotPath) entry.screenshotPath = shot.screenshotPath;
      }
      results.push(entry);
      stoppedAtStep = i + 1;
      break;
    }
    results.push(entry);
  }
  return {
    ok: stoppedAtStep === undefined,
    totalSteps: steps.length,
    passedCount: results.filter((x) => x.ok).length,
    stoppedAtStep,
    results,
  };
}
