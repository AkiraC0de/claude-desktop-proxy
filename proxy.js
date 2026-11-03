// proxy.js — Anthropic-compatible aliasing proxy (Node, zero dependencies).
//
// Claude Code talks to this as if it were api.anthropic.com. Every request is
// forwarded to the provider in .env; only the `model` field is rewritten using
// the alias map in config.json (e.g. claude-sonnet-5 -> xiaomi/mimo-v2.6-pro).
//
//   node proxy.js          foreground
//   wscript start.vbs      hidden (used by the Startup shortcut)
//
// Edit .env (provider + key) or config.json (model aliases) any time — both
// are re-read when the file changes, no restart needed (listen host/port
// excepted).
//
// config.json keys (all optional except models):
//   models           { "<id sent>": "<id to use>" }   exact or normalised match
//   default_model    used for unlisted claude-*/anthropic-* ids
//   models_list      "upstream" (default) | "aliases"  who answers GET /models
//   retry            { max: 2, base_ms: 200 }   retries on 502/503/504/529 and
//                    connection errors, only before any response byte is sent
//   fallback_models  { "<model used>": "<model to try if it is overloaded>" }
//   timeouts         { headers_ms: 300000, idle_ms: 120000 }
//
// Local endpoints: GET /_proxy/health, GET /_proxy/stats.

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");

const HERE = __dirname;
const ENV_PATH = path.join(HERE, ".env");
const CFG_PATH = path.join(HERE, "config.json");
const PID_PATH = path.join(HERE, "proxy.pid");
const LOG = path.join(HERE, "proxy.log");
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_PROVIDER = "https://api.xkiro.com";
const DEFAULT_MODEL = "xiaomi/mimo-v2.6-pro";
const STARTED_AT = Date.now();

// ------------------------------------------------------------------ logging
// Buffered and written asynchronously so a slow disk never stalls requests.
let logBuf = [];
let logTimer = null;
let logBusy = false;
let logSize = 0;
try { logSize = fs.statSync(LOG).size; } catch (_) {}

function log(msg) {
  if (logBuf.length < 20000) logBuf.push(new Date().toISOString() + " " + msg + "\n");
  if (!logTimer && !logBusy) logTimer = setTimeout(flushLog, 25);
}

function flushLog() {
  logTimer = null;
  if (logBusy || !logBuf.length) return;
  logBusy = true;
  const data = logBuf.join("");
  logBuf = [];
  const write = () => fs.appendFile(LOG, data, (err) => {
    if (!err) logSize += Buffer.byteLength(data);
    logBusy = false;
    if (logBuf.length) logTimer = setTimeout(flushLog, 25);
  });
  if (logSize > LOG_MAX_BYTES) fs.rename(LOG, LOG + ".1", () => { logSize = 0; write(); });
  else write();
}

process.on("exit", () => {
  if (logBuf.length) { try { fs.appendFileSync(LOG, logBuf.join("")); } catch (_) {} }
});

// Values in log lines must stay one token: no whitespace, bounded length.
const tok = (v, max = 120) => String(v).replace(/\s+/g, "_").slice(0, max);

// -------------------------------------------------------------- env / config
// Both files are re-read only when their mtime/size change (checked with one
// stat per request), and at least every 2 s as a safety net.
const REVALIDATE_MS = 2000;
function fileKey(p) {
  try { const s = fs.statSync(p); return s.mtimeMs + ":" + s.size; } catch (_) { return "missing"; }
}

