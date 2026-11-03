// Shared test harness: controllable mock upstream, proxy launcher, HTTP client.
// Zero dependencies. Everything runs on loopback in temp directories.
const http = require("http");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { performance } = require("perf_hooks");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

function percentile(arr, p) {
  if (!arr.length) return NaN;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1))];
}
const median = (a) => percentile(a, 50);
const round = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : n);

// ---------------------------------------------------------------- mock upstream
// Behaviour is chosen per request with an `x-mock` JSON header (the proxy
// forwards unknown headers). Fields:
//   status, delay, body, bytes (random binary + x-sha256 header), headers,
//   contentType, reset (destroy socket before headers), hang (never respond),
//   stream {n, interval, size, abortAfter, stallAfter},
//   seq + key (per-key sequence of statuses / behaviour objects),
//   byModel {model: status} (status by the `model` in the request body).
async function startMock() {
  const port = await freePort();
  const state = { requests: [], connections: 0, counter: 0, seq: new Map(), open: new Set() };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("error", () => {});
    req.on("end", () => handle(req, res, Buffer.concat(chunks)));
  });
  server.on("connection", (s) => {
    state.connections++;
    state.open.add(s);
    s.on("close", () => state.open.delete(s));
    s.on("error", () => {});
  });

  function handle(req, res, body) {
    let m = {};
    try { m = JSON.parse(req.headers["x-mock"] || "{}"); } catch (_) {}
    const id = ++state.counter;
    const entry = {
      id, url: req.url, method: req.method, headers: req.headers, body,
      t: performance.now(), closedEarly: false, finished: false, written: 0, key: m.key,
    };
    try { entry.model = JSON.parse(body.toString("utf8")).model; } catch (_) {}
    state.requests.push(entry);
    res.on("close", () => { entry.closedAt = performance.now(); entry.closedEarly = !res.writableFinished; });
    res.on("finish", () => { entry.finished = true; });
    res.on("error", () => {});

    let b = m;
    if (m.seq) {
      const n = state.seq.get(m.key) || 0;
      state.seq.set(m.key, n + 1);
      const step = m.seq[Math.min(n, m.seq.length - 1)];
      b = { ...m, ...(typeof step === "number" ? { status: step } : step) };
      delete b.seq;
    }
    if (m.byModel && entry.model in m.byModel) b = { ...b, status: m.byModel[entry.model] };
    entry.behavior = b;
    const go = () => respond(req, res, entry, b, id);
    if (b.delay) setTimeout(go, b.delay); else go();
  }

  function respond(req, res, entry, b, id) {
    if (b.reset) { req.socket.destroy(); return; }
    if (b.hang) return;
    const status = b.status || 200;
    const headers = { "content-type": b.contentType || "application/json", "request-id": "mock-" + id, ...(b.headers || {}) };

    if (b.stream) {
      const { n = 10, interval = 0, size = 100, abortAfter, stallAfter } = b.stream;
      const chunk = Buffer.alloc(size, 97);
      res.writeHead(status, { ...headers, "content-type": "text/event-stream" });
      res.flushHeaders();
      let i = 0;
      const schedule = () => (interval > 0 ? setTimeout(tick, interval) : setImmediate(tick));
      const tick = () => {
        if (res.destroyed) return;
        if (abortAfter !== undefined && i >= abortAfter) { req.socket.destroy(); return; }
        if (stallAfter !== undefined && i >= stallAfter) return;
        if (i >= n) { res.end(); return; }
        i++;
        entry.written += size;
        if (!res.write(chunk)) { entry.backpressure = (entry.backpressure || 0) + 1; res.once("drain", schedule); }
        else schedule();
      };
      tick();
      return;
    }

    let payload;
    if (b.bytes) {
      payload = crypto.randomBytes(b.bytes);
      headers["x-sha256"] = crypto.createHash("sha256").update(payload).digest("hex");
      headers["content-type"] = b.contentType || "application/octet-stream";
    } else if (b.body !== undefined) {
      payload = Buffer.from(typeof b.body === "string" ? b.body : JSON.stringify(b.body));
    } else {
      payload = Buffer.from(JSON.stringify({ id: "msg_mock" + id, type: "message", model: entry.model, content: [{ type: "text", text: "ok" }] }));
    }
    res.writeHead(status, { ...headers, "content-length": payload.length });
    res.end(payload);
  }

  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return {
    port, state,
    get requests() { return state.requests; },
    get connections() { return state.connections; },
    byKey: (k) => state.requests.filter((r) => r.key === k),
    close: () => { for (const s of state.open) s.destroy(); return new Promise((r) => server.close(r)); },
  };
}

