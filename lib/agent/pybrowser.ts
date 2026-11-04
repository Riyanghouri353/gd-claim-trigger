import { Sandbox } from "@e2b/code-interpreter";
import { runCode } from "./e2b";
import { createAgentImageFile } from "./files";
import { cacheScreenshot } from "./browser";
import { assertPublicUrl } from "./connectors";
import { resolveAccountField } from "./test-accounts";

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

# --- Network capture + interception -------------------------------------
# Every request/response is logged (method, url, type, status, request
# payload, response body fetched lazily at read time). Rules installed via
# net_intercept rewrite traffic in the route handler: mock (fulfill with a
# canned response), block (abort), modify (continue with changed url /
# headers / method / body). Rules persist until net_stop.
import fnmatch

NET = {"log": [], "rules": [], "seq": 0, "rid": 0}

def _net_match(pattern, url):
    if not pattern:
        return True
    if "*" in pattern:
        return fnmatch.fnmatch(url, pattern)
    return pattern in url

def _net_add(entry):
    NET["seq"] += 1
    entry["id"] = NET["seq"]
    NET["log"].append(entry)
    if len(NET["log"]) > 300:
        NET["log"] = NET["log"][-300:]
    return entry

def _net_find_pending(url, method):
    for e in reversed(NET["log"]):
        if e.get("url") == url and e.get("method") == method and e.get("status") is None:
            return e
    return None

def _pb_route(route):
    req = route.request
    try:
        for r in list(NET["rules"]):
            if _net_match(r.get("pattern", ""), req.url):
                mode = r.get("mode", "mock")
                e = _net_find_pending(req.url, req.method)
                if e is None:
                    e = _net_add({"method": req.method, "url": req.url, "type": req.resource_type, "status": None, "postData": None, "body": None})
                e["intercepted"] = mode
                if mode == "block":
                    route.abort()
                    return
                if mode == "mock":
                    e["status"] = int(r.get("status", 200))
                    route.fulfill(status=int(r.get("status", 200)), body=r.get("body", ""), content_type=r.get("contentType", "application/json"))
                    return
                if mode == "modify":
                    headers = dict(req.headers)
                    for h in (r.get("removeHeaders") or []):
                        headers.pop(str(h).lower(), None)
                    for k, v in (r.get("addHeaders") or {}).items():
                        headers[str(k).lower()] = v
                    kw = {"headers": headers}
                    if r.get("newUrl"):
                        kw["url"] = r["newUrl"]
                    if r.get("method"):
                        kw["method"] = r["method"]
                    if r.get("postData") is not None:
                        kw["post_data"] = r["postData"]
                    route.continue_(**kw)
                    return
        route.continue_()
    except Exception:
        try:
            route.continue_()
        except Exception:
            pass

def _pb_on_request(req):
    try:
        e = _net_find_pending(req.url, req.method)
        if e is not None and e.get("intercepted"):
            return
        pd = None
        if req.method not in ("GET", "HEAD"):
            try:
                pd = (req.post_data or "")[:2000]
            except Exception:
                pd = None
        _net_add({"method": req.method, "url": req.url, "type": req.resource_type, "status": None, "postData": pd, "body": None})
    except Exception:
        pass

def _pb_on_response(resp):
    try:
        req = resp.request
        e = _net_find_pending(resp.url, req.method)
        if e is None:
            return
        if e.get("status") is None:
            e["status"] = resp.status
        ct = ""
        try:
            ct = resp.headers.get("content-type", "")
        except Exception:
            pass
        if ("json" in ct or "text" in ct) and not e.get("intercepted"):
            e["_resp"] = resp
    except Exception:
        pass

page.route("**/*", _pb_route)
page.on("request", _pb_on_request)
page.on("response", _pb_on_response)

def _net_public(e, with_body):
    out = {}
    for k, v in e.items():
        if not k.startswith("_"):
            out[k] = v
    if with_body and e.get("_resp") is not None and out.get("body") is None:
        try:
            # List views must stay compact — a full log with bodies is far
            # larger than the model can read, which made it misreport logs.
            out["body"] = e["_resp"].text()[:800]
        except Exception:
            out["body"] = None
    return out

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