let envCache = { key: "", at: 0, env: {} };
function loadEnv() {
  const key = fileKey(ENV_PATH), now = Date.now();
  if (key === envCache.key && now - envCache.at < REVALIDATE_MS) return envCache.env;
  const env = {};
  try {
    for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      const q = v.match(/^(["'])(.*?)\1/);
      v = q ? q[2] : v.replace(/\s+#.*$/, "");
      env[m[1].toUpperCase()] = v;
    }
  } catch (_) {}
  envCache = { key, at: now, env };
  return env;
}

// A config.json that fails to parse (e.g. a typo mid-edit) must not reroute
// traffic: keep serving the last good config and log the error once per change.
const BUILTIN_CONFIG = { listen: { host: "127.0.0.1", port: 8787 }, default_model: DEFAULT_MODEL, models: {} };
let lastGoodConfig = null;
let lastConfigError = "";
let cfgCache = { key: "", at: 0, cfg: null };
function loadConfig() {
  const key = fileKey(CFG_PATH), now = Date.now();
  if (cfgCache.cfg && key === cfgCache.key && now - cfgCache.at < REVALIDATE_MS) return cfgCache.cfg;
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
    lastGoodConfig = cfg;
    lastConfigError = "";
  } catch (e) {
    if (e.message !== lastConfigError) {
      lastConfigError = e.message;
      log(`config.json unreadable: ${tok(e.message, 160)} — ${lastGoodConfig ? "using last good config" : "using built-in defaults"}`);
    }
    cfg = lastGoodConfig || BUILTIN_CONFIG;
  }
  cfgCache = { key, at: now, cfg };
  return cfg;
}

// ------------------------------------------------------------------- models
const ALIAS_RE = /^(claude|anthropic)[/-]/i;
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// Canonicalize a model id for fuzzy matching: strip an `anthropic/`-style
// provider prefix and any date suffix, fold `.`/`_` to `-`, collapse repeats.
// Lets `anthropic/claude-sonnet-5.5`, `claude-sonnet-5-5`, and
// `claude-sonnet-5-5-20250929` all hit the same alias.
function normId(id) {
  return String(id)
    .toLowerCase()
    .replace(/^anthropic[/-]/, "")
    .replace(/[-._]\d{6,8}$/, "")
    .replace(/[._]/g, "-")
    .replace(/-+/g, "-");
}

// ONE-TO-ONE: each sent id maps to exactly one target, used as-is (no chaining).
// `via` tells the log whether this was a deliberate alias, the default_model
// fallback for an unlisted Claude id, or an id passed through untouched.
function resolveModel(sent, cfg) {
  const map = cfg.models || {};
  if (hasOwn(map, sent)) return { model: map[sent], via: "alias" };
  const ns = normId(sent);
  for (const k of Object.keys(map)) {
    if (normId(k) === ns) return { model: map[k], via: "alias" };
  }
  if (ALIAS_RE.test(sent)) return { model: cfg.default_model || DEFAULT_MODEL, via: "default" };
  return { model: sent, via: "passthrough" };
}

function fallbackFor(cfg, sent, mapped) {
  const f = cfg.fallback_models;
  if (!f || typeof f !== "object") return null;
  const v = hasOwn(f, mapped) ? f[mapped] : hasOwn(f, sent) ? f[sent] : null;
  return typeof v === "string" && v && v !== mapped ? v : null;
}

function cannedModels(cfg) {
  const names = Object.keys(cfg.models || {});
  return {
    object: "list",
    data: names.map((id) => ({
      id,
      object: "model",
      created: 1758000000,
      owned_by: "anthropic",
      display_name: id
        .replace(/^anthropic\//i, "")
        .replace(/^claude-/i, "Claude ")
        .replace(/-/g, " ")
        .replace(/(\d) (\d)/g, "$1.$2")
        .replace(/\b\w/g, (c) => c.toUpperCase()),
    })),
  };
}

function authHeaders(env) {
  const key = env.API_KEY || "";
  const style = (env.AUTH_STYLE || "bearer").toLowerCase();
  const h = {};
  if (!key) return h;
  if (style === "bearer" || style === "both") h["Authorization"] = "Bearer " + key;
  if (style === "x-api-key" || style === "both") h["x-api-key"] = key;
  return h;
}

// ------------------------------------------------------------ request record
// One record per client request; written to the log exactly once when the
// client response closes, so the duration covers the whole stream.
const stats = { requests: 0, retries: 0, by_status: {}, by_src: {}, by_model: {} };
const bump = (o, k) => { if (hasOwn(o, k) || Object.keys(o).length < 100) o[k] = (o[k] || 0) + 1; else o.other = (o.other || 0) + 1; };

function newRec(req) {
  const ua = String(req.headers["user-agent"] || "").split(/\s/)[0];
  return { t0: performance.now(), method: req.method, url: req.url, ua, model: null, via: null, status: 0, bytes: 0, retries: 0, local: false };
}

function finalize(rec, res) {
  if (rec.done) return;
  rec.done = true;
  if (rec.internal) return;
  if (!res.writableFinished) {            // closed before the response completed
    if (!rec.status) rec.status = 499;
    if (!rec.src) rec.src = "client";
    if (!rec.err) rec.err = "client_closed";
  }
  const ms = Math.round(performance.now() - rec.t0);
  const parts = [rec.method, tok(rec.url, 200), `model=${rec.model ? tok(rec.model, 200) : "-"}`];
  if (rec.via) parts.push(`via=${rec.via}`);
  parts.push(`status=${rec.status}`, `ms=${ms}`, `bytes=${rec.bytes}`);
  if (rec.ua) parts.push(`ua=${tok(rec.ua, 60)}`);
  if (rec.rid) parts.push(`rid=${tok(rec.rid, 80)}`);
  if (rec.src) parts.push(`src=${rec.src}`);
  if (rec.err) parts.push(`err=${tok(rec.err, 80)}`);
  if (rec.retries) parts.push(`retries=${rec.retries}`);
  if (rec.fellBackFrom) parts.push(`fell_back_from=${tok(rec.fellBackFrom, 120)}`);
  if (rec.blocked) parts.push(`blocked=${tok(rec.blocked, 60)}`);
  if (rec.local) parts.push(`local=${rec.local}`);
  log(parts.join(" "));

  stats.requests++;
  stats.retries += rec.retries;
  bump(stats.by_status, String(rec.status));
  if (rec.src) bump(stats.by_src, rec.src);
  if (rec.model) bump(stats.by_model, rec.model);
}

function reply(res, rec, code, doc, src, err) {
  if (rec) {
    rec.status = code;
    if (src) rec.src = src;
    if (err) rec.err = err;
  }
  if (res.destroyed) return;
  if (res.headersSent) return res.destroy();
  const raw = Buffer.from(JSON.stringify(doc));
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": String(raw.length), Connection: "close" });
  res.end(raw);
}

// -------------------------------------------------------------------- relay
// Hop-by-hop and framing headers must not be forwarded; we re-frame the body.
const DROP_REQ = new Set([
  "host", "content-length", "transfer-encoding", "connection", "keep-alive",
  "upgrade", "te", "trailer", "expect", "proxy-authorization", "proxy-connection",
  "accept-encoding", "authorization", "x-api-key",
]);
const DROP_RES = new Set(["transfer-encoding", "connection", "keep-alive", "content-length"]);

const RETRY_STATUS = new Set([502, 503, 504, 529]);
const RETRY_NET = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ECONNABORTED"]);
const MAX_RETRY_AFTER_MS = 5000;

// Upstream connections are reused: no TLS handshake per request.
const agentOpts = { keepAlive: true, maxSockets: Infinity, maxFreeSockets: 32, timeout: 30000, noDelay: true };
const AGENT_HTTP = new http.Agent(agentOpts);
const AGENT_HTTPS = new https.Agent(agentOpts);

const num = (v, d, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

function relay(req, res, body, env, cfg, rec) {
  let upstream;
  try {
    upstream = new URL(env.PROVIDER_BASE_URL || DEFAULT_PROVIDER);
  } catch (e) {
    log(`bad PROVIDER_BASE_URL: ${tok(e.message, 160)}`);
    return reply(res, rec, 500, { error: { type: "proxy_error", message: "PROVIDER_BASE_URL is not a valid URL" } }, "proxy", "bad_provider_url");
  }
  const isHttps = upstream.protocol === "https:";
  const mod = isHttps ? https : http;
  const agent = isHttps ? AGENT_HTTPS : AGENT_HTTP;
  // Keep any path in PROVIDER_BASE_URL (e.g. https://host/api): prefix it to the request path.
  const reqPath = upstream.pathname.replace(/\/+$/, "") + req.url;

  const R = cfg.retry || {}, T = cfg.timeouts || {};
  const maxRetries = num(R.max, 2, 0, 5);
  const baseMs = num(R.base_ms, 200, 0, 5000);
  const headersMs = num(T.headers_ms, 300000, 50, 3600000);
  const idleMs = num(T.idle_ms, 120000, 50, 3600000);

  // Model rewrite (one parse; the fallback body is built lazily).
  let doc = null, curBody = body, mapped = null, fbModel = null;
  if (req.method === "POST" && body.length) {
    try {
      const d = JSON.parse(body.toString("utf8"));
      if (d && typeof d === "object" && !Array.isArray(d)) doc = d;
    } catch (_) {}
  }
  const bodyFor = (model) => { doc.model = model; return Buffer.from(JSON.stringify(doc)); };
  if (doc && typeof doc.model === "string" && doc.model) {
    const sent = doc.model;
    const r = resolveModel(sent, cfg);
    mapped = r.model;
    rec.via = r.via;
    rec.model = `${sent}->${mapped}`;
    fbModel = fallbackFor(cfg, sent, mapped);
    if (mapped !== sent) curBody = bodyFor(mapped);
  }
  const sentModel = doc && typeof doc.model === "string" ? doc.model : null;

  const baseHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!DROP_REQ.has(k.toLowerCase())) baseHeaders[k] = v;
  }
  Object.assign(baseHeaders, authHeaders(env)); // provider auth comes from .env

  let retries = 0, usedFallback = false, cancelled = false, retryTimer = null, cur = null;

  const teardown = (st) => {
    if (!st) return;
    clearTimeout(st.ht); clearTimeout(st.it);
    try { if (st.up) st.up.destroy(); } catch (_) {}
    try { if (st.r) st.r.destroy(); } catch (_) {}
  };
  // Client went away before we finished: stop the upstream request too.
  res.on("close", () => {
    if (res.writableFinished) return;
    cancelled = true;
    clearTimeout(retryTimer);
    teardown(cur);
  });

  function scheduleRetry(delay) {
    retries++;
    rec.retries = retries;
    retryTimer = setTimeout(() => { if (!cancelled) attempt(); }, delay);
  }

  // Decide what to do with a 4xx/5xx status before any byte reaches the client.
  function decide(sc, headers) {
    const retryable = RETRY_STATUS.has(sc);
    if (!retryable && sc !== 429) return null;
    if (fbModel && !usedFallback) return { fallback: true, delay: 0 };
    if (!retryable || retries >= maxRetries) return null;
    let delay = baseMs * 2 ** retries + Math.floor(Math.random() * 50);
    const ra = parseFloat(headers["retry-after"]);
    if (Number.isFinite(ra)) {
      if (ra * 1000 > MAX_RETRY_AFTER_MS) return null;
      delay = Math.max(delay, ra * 1000);
    }
    return { delay };
  }

  function attempt() {
    const st = { up: null, r: null, ht: null, it: null, gotResponse: false };
    cur = st;
    const headers = { ...baseHeaders, "Content-Length": String(curBody.length) };
    st.up = mod.request(
      { host: upstream.hostname, port: upstream.port || (isHttps ? 443 : 80), path: reqPath, method: req.method, headers, agent },
      (r) => onResponse(st, r)
    );
    st.ht = setTimeout(() => {
      st.up.destroy(Object.assign(new Error(`no response headers within ${headersMs}ms`), { code: "UPSTREAM_TIMEOUT" }));
    }, headersMs);
    st.up.on("error", (e) => onError(st, e));
    if (curBody.length) st.up.write(curBody);
    st.up.end();
  }

  function onError(st, e) {
    clearTimeout(st.ht);
    if (cancelled || st !== cur || st.gotResponse) return;
    const code = e.code || e.message || "error";
    if (RETRY_NET.has(code) && retries < maxRetries) {
      return scheduleRetry(baseMs * 2 ** retries + Math.floor(Math.random() * 50));
    }
    const timeout = code === "UPSTREAM_TIMEOUT";
    reply(res, rec, timeout ? 504 : 502, { error: { type: "proxy_error", message: String(e.message) } }, "network", code);
  }

  function onResponse(st, r) {
    st.gotResponse = true;
    st.r = r;
    clearTimeout(st.ht);
    if (cancelled || res.destroyed) return r.destroy();
    const sc = r.statusCode;

    const d = decide(sc, r.headers);
    if (d) {
      r.resume(); // drain so the socket can be reused
      if (d.fallback) {
        usedFallback = true;
        rec.fellBackFrom = mapped;
        rec.model = `${sentModel}->${fbModel}`;
        curBody = bodyFor(fbModel);
      }
      return scheduleRetry(d.delay);
    }

    rec.status = sc;
    rec.rid = r.headers["request-id"] || r.headers["x-request-id"] || "";
    if (sc >= 400) rec.src = "upstream";
    const keep = {};
    for (let i = 0; i < r.rawHeaders.length; i += 2) {
      if (!DROP_RES.has(r.rawHeaders[i].toLowerCase())) keep[r.rawHeaders[i]] = r.rawHeaders[i + 1];
    }
    res.writeHead(sc, keep);

    const fail = (src, err) => {
      if (rec.err) return;
      rec.src = src;
      rec.err = err;
      clearTimeout(st.it);
      try { st.up.destroy(); } catch (_) {}
      res.destroy();
    };
    st.it = setTimeout(function onIdle() {
      if (res.writableNeedDrain) return st.it.refresh(); // slow client, not a stalled upstream
      fail("network", "idle_timeout");
    }, idleMs);
    r.on("data", (c) => { rec.bytes += c.length; st.it.refresh(); });
    r.on("end", () => clearTimeout(st.it));
    r.on("error", (e) => fail("upstream", e.code || "upstream_error"));
    r.on("close", () => { if (!r.complete) fail("upstream", "upstream_aborted"); });
    r.pipe(res); // handles backpressure and ends res
  }

  attempt();
}

// -------------------------------------------------------------- local guard
// Blocks DNS-rebinding (Host check), browser cross-site requests
// (Sec-Fetch-Site / preflight), and — if PROXY_TOKEN is set in .env — any
// client that does not present it as x-api-key or Bearer token.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
function guard(req, env, listenHost) {
  const hostHeader = String(req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
  if (listenHost !== "0.0.0.0" && listenHost !== "::" && !LOOPBACK_HOSTS.has(hostHeader) && hostHeader !== String(listenHost).toLowerCase()) {
    return "bad host";
  }
  const site = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  if (site === "cross-site" || site === "same-site") return "cross-site request";
  if (req.method === "OPTIONS") return "preflight not supported";
  const token = env.PROXY_TOKEN;
  if (token) {
    const auth = String(req.headers["authorization"] || "");
    const given = req.headers["x-api-key"] || (auth.startsWith("Bearer ") ? auth.slice(7) : "");
    if (given !== token) return "missing or wrong proxy token";
  }
  return null;
}

// ------------------------------------------------------------------- server
const cfg0 = loadConfig();
const listen = cfg0.listen || { host: "127.0.0.1", port: 8787 };

function handle(req, res, body, rec) {
  const env = loadEnv();     // cached; re-read when the file changes
  const cfg = loadConfig();
  const denied = guard(req, env, listen.host);
  if (denied) {
    rec.blocked = denied;
    return reply(res, rec, 403, { error: { type: "forbidden", message: "proxy: " + denied } }, "proxy");
  }
  let pathname = req.url;
  try { pathname = new URL(req.url, "http://localhost").pathname.replace(/\/$/, ""); } catch (_) {}

  if (req.method === "GET" && pathname === "/_proxy/health") {
    rec.internal = true;
    return reply(res, rec, 200, { ok: true, pid: process.pid, uptime_s: Math.round((Date.now() - STARTED_AT) / 1000) });
  }
  if (req.method === "GET" && pathname === "/_proxy/stats") {
    rec.internal = true;
    return reply(res, rec, 200, { since: new Date(STARTED_AT).toISOString(), uptime_s: Math.round((Date.now() - STARTED_AT) / 1000), log_bytes: logSize, ...stats });
  }
  // models_list: "upstream" (default) relays the provider's list;
  // "aliases" serves the alias keys from config.json.
  if (req.method === "GET" && pathname.endsWith("/models") && cfg.models_list === "aliases") {
    rec.local = "models";
    return reply(res, rec, 200, cannedModels(cfg));
  }
  if (req.method === "POST" && pathname.endsWith("/count_tokens")) {
    try {
      const doc = JSON.parse(body.toString("utf8"));
      const n = Math.floor(JSON.stringify([doc.system || "", doc.tools || [], doc.messages || []]).length / 4) + 600;
      rec.local = "count_tokens";
      return reply(res, rec, 200, { input_tokens: n });
    } catch (_) {}
  }
  relay(req, res, body, env, cfg, rec);
}

const server = http.createServer((req, res) => {
  const chunks = [];
  const rec = newRec(req);
  res.on("close", () => finalize(rec, res));
  req.on("data", (c) => chunks.push(c));
  req.on("error", () => { rec.err = rec.err || "client_error"; res.destroy(); });
  req.on("end", () => {
    try {
      handle(req, res, Buffer.concat(chunks), rec);
    } catch (e) {
      log(`handler error: ${tok(e && e.stack || e, 400)}`);
      reply(res, rec, 500, { error: { type: "proxy_error", message: "internal proxy error" } }, "proxy", "handler_error");
    }
  });
});
server.keepAliveTimeout = 65000;

server.on("error", (e) => {
  const msg = e.code === "EADDRINUSE"
    ? `port ${listen.port} already in use — another proxy instance is probably running`
    : `server error: ${e.message}`;
  log(msg);
  console.error(msg);
  process.exit(1);
});

// A stray exception in one request must not take every session down. Log it
// and keep serving; give up only if it is clearly a crash loop.
let faults = [];
function onFault(kind, e) {
  log(`${kind}: ${tok(e && e.stack || e, 600)}`);
  const now = Date.now();
  faults = faults.filter((t) => now - t < 60000);
  faults.push(now);
  if (faults.length > 10) process.exit(1);
}
process.on("uncaughtException", (e) => onFault("uncaughtException", e));
process.on("unhandledRejection", (e) => onFault("unhandledRejection", e));

function removePid() {
  try {
    if (fs.readFileSync(PID_PATH, "utf8").trim() === String(process.pid)) fs.unlinkSync(PID_PATH);
  } catch (_) {}
}
process.on("exit", removePid);
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.on(sig, () => process.exit(0));

server.listen(listen.port, listen.host, () => {
  try { fs.writeFileSync(PID_PATH, String(process.pid)); } catch (_) {}
  const env = loadEnv();
  const target = env.PROVIDER_BASE_URL || DEFAULT_PROVIDER;
  log(`--- proxy started on ${listen.host}:${listen.port} -> ${target} aliases=${Object.keys(cfg0.models || {}).length}`);
  console.log(`proxy listening on http://${listen.host}:${listen.port} -> ${target}`);
  console.log("aliases:", JSON.stringify(cfg0.models || {}));
});
