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
// are re-read on every request, no restart needed (listen host/port excepted).

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const ENV_PATH = path.join(HERE, ".env");
const CFG_PATH = path.join(HERE, "config.json");
const PID_PATH = path.join(HERE, "proxy.pid");
const LOG = path.join(HERE, "proxy.log");
const LOG_MAX_BYTES = 5 * 1024 * 1024;

let logWrites = 0;
function log(msg) {
  try {
    if (++logWrites % 100 === 0 && fs.statSync(LOG).size > LOG_MAX_BYTES) {
      fs.renameSync(LOG, LOG + ".1");
    }
  } catch (_) {}
  try { fs.appendFileSync(LOG, new Date().toISOString() + " " + msg + "\n"); } catch (_) {}
}

function loadEnv() {
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
  return env;
}

// A config.json that fails to parse (e.g. a typo mid-edit) must not reroute
// traffic: keep serving the last good config and log the error once per change.
let lastGoodConfig = null;
let lastConfigError = "";
function loadConfig() {
  try {
    lastGoodConfig = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
    lastConfigError = "";
    return lastGoodConfig;
  } catch (e) {
    if (e.message !== lastConfigError) {
      lastConfigError = e.message;
      log(`config.json unreadable: ${e.message} — ${lastGoodConfig ? "using last good config" : "using built-in defaults"}`);
    }
    return lastGoodConfig || { listen: { host: "127.0.0.1", port: 8787 }, default_model: "xiaomi/mimo-v2.6-pro", models: {} };
  }
}

const ALIAS_RE = /^(claude|anthropic)[/-]/i;

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