LOGIN_FIND_JS = r"""
() => {
  function vis(el) {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !el.disabled;
  }
  function selFor(el) {
    if (el.id) return "#" + el.id;
    if (el.name) return el.tagName.toLowerCase() + "[name='" + el.name + "']";
    const ph = el.getAttribute("placeholder");
    if (ph) return "[placeholder='" + ph + "']";
    const al = el.getAttribute("aria-label");
    if (al) return "[aria-label='" + al + "']";
    return el.tagName.toLowerCase();
  }
  const inputs = Array.from(document.querySelectorAll("input")).filter(vis);
  const pw = inputs.find((el) => (el.getAttribute("type") || "").toLowerCase() === "password") || null;
  const form = pw ? pw.closest("form") : null;
  const pool = inputs.filter((el) => el !== pw && ["text", "email", "tel", ""].includes((el.getAttribute("type") || "text").toLowerCase()));
  function rank(el) {
    let s = 0;
    const hay = ((el.getAttribute("name") || "") + " " + (el.id || "") + " " + (el.getAttribute("placeholder") || "") + " " + (el.getAttribute("autocomplete") || "")).toLowerCase();
    if ((el.getAttribute("type") || "").toLowerCase() === "email") s += 5;
    if (hay.includes("email")) s += 5;
    if (hay.includes("user")) s += 4;
    if (hay.includes("login")) s += 3;
    if (hay.includes("username")) s += 4;
    if (form && el.closest("form") === form) s += 3;
    return s;
  }
  pool.sort((x, y) => rank(y) - rank(x));
  const identity = pool.length ? pool[0] : null;
  const lockedCands = Array.from(document.querySelectorAll("input")).filter((el) =>
    el.disabled && el.value && ["text", "email", ""].includes((el.getAttribute("type") || "text").toLowerCase()));
  const locked = lockedCands.length ? lockedCands[0] : null;
  return {
    hasPassword: !!pw,
    passwordSelector: pw ? selFor(pw) : null,
    identitySelector: identity ? selFor(identity) : null,
    identityLockedSelector: locked ? selFor(locked) : null,
    identityLockedValue: locked ? locked.value : null,
    formSelector: form ? (form.id ? "#" + form.id : "form") : null
  };
}
"""

LOGIN_SUBMIT_JS = r"""
(sel) => {
  const anchor = document.querySelector(sel);
  if (!anchor) return null;
  const scope = anchor.closest("form") || document;
  function vis(el) {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !el.disabled;
  }
  function mark(el) {
    // Tag the exact element: a generated selector like "button" would make
    // Playwright click the FIRST button on the page (observed live: the
    // login submit was found correctly but the click landed elsewhere).
    document.querySelectorAll("[data-pb-target]").forEach((x) => x.removeAttribute("data-pb-target"));
    el.setAttribute("data-pb-target", "1");
    return "[data-pb-target='1']";
  }
  const direct = scope.querySelector("button[type='submit'], input[type='submit']");
  if (direct && vis(direct)) return mark(direct);
  const words = ["log in", "login", "sign in", "signin", "continue", "next", "submit"];
  const btns = Array.from(scope.querySelectorAll("button, input[type='button'], [role='button']")).filter(vis);
  for (const b of btns) {
    const t = ((b.innerText || b.value || "") + " " + (b.getAttribute("aria-label") || "")).trim().toLowerCase();
    if (words.some((w) => t === w || t.startsWith(w))) return mark(b);
  }
  return btns.length ? mark(btns[0]) : null;
}
"""

LOGIN_STATE_JS = r"""
() => {
  function vis(el) {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  }
  const pwVisible = Array.from(document.querySelectorAll("input[type='password']")).some(vis);
  let errorText = null;
  const sels = "[role='alert'], .error, .alert, .invalid-feedback, [class*='error'], [class*='Error'], [class*='alert']";
  for (const el of Array.from(document.querySelectorAll(sels))) {
    if (vis(el)) {
      const t = (el.innerText || "").trim();
      if (t) { errorText = t.slice(0, 220); break; }
    }
  }
  return { passwordVisible: pwVisible, errorText: errorText };
}
"""

