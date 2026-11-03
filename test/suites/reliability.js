// Reliability suite — fault injection against a mock upstream.
// Tests tagged "feature" describe behaviour the baseline proxy does not have yet
// (retry, fallback model, timeouts); they are expected to fail before the fixes.
const fs = require("fs");
const path = require("path");
const L = require("../lib");

const MSG = (model = "alias-model") => ({ model, max_tokens: 8, messages: [{ role: "user", content: "x" }] });

module.exports = async function reliability(ctx, rec) {
  const mock = await L.startMock();
  const spawnProxy = (o = {}) => L.startProxy({ proxyFile: ctx.proxyFile, mockPort: mock.port, ...o });
  const alive = async (p) => (await L.request({ port: p.port, method: "GET", path: "/v1/models", timeout: 3000 })).status === 200;
  let kn = 0;
  const key = (p) => `${p}-${++kn}`;
  const attempts = (k) => mock.byKey(k).length;
  const group = (name, fn) => rec.test(name, fn);

  const p = await spawnProxy();
  try {
    // ---- upstream errors ------------------------------------------------
    await group("persistent 503 is passed through, retries are capped", async () => {
      const k = key("p503");
      const r = await L.request({ port: p.port, body: MSG(), mock: { key: k, seq: [503] } });
      rec.check("persistent 503 returned to client", r.status === 503, `got ${r.status || r.error}`);
      rec.atMost("upstream attempts on persistent 503", attempts(k), 3, "attempts");
      rec.check("proxy alive afterwards", await alive(p), "proxy not responding");
    });

    for (const code of [502, 503, 504, 529]) {
      await group(`transient ${code} recovered`, async () => {
        const k = key("t" + code);
        const r = await L.request({ port: p.port, body: MSG(), mock: { key: k, seq: [code, 200] } });
        rec.check(`feature: retry recovers from one ${code}`, r.status === 200, `client saw ${r.status || r.error} after ${attempts(k)} attempt(s)`);
      });
    }

    await group("429 and 4xx handling", async () => {
      const k = key("p429");
      const r = await L.request({ port: p.port, body: MSG(), mock: { key: k, seq: [{ status: 429, headers: { "retry-after": "7" } }] } });
      rec.check("429 passed through with retry-after", r.status === 429 && r.headers["retry-after"] === "7", `status ${r.status}, retry-after ${r.headers && r.headers["retry-after"]}`);
      const k2 = key("p400");
      const r2 = await L.request({ port: p.port, body: MSG(), mock: { key: k2, seq: [400] } });
      rec.check("400 not retried", r2.status === 400 && attempts(k2) === 1, `status ${r2.status}, attempts ${attempts(k2)}`);
    });

    await group("connection refused", async () => {
      const dead = await L.freePort();
      const q = await spawnProxy({ env: { PROVIDER_BASE_URL: `http://127.0.0.1:${dead}` } });
      try {
        const r = await L.request({ port: q.port, body: MSG() });
        let j = null; try { j = JSON.parse(r.body.toString()); } catch (_) {}
        rec.check("502 JSON error to client", r.status === 502 && j && j.error, `status ${r.status || r.error}`);
        const r2 = await L.request({ port: q.port, body: MSG() });
        rec.check("still serving after failure", r2.status === 502, "proxy died or hung");
      } finally { await q.kill(); }
    });

    await group("connection reset before headers", async () => {
      const k = key("rst");
      const r = await L.request({ port: p.port, body: MSG(), mock: { key: k, seq: [{ reset: true }] } });
      rec.check("persistent reset -> 502", r.status === 502, `got ${r.status || r.error}`);
      rec.atMost("upstream attempts on persistent reset", attempts(k), 3, "attempts");
      const k2 = key("rst2");
      const r2 = await L.request({ port: p.port, body: MSG(), mock: { key: k2, seq: [{ reset: true }, 200] } });
      rec.check("feature: retry recovers from one reset", r2.status === 200, `client saw ${r2.status || r2.error}`);
      rec.check("proxy alive afterwards", await alive(p), "proxy not responding");
    });

    // ---- streaming ---------------------------------------------------
    await group("upstream aborts mid-stream", async () => {
      const k = key("abort");
      const r = await L.request({ port: p.port, body: MSG(), mock: { key: k, stream: { n: 10, interval: 10, size: 100, abortAfter: 3 } } });
      rec.check("client sees a truncated stream", r.truncated || !!r.error, "stream looked complete");
      rec.check("no JSON error appended to stream", !r.body.toString().includes("proxy_error"), "proxy_error text found in stream");
      rec.check("no retry after bytes were sent", attempts(k) === 1, `${attempts(k)} attempts`);
      rec.check("proxy alive afterwards", await alive(p), "proxy not responding");
    });

    await group("client disconnects mid-stream", async () => {
      const k = key("disc");
      let rq;
      await L.request({ port: p.port, body: MSG(), mock: { key: k, stream: { n: 300, interval: 20, size: 100 } },
        onReq: (r) => (rq = r), onChunk: () => rq.destroy() });
      await L.sleep(900);
      const e = mock.byKey(k)[0];
      rec.check("upstream request cancelled", e && e.closedEarly && e.written < 300 * 100, `upstream wrote ${e && e.written} of 30000 bytes`);
    });

    await group("slow client / backpressure", async () => {
      const q = await spawnProxy();
      try {
        const k = key("slow");
        const before = await q.freshProbe();
        let paused = false;
        const r = await L.request({ port: q.port, body: MSG(), timeout: 40000, keepBody: false,
          mock: { key: k, stream: { n: 3000, interval: 0, size: 10000 } },
          onChunk: (c, res) => { if (!paused) { paused = true; res.pause(); setTimeout(() => res.resume(), 1800); } } });
        const after = await q.freshProbe();
        rec.check("30 MB stream delivered intact", r.bytes === 30000000, `received ${r.bytes}`);
        rec.check("upstream was throttled while client paused", (mock.byKey(k)[0].backpressure || 0) > 0, "no backpressure reached the upstream");
        rec.atMost("proxy peak RSS growth", (after.peakRss - before.rss) / 1048576, 120, "MB");
      } finally { await q.kill(); }
    });

    // ---- timeouts (feature) ------------------------------------------
    await group("timeouts", async () => {
      const q = await spawnProxy({ config: { timeouts: { headers_ms: 1000, idle_ms: 1000 } } });
      try {
        const r1 = await L.request({ port: q.port, body: MSG(), timeout: 5000, mock: { hang: true } });
        rec.check("feature: hung upstream gets a 502/504 quickly", !r1.timedOut && (r1.status === 502 || r1.status === 504), r1.timedOut ? "client gave up after 5s (no timeout in proxy)" : `status ${r1.status}`);
        const r2 = await L.request({ port: q.port, body: MSG(), timeout: 5000, mock: { delay: 2500 } });
        rec.check("feature: slow headers cut off", !r2.timedOut && r2.total < 2300 && r2.status >= 500, `status ${r2.status}, ${L.round(r2.total, 0)}ms`);
        const r3 = await L.request({ port: q.port, body: MSG(), timeout: 5000, mock: { stream: { n: 10, interval: 20, size: 100, stallAfter: 3 } } });
        rec.check("feature: stalled stream is closed", !r3.timedOut, "client waited 5s on a stalled stream");
        const r4 = await L.request({ port: q.port, body: MSG(), timeout: 8000, mock: { stream: { n: 6, interval: 400, size: 100 } } });
        rec.check("slow but live stream is NOT cut off", r4.bytes === 600 && !r4.truncated, `received ${r4.bytes} of 600 bytes`);
      } finally { await q.kill(); }
    });

    // ---- fallback model (feature) ------------------------------------
    await group("fallback model", async () => {
      const q = await spawnProxy({ config: { fallback_models: { "mapped/model": "fallback/model" } } });
      try {
        const k = key("fb");
        const r = await L.request({ port: q.port, body: MSG(), mock: { key: k, byModel: { "mapped/model": 503 } } });
        const used = mock.byKey(k).map((e) => e.model);
        rec.check("feature: falls back when primary is overloaded", r.status === 200 && used[used.length - 1] === "fallback/model", `status ${r.status}, models tried: ${used.join(", ")}`);
        const k2 = key("fb-ok");
        const r2 = await L.request({ port: q.port, body: MSG(), mock: { key: k2 } });
        rec.check("fallback not used when primary works", r2.status === 200 && attempts(k2) === 1 && mock.byKey(k2)[0].model === "mapped/model", `attempts ${attempts(k2)}`);
      } finally { await q.kill(); }
    });

    // ---- payload integrity -------------------------------------------
    await group("payload integrity", async () => {
      const crypto = require("crypto");
      const r = await L.request({ port: p.port, body: MSG(), timeout: 30000, mock: { bytes: 5 * 1024 * 1024 } });
      const sha = crypto.createHash("sha256").update(r.body).digest("hex");
      rec.check("5 MB binary response byte-identical", sha === r.headers["x-sha256"], "hash mismatch");
      const r2 = await L.request({ port: p.port, body: MSG(), mock: { body: "plain text, not json", contentType: "text/plain" } });
      rec.check("non-JSON response passed through", r2.body.toString() === "plain text, not json" && /text\/plain/.test(r2.headers["content-type"]), `got ${JSON.stringify(r2.body.toString())}`);
    });

    await group("malformed request bodies", async () => {
      for (const b of ["{not json", "", "null", "[1]", "\"str\""]) {
        const r = await L.request({ port: p.port, body: b });
        rec.check(`body ${JSON.stringify(b)} handled`, r.status > 0, `got ${r.error || "no response"}`);
      }
      rec.check("proxy alive afterwards", await alive(p), "proxy not responding");
    });

    // ---- process / file faults --------------------------------------
    await group("stale proxy.pid on start", async () => {
      const q = await spawnProxy({ beforeStart: (d) => fs.writeFileSync(path.join(d, "proxy.pid"), "99999") });
      try { rec.check("pid file replaced with live pid", fs.readFileSync(path.join(q.dir, "proxy.pid"), "utf8").trim() === String(q.proc.pid), "stale pid left behind"); }
      finally { await q.kill(); }
    });

    await group("hard kill and restart", async () => {
      const q = await spawnProxy();
      try {
        q.proc.kill("SIGKILL"); await q.exited;
        await q.restart();
        rec.check("restart after hard kill serves requests", await alive(q), "restarted proxy not serving");
        rec.check("pid file matches new process", fs.readFileSync(path.join(q.dir, "proxy.pid"), "utf8").trim() === String(q.proc.pid), "pid mismatch");
      } finally { await q.kill(); }
    });

    await group("second instance on same port", async () => {
      const q = await spawnProxy();
      try {
        const s = q.startSecond();
        const code = await Promise.race([s.exited, L.sleep(4000).then(() => "timeout")]);
        if (code === "timeout") s.proc.kill();
        rec.check("second instance exits with a clear message", code === 1 && /already in use/.test(s.out.text), `exit ${code}: ${s.out.text.trim().slice(0, 80)}`);
        rec.check("first instance unaffected", await alive(q), "first instance stopped serving");
      } finally { await q.kill(); }
    });

    await group("config.json faults while running", async () => {
      const q = await spawnProxy();
      try {
        const modelOf = async () => { await L.request({ port: q.port, body: MSG() }); return mock.requests[mock.requests.length - 1].model; };
        rec.check("baseline mapping works", (await modelOf()) === "mapped/model", "mapping broken");
        const f = path.join(q.dir, "config.json");
        const saved = fs.readFileSync(f, "utf8");
        fs.unlinkSync(f);
        rec.check("config deleted: last good config kept", (await modelOf()) === "mapped/model", "mapping lost");
        q.writeRawConfig('{ "models": { "alias-model": "map');
        rec.check("config half-written: last good config kept", (await modelOf()) === "mapped/model", "mapping lost");
        fs.writeFileSync(f, saved);
        rec.check("config restored: picked up again", (await modelOf()) === "mapped/model", "mapping not restored");
      } finally { await q.kill(); }
    });

    await group(".env faults", async () => {
      const q = await spawnProxy();
      try {
        fs.unlinkSync(path.join(q.dir, ".env"));
        const r = await L.request({ port: q.port, body: MSG(), timeout: 8000 });
        let j = null; try { j = JSON.parse(r.body.toString()); } catch (_) {}
        rec.check(".env missing: defined JSON error, no crash", (r.status === 502 || r.status === 500) && j && j.error, `got ${r.status || r.error}`);
        q.setEnv({ PROVIDER_BASE_URL: "not a url" });
        const r2 = await L.request({ port: q.port, body: MSG() });
        rec.check("invalid PROVIDER_BASE_URL: 500 JSON error", r2.status === 500, `got ${r2.status || r2.error}`);
        q.setEnv({});
        rec.check("recovers when .env is fixed", await alive(q), "did not recover");
      } finally { await q.kill(); }
    });

    await group("log file unwritable", async () => {
      const q = await spawnProxy();
      try {
        for (let i = 0; i < 20; i++) {  // the proxy may recreate the file between rm and mkdir
          try { fs.rmSync(q.logPath, { force: true }); fs.mkdirSync(q.logPath); break; } catch (_) { await L.sleep(30); }
        }
        rec.check("proxy.log replaced by a directory (setup)", fs.statSync(q.logPath).isDirectory(), "could not block the log path");
        const r = await L.request({ port: q.port, body: MSG() });
        rec.check("requests still served when proxy.log cannot be written", r.status === 200, `got ${r.status || r.error}`);
        rec.check("proxy process still running", q.proc.exitCode === null, "proxy exited");
      } finally { await q.kill(); }
    });

    // ---- soak ----------------------------------------------------------
    await group("soak with random faults", async () => {
      const q = await spawnProxy();
      try {
        const secs = ctx.soak || (ctx.quick ? 15 : 45);
        const a = await q.freshProbe();
        const end = Date.now() + secs * 1000;
        const stats = { total: 0, ok: 0, expectedFail: 0, unexpected: 0 };
        const bad = new Set();
        let n = 0;
        const rand = (i) => { const x = Math.sin(i * 12.9898) * 43758.5453; return x - Math.floor(x); };
        const worker = async () => {
          while (Date.now() < end) {
            const i = ++n, r0 = rand(i), k = key("soak");
            let opts, accept;
            if (r0 < 0.55) { opts = { body: MSG(), mock: { delay: 3 } }; accept = (r) => r.status === 200; }
            else if (r0 < 0.67) { opts = { body: MSG(), mock: { key: k, seq: [503, 200] } }; accept = (r) => r.status === 200 || r.status === 503; }
            else if (r0 < 0.73) { opts = { body: MSG(), mock: { key: k, seq: [{ reset: true }, 200] } }; accept = (r) => r.status === 200 || r.status === 502; }
            else if (r0 < 0.88) { opts = { body: MSG(), mock: { stream: { n: 8, interval: 5, size: 200 } } }; accept = (r) => r.status === 200 && r.bytes === 1600; }
            else if (r0 < 0.94) { opts = { body: MSG(), mock: { stream: { n: 8, interval: 5, size: 200, abortAfter: 3 } } }; accept = (r) => r.truncated || !!r.error || r.status === 502; }
            else { opts = { body: "{bad json" }; accept = (r) => r.status === 200; }
            const r = await L.request({ port: q.port, timeout: 10000, ...opts });
            stats.total++;
            if (accept(r)) stats.ok++; else if (r.timedOut || r.error === "ECONNREFUSED" || r.error === "ECONNRESET" && r0 < 0.55) { stats.unexpected++; bad.add(r.timedOut ? "timeout" : r.error); } else stats.expectedFail++;
          }
        };
        await Promise.all(Array.from({ length: 8 }, worker));
        await L.sleep(1200);
        const b = await q.freshProbe();
        rec.info("soak requests", stats.total, "req", `${secs}s, 8 workers`);
        rec.check("no timeouts or dropped connections", stats.unexpected === 0, `${stats.unexpected} unexpected: ${[...bad].join(",")}`);
        rec.check("proxy alive at end", q.proc.exitCode === null && (await alive(q)), "proxy dead");
        rec.atMost("RSS growth", (b.rss - a.rss) / 1048576, 80, "MB");
        rec.atMost("open handles growth", b.handles - a.handles, 10, "handles");
      } finally { await q.kill(); }
    });
  } finally {
    await p.kill();
    await mock.close();
  }
};