// ---------------------------------------------------------------- proxy launcher
// Runs a copy of `proxyFile` in a fresh temp dir with its own .env/config.json
// pointing at a mock. Never touches the real proxy, .env or provider.
async function startProxy(o) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxytest-"));
  fs.copyFileSync(o.proxyFile, path.join(dir, "proxy.js"));
  const port = o.port || (await freePort());
  const probeFile = path.join(dir, "probe.json");

  const cfg = {
    listen: { host: "127.0.0.1", port },
    default_model: "default/model",
    models: { "alias-model": "mapped/model" },
    ...(o.config || {}),
  };
  const writeEnv = (extra = {}) => {
    const env = { PROVIDER_BASE_URL: `http://127.0.0.1:${o.mockPort}`, API_KEY: "test-key", AUTH_STYLE: "bearer", ...(o.env || {}), ...extra };
    fs.writeFileSync(path.join(dir, ".env"), Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  };
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(cfg, null, 2));
  writeEnv();
  if (o.beforeStart) o.beforeStart(dir);

  const launch = () => {
    const proc = spawn(process.execPath, ["-r", path.join(__dirname, "probe.js"), "proxy.js"], {
      cwd: dir, env: { ...process.env, PROBE_FILE: probeFile, ...(o.procEnv || {}) }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    const out = { text: "" };
    proc.stdout.on("data", (d) => (out.text += d));
    proc.stderr.on("data", (d) => (out.text += d));
    const exited = new Promise((r) => proc.on("exit", (code) => r(code)));
    return { proc, out, exited };
  };

  async function waitReady(h, ms = 6000) {
    const t0 = Date.now();
    let code = null;
    h.exited.then((c) => (code = c));
    while (Date.now() - t0 < ms) {
      if (code !== null) throw new Error(`proxy exited early (code ${code}): ${h.out.text}`);
      const ok = await new Promise((r) => {
        const s = net.connect(port, "127.0.0.1", () => { s.destroy(); r(true); });
        s.on("error", () => r(false));
      });
      if (ok) return;
      await sleep(40);
    }
    throw new Error("proxy did not start: " + h.out.text);
  }

  let h = launch();
  await waitReady(h);

  const p = {
    port, dir, config: cfg,
    get proc() { return h.proc; },
    get output() { return h.out.text; },
    get exited() { return h.exited; },
    logPath: path.join(dir, "proxy.log"),
    readLog() { try { return fs.readFileSync(path.join(dir, "proxy.log"), "utf8"); } catch (_) { return ""; } },
    lines() { return p.readLog().split(/\r?\n/).filter(Boolean); },
    requestLines() { return p.lines().filter((l) => !l.includes("--- proxy started")); },
    probe() { try { return JSON.parse(fs.readFileSync(probeFile, "utf8")); } catch (_) { return null; } },
    async freshProbe() { await sleep(450); return p.probe(); },
    setConfig(patch) { Object.assign(cfg, patch); fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(cfg, null, 2)); },
    writeRawConfig(text) { fs.writeFileSync(path.join(dir, "config.json"), text); },
    setEnv(extra) { writeEnv(extra); },
    async restart() { h.proc.kill(); await h.exited; h = launch(); await waitReady(h); },
    startSecond() { return launch(); },
    async kill() {
      try { h.proc.kill(); } catch (_) {}
      await Promise.race([h.exited, sleep(1500)]);
      for (let i = 0; i < 5; i++) {
        try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch (_) { await sleep(100); }
      }
    },
  };
  return p;
}