CONSENT_JS = r"""
() => {
  const words = ["ok", "accept", "accept all", "got it", "i agree", "allow all"];
  const els = Array.from(document.querySelectorAll("button, a, [role='button']"));
  for (const el of els) {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || s.visibility === "hidden" || s.display === "none") continue;
    const t = (el.innerText || "").trim().toLowerCase();
    if (words.includes(t)) { el.click(); return t; }
  }
  return null;
}
"""

def dismiss_consent():
    # Cookie/consent banners commonly overlay the form and swallow clicks.
    for label in ["OK", "Accept", "Accept all", "Got it", "I agree", "Allow all"]:
        try:
            btn = page.get_by_role("button", name=label, exact=True)
            if btn.count() > 0 and btn.first.is_visible():
                btn.first.click(timeout=2500)
                page.wait_for_timeout(400)
                return True
        except Exception:
            pass
    try:
        hit = page.evaluate(CONSENT_JS)
        if hit:
            page.wait_for_timeout(400)
            return True
    except Exception:
        pass
    return False

def fill_verified(selector, value):
    # Playwright fill drives the native value setter; some controlled forms
    # (React) only register key events. Fill, read back, and fall back to
    # real typing when the value did not stick.
    page.fill(selector, value, timeout=15000)
    try:
        got = page.input_value(selector, timeout=3000)
    except Exception:
        got = None
    if got != value:
        try:
            page.click(selector, timeout=5000)
            page.keyboard.press("Control+a")
            page.keyboard.type(value, delay=20)
            got = page.input_value(selector, timeout=3000)
        except Exception:
            pass
    return got == value

NO_ACCOUNT_ERROR = "The site sent us to its SIGN-UP page — this email appears to have NO account there, so this was not a login and no password was submitted to any login form. Store the email the account is actually under, or ask for a sign-up instead."

def on_signup_page():
    try:
        u = (page.url or "").lower()
        t = (page.title() or "").lower()
        return ("signup" in u or "sign-up" in u or "sign_up" in u
                or "create account" in t or "create your account" in t or "sign up" in t)
    except Exception:
        return False

