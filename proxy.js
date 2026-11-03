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
// are re-read on every request, no restart needed.

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const ENV_PATH = path.join(HERE, ".env");
const CFG_PATH = path.join(HERE, "config.json");
const LOG = path.join(HERE, "proxy.log");

function log(msg) {
  try { fs.appendFileSync(LOG, new Date().toISOString() + " " + msg + "\n"); } catch (_) {}
}

function loadEnv() {
  const env = {};
  try {
    for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !m[1].startsWith("#")) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch (_) {}
  return env;
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
  } catch (e) {
    log("config.json unreadable: " + e.message);
    return { listen: { host: "127.0.0.1", port: 8787 }, default_model: "xiaomi/mimo-v2.6-pro", models: {} };
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
  // Follow alias chains (e.g. fable-5 -> sonnet-5.5 -> sol), with a cycle guard.
  const seen = new Set();
  let cur = sent;
  for (let i = 0; i < 5; i++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    let next;
    if (Object.prototype.hasOwnProperty.call(map, cur)) {
      next = map[cur];
    } else {
      const ns = normId(cur);
      let hit;
      for (const k of Object.keys(map)) {
        if (normId(k) === ns) { hit = map[k]; break; }
      }
      next = hit;
    }
    if (next == null || next === cur) break;
    cur = next;
  }
  if (cur === sent && ALIAS_RE.test(sent)) return cfg.default_model || "xiaomi/mimo-v2.6-pro";
  return cur; // chain result, or a non-Claude id passed through untouched
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
      display_name: id.replace(/^claude-/i, "Claude ").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
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

function relay(clientReq, clientRes, body, env, cfg) {
  const upstream = new URL(env.PROVIDER_BASE_URL || "https://api.xkiro.com");
  const isHttps = upstream.protocol === "https:";
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
    const lk = k.toLowerCase();
    if (lk === "host" || lk === "content-length" || lk === "accept-encoding" || lk === "authorization" || lk === "x-api-key") continue;
    headers[k] = v;
  }
  Object.assign(headers, authHeaders(env)); // provider auth comes from .env
  headers["Content-Length"] = String(body.length);
  headers["Connection"] = "close";

  const mod = isHttps ? https : http;
  const up = mod.request(
    { host: upstream.hostname, port: upstream.port || (isHttps ? 443 : 80), path: clientReq.url,
      method: clientReq.method, headers, timeout: 600000, ...(isHttps ? {} : {}) },
    (r) => {
      const keep = {};
      for (let i = 0; i < r.rawHeaders.length; i += 2) {
        const k = r.rawHeaders[i], lk = k.toLowerCase();
        if (lk === "transfer-encoding" || lk === "connection" || lk === "content-length") continue;
        keep[k] = r.rawHeaders[i + 1];
      }
      clientRes.writeHead(r.statusCode, keep);
      let total = 0;
      r.on("data", (c) => { total += c.length; clientRes.write(c); });
      r.on("end", () => { clientRes.end(); log(`${clientReq.method} ${clientReq.url} model=${usedModel} -> ${r.statusCode} bytes=${total}`); });
      r.on("error", (e) => { clientRes.end(); log(`stream error ${e.message}`); });
    }
  );
  up.on("timeout", () => up.destroy(new Error("upstream timeout")));
  up.on("error", (e) => {
    log(`${clientReq.method} ${clientReq.url} model=${usedModel} -> ERROR ${e.message}`);
    if (!clientRes.headersSent) clientRes.writeHead(502, { "Content-Type": "application/json", Connection: "close" });
    clientRes.end(JSON.stringify({ error: { type: "proxy_error", message: String(e.message) } }));
  });
  if (body.length) up.write(body);
  up.end();
}

function json(clientRes, code, doc) {
  const raw = Buffer.from(JSON.stringify(doc));
  clientRes.writeHead(code, { "Content-Type": "application/json", "Content-Length": String(raw.length), Connection: "close" });
  clientRes.end(raw);
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const env = loadEnv();     // re-read each request: edit without restart
    const cfg = loadConfig();
    const body = Buffer.concat(chunks);
    if (req.method === "GET" && req.url.replace(/\/$/, "").endsWith("/models")) {
      log(`GET ${req.url} -> canned model list`);
      return json(res, 200, cannedModels(cfg));
    }
    if (req.method === "POST" && req.url.includes("count_tokens")) {
      try {
        const doc = JSON.parse(body.toString("utf8"));
        const n = Math.floor(JSON.stringify(doc.messages || []).length / 4) + 600;
        return json(res, 200, { input_tokens: n });
      } catch (_) {}
    }
    relay(req, res, body, env, cfg);
  });
});

const cfg0 = loadConfig();
const listen = cfg0.listen || { host: "127.0.0.1", port: 8787 };
server.listen(listen.port, listen.host, () => {
  try { fs.writeFileSync(path.join(HERE, "proxy.pid"), String(process.pid)); } catch (_) {}
  const env = loadEnv();
  log(`--- proxy started on ${listen.host}:${listen.port} -> ${env.PROVIDER_BASE_URL || "https://api.xkiro.com"} aliases=${Object.keys(cfg0.models || {}).length}`);
  console.log(`proxy listening on http://${listen.host}:${listen.port} -> ${env.PROVIDER_BASE_URL || "https://api.xkiro.com"}`);
  console.log("aliases:", JSON.stringify(cfg0.models || {}));
});