function resolveModel(sent, cfg) {
  const map = cfg.models || {};
  // ONE-TO-ONE: each sent id maps to exactly one target, used as-is (no chaining).
  if (Object.prototype.hasOwnProperty.call(map, sent)) return map[sent];
  const ns = normId(sent);
  for (const k of Object.keys(map)) {
    if (normId(k) === ns) return map[k];
  }
  if (ALIAS_RE.test(sent)) return cfg.default_model || "xiaomi/mimo-v2.6-pro";
  return sent;
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

// Hop-by-hop and framing headers must not be forwarded; we re-frame the body.
const DROP_REQ = new Set([
  "host", "content-length", "transfer-encoding", "connection", "keep-alive",
  "upgrade", "te", "trailer", "expect", "proxy-authorization", "proxy-connection",
  "accept-encoding", "authorization", "x-api-key",
]);
const DROP_RES = new Set(["transfer-encoding", "connection", "keep-alive", "content-length"]);

function relay(clientReq, clientRes, body, env, cfg) {
  let upstream;
  try {
    upstream = new URL(env.PROVIDER_BASE_URL || "https://api.xkiro.com");
  } catch (e) {
    log(`bad PROVIDER_BASE_URL: ${e.message}`);
    return json(clientRes, 500, { error: { type: "proxy_error", message: "PROVIDER_BASE_URL is not a valid URL" } });
  }
  const isHttps = upstream.protocol === "https:";
  // Keep any path in PROVIDER_BASE_URL (e.g. https://host/api): prefix it to the request path.
  const basePath = upstream.pathname.replace(/\/+$/, "");
  let usedModel = "-";
  if (clientReq.method === "POST" && body.length) {
    try {
      const doc = JSON.parse(body.toString("utf8"));
      const sent = String(doc.model || "");
      const mapped = resolveModel(sent, cfg);
      if (mapped !== sent) {
        doc.model = mapped;
        body = Buffer.from(JSON.stringify(doc));
      }
      usedModel = sent + "->" + mapped;
    } catch (_) {}
  }
  const headers = {};
  for (const [k, v] of Object.entries(clientReq.headers)) {
    if (!DROP_REQ.has(k.toLowerCase())) headers[k] = v;
  }
  Object.assign(headers, authHeaders(env)); // provider auth comes from .env
  headers["Content-Length"] = String(body.length);
  headers["Connection"] = "close";

  const up = (isHttps ? https : http).request(
    { host: upstream.hostname, port: upstream.port || (isHttps ? 443 : 80), path: basePath + clientReq.url,
      method: clientReq.method, headers, timeout: 600000 },
    (r) => {
      const keep = {};
      for (let i = 0; i < r.rawHeaders.length; i += 2) {
        if (!DROP_RES.has(r.rawHeaders[i].toLowerCase())) keep[r.rawHeaders[i]] = r.rawHeaders[i + 1];
      }
      clientRes.writeHead(r.statusCode, keep);
      let total = 0;
      r.on("data", (c) => { total += c.length; });
      r.pipe(clientRes); // handles backpressure and ends clientRes
      r.on("end", () => log(`${clientReq.method} ${clientReq.url} model=${usedModel} -> ${r.statusCode} bytes=${total}`));
      r.on("error", (e) => { log(`stream error ${e.message}`); clientRes.destroy(); });
      r.on("aborted", () => { log(`stream error upstream aborted after ${total} bytes`); clientRes.destroy(); });
    }
  );
  // Client went away before we finished: stop the upstream request too.
  clientRes.on("close", () => { if (!clientRes.writableFinished) up.destroy(); });
  up.on("timeout", () => up.destroy(new Error("upstream timeout")));
  up.on("error", (e) => {
    if (clientRes.destroyed) return;
    log(`${clientReq.method} ${clientReq.url} model=${usedModel} -> ERROR ${e.message}`);
    if (clientRes.headersSent) return clientRes.destroy(); // mid-stream: can't send a JSON error
    json(clientRes, 502, { error: { type: "proxy_error", message: String(e.message) } });
  });
  if (body.length) up.write(body);
  up.end();
}

function json(clientRes, code, doc) {
  const raw = Buffer.from(JSON.stringify(doc));
  clientRes.writeHead(code, { "Content-Type": "application/json", "Content-Length": String(raw.length), Connection: "close" });
  clientRes.end(raw);
}

// Local-access guard. Blocks DNS-rebinding (Host check), browser cross-site
// requests (Sec-Fetch-Site / preflight), and — if PROXY_TOKEN is set in .env —
// any client that does not present it as x-api-key or Bearer token.
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

const cfg0 = loadConfig();
const listen = cfg0.listen || { host: "127.0.0.1", port: 8787 };

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("error", () => res.destroy());
  req.on("end", () => {
    const env = loadEnv();     // re-read each request: edit without restart
    const cfg = loadConfig();
    const denied = guard(req, env, listen.host);
    if (denied) {
      log(`${req.method} ${req.url} -> 403 blocked: ${denied}`);
      return json(res, 403, { error: { type: "forbidden", message: "proxy: " + denied } });
    }
    const body = Buffer.concat(chunks);
    let pathname = req.url;
    try { pathname = new URL(req.url, "http://localhost").pathname.replace(/\/$/, ""); } catch (_) {}
    // models_list: "upstream" (default) relays the provider's list;
    // "aliases" serves the alias keys from config.json.
    if (req.method === "GET" && pathname.endsWith("/models") && cfg.models_list === "aliases") {
      log(`GET ${req.url} -> canned model list`);
      return json(res, 200, cannedModels(cfg));
    }
    if (req.method === "POST" && pathname.endsWith("/count_tokens")) {
      try {
        const doc = JSON.parse(body.toString("utf8"));
        const n = Math.floor(JSON.stringify([doc.system || "", doc.tools || [], doc.messages || []]).length / 4) + 600;
        return json(res, 200, { input_tokens: n });
      } catch (_) {}
    }
    relay(req, res, body, env, cfg);
  });
});

server.on("error", (e) => {
  const msg = e.code === "EADDRINUSE"
    ? `port ${listen.port} already in use — another proxy instance is probably running`
    : `server error: ${e.message}`;
  log(msg);
  console.error(msg);
  process.exit(1);
});

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
  log(`--- proxy started on ${listen.host}:${listen.port} -> ${env.PROVIDER_BASE_URL || "https://api.xkiro.com"} aliases=${Object.keys(cfg0.models || {}).length}`);
  console.log(`proxy listening on http://${listen.host}:${listen.port} -> ${env.PROVIDER_BASE_URL || "https://api.xkiro.com"}`);
  console.log("aliases:", JSON.stringify(cfg0.models || {}));
});