def do_login(args):
    username = args.get("username") or ""
    password = args.get("password") or ""
    start_url = page.url
    info = {"phase": 1, "urlBefore": start_url}
    try:
        info["consentDismissed"] = dismiss_consent()
    except Exception:
        pass
    if on_signup_page():
        res = {"ok": False, "url": page.url, "title": page.title(), "text": page_text(),
               "value": info, "error": NO_ACCOUNT_ERROR}
        if snap():
            res["shot"] = True
        return res
    find = page.evaluate(LOGIN_FIND_JS)
    used_pw_field = False
    if find.get("hasPassword"):
        if username and find.get("identitySelector"):
            info["identityOk"] = fill_verified(find["identitySelector"], username)
            info["identitySelector"] = find["identitySelector"]
        page.fill(find["passwordSelector"], password, timeout=15000)
        info["passwordSelector"] = find["passwordSelector"]
        used_pw_field = True
    elif find.get("identitySelector") and username:
        # Two-step flow: identity first, then the password step appears.
        info["identityOk"] = fill_verified(find["identitySelector"], username)
        info["identitySelector"] = find["identitySelector"]
        nxt = page.evaluate(LOGIN_SUBMIT_JS, find["identitySelector"])
        if nxt:
            try:
                page.click(nxt, timeout=15000)
            except Exception as e:
                # The button often sits busy/disabled while the site checks
                # the email — don't die on the raw timeout; the poll below
                # continues from whatever state the page settles into.
                info["advanceClickError"] = str(e)[:120]
                page.wait_for_timeout(1800)
            info["advancedVia"] = nxt
        else:
            page.keyboard.press("Enter")
            info["advancedVia"] = "Enter"
        # Poll for the password step / a locked identity / an error banner.
        find2 = find
        for _ in range(18):
            try:
                page.wait_for_load_state("networkidle", timeout=1200)
            except Exception:
                pass
            page.wait_for_timeout(500)
            find2 = page.evaluate(LOGIN_FIND_JS)
            if find2.get("hasPassword") or find2.get("identityLockedSelector"):
                break
            if page.url != start_url:
                break
            st = page.evaluate(LOGIN_STATE_JS)
            if st.get("errorText"):
                break
        if on_signup_page():
            # The identity step routed to account creation: the email has
            # no account. NEVER fill a password into a sign-up form.
            res = {"ok": False, "url": page.url, "title": page.title(), "text": page_text(),
                   "value": info, "error": NO_ACCOUNT_ERROR}
            if snap():
                res["shot"] = True
            return res
        if not find2.get("hasPassword") and find2.get("identityLockedSelector"):
            # Identity accepted and locked in; advance once more.
            nxt2 = page.evaluate(LOGIN_SUBMIT_JS, find2["identityLockedSelector"])
            if nxt2:
                try:
                    page.click(nxt2, timeout=15000)
                except Exception as e:
                    info["advancedVia2Error"] = str(e)[:120]
                    page.wait_for_timeout(1800)
                info["advancedVia2"] = nxt2
                for _ in range(12):
                    page.wait_for_timeout(600)
                    find2 = page.evaluate(LOGIN_FIND_JS)
                    if find2.get("hasPassword"):
                        break
        if find2.get("hasPassword"):
            info["phase"] = 2
            page.fill(find2["passwordSelector"], password, timeout=15000)
            info["passwordSelector"] = find2["passwordSelector"]
            used_pw_field = True
        else:
            st2 = page.evaluate(LOGIN_STATE_JS)
            diag = "identity filled ok: " + str(info.get("identityOk")) + "; advanced via: " + str(info.get("advancedVia")) + "; page error: " + str(st2.get("errorText"))
            err2 = "Two-step login: after submitting the identity step, no password field appeared (the site may want a code/OTP or a different flow). Diagnostics — " + diag
            res = {"ok": False, "url": page.url, "title": page.title(), "text": page_text(),
                   "value": info, "error": err2}
            if snap():
                res["shot"] = True
            return res
    elif find.get("identityLockedSelector"):
        # A locked email on a sign-up page is account creation, not login.
        if on_signup_page():
            res = {"ok": False, "url": page.url, "title": page.title(), "text": page_text(),
                   "value": info, "error": NO_ACCOUNT_ERROR}
            if snap():
                res["shot"] = True
            return res
        # The flow already advanced past identity entry: the email field is
        # locked (disabled, prefilled) and the page waits for Continue or
        # shows the password step next.
        locked_val = find.get("identityLockedValue") or ""
        if username and locked_val and locked_val.lower() != str(username).lower() and not args.get("_recovered"):
            # Locked onto a DIFFERENT email than the account asked for —
            # reload once for a fresh form and run the whole login again.
            try:
                page.reload(wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(900)
            except Exception:
                pass
            args2 = dict(args)
            args2["_recovered"] = True
            return do_login(args2)
        info["identitySelector"] = find["identityLockedSelector"]
        info["lockedIdentity"] = True
        nxt = page.evaluate(LOGIN_SUBMIT_JS, find["identityLockedSelector"])
        if nxt:
            try:
                page.click(nxt, timeout=15000)
            except Exception as e:
                info["advanceClickError"] = str(e)[:120]
                page.wait_for_timeout(1800)
            info["advancedVia"] = nxt
        else:
            page.keyboard.press("Enter")
            info["advancedVia"] = "Enter"
        try:
            page.wait_for_load_state("networkidle", timeout=6000)
        except Exception:
            pass
        page.wait_for_timeout(900)
        find2 = page.evaluate(LOGIN_FIND_JS)
        if not find2.get("hasPassword"):
            page.wait_for_timeout(1600)
            find2 = page.evaluate(LOGIN_FIND_JS)
        if find2.get("hasPassword"):
            info["phase"] = 2
            page.fill(find2["passwordSelector"], password, timeout=15000)
            info["passwordSelector"] = find2["passwordSelector"]
            used_pw_field = True
        else:
            state0 = page.evaluate(LOGIN_STATE_JS)
            res = {"ok": False, "url": page.url, "title": page.title(), "text": page_text(),
                   "value": info,
                   "error": "Advanced past the locked email step but no password field appeared" + ((" — the page shows: " + str(state0.get("errorText"))) if state0.get("errorText") else " (the site may continue by emailed code/link instead of a password — hard stop)")}
            if snap():
                res["shot"] = True
            return res
    else:
        res = {"ok": False, "url": page.url, "title": page.title(), "text": page_text(), "value": info,
               "error": "No login form found on this page (no visible password field and no identity field to start a two-step login). Use open + inspect first to see the page's forms."}
        if snap():
            res["shot"] = True
        return res
    # Submit the password step.
    anchor = info.get("passwordSelector")
    submit_sel = page.evaluate(LOGIN_SUBMIT_JS, anchor) if anchor else None
    if submit_sel:
        try:
            page.click(submit_sel, timeout=15000)
        except Exception as e:
            # Busy/disabled submit (site still processing): wait, then let
            # the state evaluation below judge the outcome.
            info["submitClickError"] = str(e)[:120]
            page.wait_for_timeout(1800)
        info["submittedVia"] = submit_sel
    else:
        if anchor:
            page.focus(anchor)
        page.keyboard.press("Enter")
        info["submittedVia"] = "Enter"
    try:
        page.wait_for_load_state("networkidle", timeout=8000)
    except Exception:
        pass
    page.wait_for_timeout(600)
    state = page.evaluate(LOGIN_STATE_JS)
    text = page_text()
    info["urlAfter"] = page.url
    info["errorText"] = state.get("errorText")
    captcha = "captcha" in text.lower()
    if on_signup_page():
        # Never report a sign-up form submission as a successful login.
        ok = False
        err = NO_ACCOUNT_ERROR
    elif state.get("errorText"):
        ok = False
        err = "Login appears to have failed — the page shows: " + str(state["errorText"])
    elif state.get("passwordVisible") and page.url == start_url:
        ok = False
        err = "Login form is still shown after submitting — the credentials may be wrong, or the site needs another step"
        if captcha:
            err += " (a CAPTCHA seems present — hard stop)"
    else:
        ok = True
        err = None
    res = {"ok": ok, "url": page.url, "title": page.title(), "text": text, "value": info}
    if err:
        res["error"] = err
    if snap():
        res["shot"] = True
    return res

def do(cmd):
    a = cmd.get("action")
    args = cmd.get("args") or {}
    if a in ("open", "goto"):
        page.goto(args["url"], wait_until="domcontentloaded", timeout=45000)
    elif a == "login":
        return do_login(args)
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
    elif a == "net_log":
        items = list(NET["log"])
        if args.get("urlContains"):
            items = [e for e in items if args["urlContains"] in (e.get("url") or "")]
        if args.get("method"):
            items = [e for e in items if e.get("method") == str(args["method"]).upper()]
        lim = int(args.get("limit", 30))
        items = items[-max(1, min(lim, 100)):]
        return {"ok": True, "url": page.url, "title": page.title(),
                "network": [_net_public(e, bool(args.get("withBody", False))) for e in items],
                "networkTotal": len(NET["log"]), "rules": list(NET["rules"])}
    elif a == "net_clear":
        NET["log"] = []
        return {"ok": True, "url": page.url, "network": [], "networkTotal": 0, "rules": list(NET["rules"])}
    elif a == "net_intercept":
        NET["rid"] += 1
        rule = {"id": NET["rid"], "pattern": args.get("pattern", ""), "mode": args.get("mode", "mock"),
                "status": args.get("status", 200), "body": args.get("body", ""),
                "contentType": args.get("contentType", "application/json"),
                "newUrl": args.get("newUrl"), "addHeaders": args.get("addHeaders"),
                "removeHeaders": args.get("removeHeaders"), "method": args.get("method"),
                "postData": args.get("postData")}
        NET["rules"].append(rule)
        return {"ok": True, "url": page.url, "rules": list(NET["rules"])}
    elif a == "net_rules":
        return {"ok": True, "url": page.url, "rules": list(NET["rules"])}
    elif a == "net_stop":
        NET["rules"] = []
        return {"ok": True, "url": page.url, "rules": []}
    elif a == "evaluate":
        script = args.get("script") or args.get("text") or ""
        val = page.evaluate(script)
        if isinstance(val, (dict, list, int, float, bool)) or val is None:
            out_val = val
        else:
            out_val = str(val)[:4000]
        res3 = {"ok": True, "url": page.url, "title": page.title(), "value": out_val}
        if args.get("screenshot"):
            if snap():
                res3["shot"] = True
        return res3
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
last_hb = 0.0
while True:
    # Heartbeat: proves the driver loop is alive (the server probes this on
    # session reuse — a dead driver must not brick the session forever).
    if time.time() - last_hb > 2:
        last_hb = time.time()
        try:
            with open(BASE + "/alive", "w") as f:
                f.write(str(last_hb))
        except Exception:
            pass
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
    // Liveness probe: the driver writes a heartbeat every ~2s. If it's
    // stale (or the sandbox is gone), this session is a zombie — every
    // action would burn its full timeout. Drop it and rebuild instead.
    const probe = await withTimeout(
      existing.sandbox.commands.run(
        `A=$(stat -c %Y ${PB_DIR}/alive 2>/dev/null || echo 0); N=$(date +%s); echo $((N - A))`,
        { timeoutMs: 10_000 }
      ),
      12_000,
      null
    );
    const age = probe ? parseInt((probe.stdout || "").trim(), 10) : NaN;
    if (Number.isFinite(age) && age <= 25) {
      return existing;
    }
    sessions.delete(key);
    await existing.sandbox.kill().catch(() => {});
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
  /** fill/type read-back value; evaluate returns the JS result (any JSON value) */
  value?: unknown;
  /** inspect action: the page's forms/fields/clickables map */
  elements?: unknown;
  /** net_log action: captured requests; net_* actions: active interception rules */
  network?: unknown;
  networkTotal?: number;
  rules?: unknown;
  screenshotId?: string;
  screenshotPath?: string;
  error?: string;
}