// ---------------------------------------------------------------- client
// One request, resolves with timings and what was received. Never rejects.
function request(o) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const method = o.method || "POST";
    let data = o.body;
    if (data !== undefined && !Buffer.isBuffer(data) && typeof data !== "string") data = JSON.stringify(data);
    const headers = { "content-type": "application/json", ...(o.headers || {}) };
    if (o.mock) headers["x-mock"] = JSON.stringify(o.mock);
    if (data !== undefined) headers["content-length"] = Buffer.byteLength(data);

    let settled = false;
    let timer;
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ total: performance.now() - t0, ...r }); };

    const req = http.request(
      { host: "127.0.0.1", port: o.port, method, path: o.path || "/v1/messages", headers, agent: o.agent },
      (res) => {
        const ttfb = performance.now() - t0;
        const chunks = [];
        let bytes = 0, allA = true;
        const times = [];
        res.on("data", (c) => {
          bytes += c.length;
          times.push(performance.now() - t0);
          if (o.checkA) { for (let i = 0; i < c.length; i++) if (c[i] !== 97) { allA = false; break; } }
          if (o.keepBody !== false) chunks.push(c);
          if (o.onChunk) o.onChunk(c, res);
        });
        const done = () => finish({
          status: res.statusCode, headers: res.headers, ttfb, bytes, times, allA,
          body: Buffer.concat(chunks), truncated: !res.complete,
        });
        res.on("end", done);
        res.on("close", done);
        res.on("error", done);
      }
    );
    req.on("error", (e) => finish({ error: e.code || e.message, status: 0, bytes: 0, times: [], body: Buffer.alloc(0) }));
    timer = setTimeout(() => { req.destroy(); finish({ timedOut: true, status: 0, bytes: 0, times: [], body: Buffer.alloc(0) }); }, o.timeout || 30000);
    o.onReq && o.onReq(req);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

// Run `total` requests with `concurrency` workers; returns per-request totals.
async function load(o, total, concurrency, make) {
  const totals = [];
  let next = 0, failures = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < total) {
      const i = next++;
      const r = await request({ ...o, ...(make ? make(i) : {}) });
      if (r.status !== 200) failures++;
      totals.push(r.total);
    }
  }));
  return { totals, failures, wallMs: performance.now() - t0, rps: total / ((performance.now() - t0) / 1000) };
}

// ---------------------------------------------------------------- result recorder
function recorder(area, sink) {
  const add = (r) => { sink.push({ area, ...r }); const tag = { pass: "PASS", fail: "FAIL", info: "INFO", na: " N/A" }[r.status]; console.log(`  ${tag}  ${r.name}${r.value !== undefined ? "  = " + r.value + (r.unit ? " " + r.unit : "") : ""}${r.note ? "  (" + r.note + ")" : ""}`); };
  return {
    info: (name, value, unit, note) => add({ name, status: "info", value, unit, note }),
    check: (name, cond, note, value, unit) => add({ name, status: cond ? "pass" : "fail", note: cond ? undefined : note, value, unit }),
    // numeric target: pass when value <= max
    atMost: (name, value, max, unit) => add({ name, status: value <= max ? "pass" : "fail", value: round(value), unit, note: `target <= ${max}` }),
    na: (name, note) => add({ name, status: "na", note }),
    async test(name, fn) {
      try { await fn(); } catch (e) { add({ name, status: "fail", note: "threw: " + (e && e.message) }); }
    },
  };
}

module.exports = { sleep, freePort, percentile, median, round, startMock, startProxy, request, load, recorder };