// Per-session mutex: the model may issue parallel tool calls, but the driver
// has ONE page and ONE command channel — concurrent calls must queue.
const sessionLocks = new Map<string, Promise<void>>();

async function withSessionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(key) || Promise.resolve();
  let release: () => void = () => {};
  const next = new Promise<void>((r) => {
    release = r;
  });
  sessionLocks.set(key, prev.then(() => next));
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

export async function pyBrowserAction(
  apiKey: string,
  conversationId: string | null,
  action: string,
  args: Record<string, unknown> = {}
): Promise<PyBrowserResult> {
  return withSessionLock(keyOf(conversationId), () =>
    pyBrowserActionInner(apiKey, conversationId, action, args)
  );
}

async function pyBrowserActionInner(
  apiKey: string,
  conversationId: string | null,
  action: string,
  args: Record<string, unknown> = {}
): Promise<PyBrowserResult> {
  // Credential tokens: a fill/type value — or a login action's username /
  // password — may contain
  // {{account:<email|username|password>:<account id or site>}} — resolve it
  // HERE, server-side, so the real secret goes straight to the sandbox and
  // never enters the model's context or the chat transcript.
  let usedPasswordToken = false;
  for (const field of ["value", "username", "password"] as const) {
    const raw = args[field];
    if (typeof raw !== "string" || !raw.includes("{{account:")) continue;
    const tokenRe = /\{\{account:(email|username|password):([^}]+)\}\}/g;
    const matches = Array.from(raw.matchAll(tokenRe));
    let resolved = raw;
    for (const m of matches) {
      const kind = m[1] as "email" | "username" | "password";
      const secret = await resolveAccountField(m[2].trim(), kind).catch(() => null);
      if (secret === null) {
        return { ok: false, action, error: `No test account found for "${m[2].trim()}" — add it in Settings → Test accounts or generate an identity first` };
      }
      if (kind === "password") usedPasswordToken = true;
      resolved = resolved.split(m[0]).join(secret);
    }
    args = { ...args, [field]: resolved };
  }
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
  const timeoutMs = action === "open" || action === "goto" || action === "login" ? 75_000 : 45_000;
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
    // No response within the deadline: the driver or sandbox is wedged.
    // Reset the session so the next call rebuilds instead of timing out
    // forever, and transparently retry read-only/navigation actions once
    // on the fresh session. (State-changing actions — click/submit/fill —
    // are NOT retried: they may have partially taken effect.)
    sessions.delete(key);
    session.sandbox.kill().catch(() => {});
    const SAFE_RETRY = ["open", "goto", "read", "screenshot", "inspect", "net_log", "net_rules", "wait_for"];
    if (SAFE_RETRY.includes(action) && !args.__retried) {
      return pyBrowserActionInner(apiKey, conversationId, action, { ...args, __retried: true });
    }
    return {
      ok: false,
      action,
      error: "Browser action timed out — the browser session was reset, so please retry the action (it will start a fresh browser)",
    };
  }
  const out: PyBrowserResult = {
    ok: !!res.ok,
    action,
    url: res.url,
    title: res.title,
    text: res.text,
    // Never echo a filled password back into the model's context. The login
    // action's value is a diagnostics object (selectors, phases, URLs) that
    // never contains the secret itself, so it passes through unmasked —
    // the model needs it to reason about two-step flows.
    value: usedPasswordToken && action !== "login" ? "••••••••" : res.value,
    elements: res.elements,
    network: res.network,
    networkTotal: res.networkTotal,
    rules: res.rules,
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
  action: "open" | "inspect" | "login" | "fill" | "type" | "click" | "submit" | "press" | "scroll" | "wait_for" | "read" | "screenshot" | "net_log" | "net_clear" | "net_intercept" | "net_rules" | "net_stop" | "evaluate";
  url?: string;
  selector?: string;
  value?: string;
  username?: string;
  password?: string;
  key?: string;
  direction?: "up" | "down";
  amount?: number;
  pattern?: string;
  mode?: "mock" | "block" | "modify";
  status?: number;
  body?: string;
  contentType?: string;
  newUrl?: string;
  addHeaders?: Record<string, string>;
  removeHeaders?: string[];
  postData?: string;
  script?: string;
  note?: string;
  expect?: {
    textContains?: string;
    textNotContains?: string;
    urlContains?: string;
    titleContains?: string;
    valueEquals?: string;
    responseStatus?: number;
    responseUrlContains?: string;
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
    // A responseStatus expectation measures THIS step's traffic only.
    if (step.expect?.responseStatus !== undefined) {
      await pyBrowserAction(apiKey, conversationId, "net_clear", {}).catch(() => {});
    }
    const r = await pyBrowserAction(apiKey, conversationId, step.action, {
      url: step.url,
      selector: step.selector,
      value: step.value,
      username: step.username,
      password: step.password,
      key: step.key,
      direction: step.direction,
      amount: step.amount,
      text: step.expect?.textContains,
      urlContains: step.expect?.urlContains,
      pattern: step.pattern,
      mode: step.mode,
      status: step.status,
      body: step.body,
      contentType: step.contentType,
      newUrl: step.newUrl,
      addHeaders: step.addHeaders,
      removeHeaders: step.removeHeaders,
      postData: step.postData,
      script: step.script,
    });
    const failures: string[] = [];
    if (!r.ok) failures.push(r.error || "action failed");
    const exp = step.expect || {};
    if (exp.textContains && !(r.text || "").includes(exp.textContains)) {
      failures.push(`expected page text to contain "${exp.textContains}"`);
    }
    if (exp.textNotContains && (r.text || "").includes(exp.textNotContains)) {
      failures.push(`expected page text NOT to contain "${exp.textNotContains}"`);
    }
    if (exp.responseStatus !== undefined) {
      const log = await pyBrowserAction(apiKey, conversationId, "net_log", { limit: 60 }).catch(() => null);
      const rawNet = (log?.network as { url?: string; status?: number }[] | undefined) || [];
      const entries = rawNet.filter(
        (e) => typeof e.status === "number" && (!exp.responseUrlContains || (e.url || "").includes(exp.responseUrlContains))
      );
      if (!entries.some((e) => e.status === exp.responseStatus)) {
        const seen = entries.slice(-5).map((e) => `${e.status} ${(e.url || "").slice(-60)}`).join("; ");
        failures.push(`expected a response with status ${exp.responseStatus}${exp.responseUrlContains ? ` for a URL containing "${exp.responseUrlContains}"` : ""}; observed: ${seen || "no responses captured"}`);
      }
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
      observed: {
        url: r.url,
        title: r.title,
        value: typeof r.value === "string" ? r.value : r.value === undefined ? undefined : JSON.stringify(r.value)?.slice(0, 500),
      },
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
