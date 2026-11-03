// Performance suite — everything on loopback against a mock upstream, so the
// numbers show the proxy's own cost, not the provider's.
const http = require("http");
const fs = require("fs");
const path = require("path");
const L = require("../lib");

const MSG = (model = "alias-model", pad = 0) => ({
  model, max_tokens: 16,
  messages: [{ role: "user", content: pad ? "x".repeat(pad) : "hi" }],
});

module.exports = async function perf(ctx, rec) {
  const mock = await L.startMock();
  const proxy = await L.startProxy({ proxyFile: ctx.proxyFile, mockPort: mock.port });
  try {
    const agentDirect = new http.Agent({ keepAlive: true });
    const agentProxy = new http.Agent({ keepAlive: true });
    const direct = (o = {}) => L.request({ port: mock.port, agent: agentDirect, ...o });
    const via = (o = {}) => L.request({ port: proxy.port, agent: agentProxy, ...o });
    const small = MSG();
    for (let i = 0; i < 30; i++) { await direct({ body: small }); await via({ body: small }); }

    await rec.test("proxy overhead (small request/response)", async () => {
      const N = ctx.quick ? 150 : 400;
      const d = [], v = [];
      for (let i = 0; i < N; i++) {      // interleaved so drift hits both equally
        d.push((await direct({ body: small })).total);
        v.push((await via({ body: small })).total);
      }
      rec.info("direct p50 / p95", `${L.round(L.median(d))} / ${L.round(L.percentile(d, 95))}`, "ms");
      rec.info("via proxy p50 / p95", `${L.round(L.median(v))} / ${L.round(L.percentile(v, 95))}`, "ms");
      rec.atMost("overhead p50", L.median(v) - L.median(d), 3, "ms");
      rec.atMost("overhead p95", L.percentile(v, 95) - L.percentile(d, 95), 6, "ms");
    });

    await rec.test("streaming: first byte and chunk pacing", async () => {
      const mockOpt = { stream: { n: 20, interval: 25, size: 100 } };
      const runs = ctx.quick ? 8 : 15;
      const td = [], tv = [], spreadD = [], spreadV = [], chunksD = [], chunksV = [];
      for (let i = 0; i < runs; i++) {
        const a = await direct({ body: small, mock: mockOpt });
        const b = await via({ body: small, mock: mockOpt });
        td.push(a.ttfb); tv.push(b.ttfb);
        spreadD.push(a.times[a.times.length - 1] - a.times[0]);
        spreadV.push(b.times[b.times.length - 1] - b.times[0]);
        chunksD.push(a.times.length); chunksV.push(b.times.length);
      }
      rec.atMost("first-byte delay added", L.median(tv) - L.median(td), 3, "ms");
      rec.check("chunks not batched", L.median(chunksV) >= 0.8 * L.median(chunksD), `proxy delivered ${L.median(chunksV)} chunks vs ${L.median(chunksD)} direct`, `${L.median(chunksV)}/${L.median(chunksD)}`, "chunks");
      rec.check("stream duration preserved", L.median(spreadV) >= 0.9 * L.median(spreadD), `proxy spread ${L.round(L.median(spreadV))}ms vs direct ${L.round(L.median(spreadD))}ms`);
    });

    await rec.test("concurrency scaling", async () => {
      const total = ctx.quick ? 200 : 400;
      for (const c of [1, 10, 50]) {
        const r = await L.load({ port: proxy.port, agent: agentProxy, mock: { delay: 10 } }, total, c, () => ({ body: small }));
        rec.info(`c=${c} throughput`, L.round(r.rps, 0), "req/s");
        rec.info(`c=${c} latency p50 / p95`, `${L.round(L.median(r.totals))} / ${L.round(L.percentile(r.totals, 95))}`, "ms");
        rec.check(`c=${c} no failures`, r.failures === 0, `${r.failures} of ${total} failed`);
      }
    });

    await rec.test("event-loop lag under load", async () => {
      await L.load({ port: proxy.port, agent: agentProxy, mock: { delay: 5 } }, ctx.quick ? 300 : 800, 50, () => ({ body: small }));
      const p = await proxy.freshProbe();
      rec.info("event-loop max stall", L.round(p.el.max), "ms");
      rec.atMost("event-loop p99 delay", p.el.p99, 50, "ms");
    });

    await rec.test("large request bodies", async () => {
      for (const kb of [250, 1024]) {
        const big = MSG("alias-model", kb * 1024);
        const d = [], v = [];
        const runs = ctx.quick ? 5 : 8;
        for (let i = 0; i < runs; i++) {
          d.push((await direct({ body: big, timeout: 20000 })).total);
          v.push((await via({ body: big, timeout: 20000 })).total);
        }
        const last = mock.requests[mock.requests.length - 1];
        let ok = false;
        try { ok = JSON.parse(last.body.toString("utf8")).model === "mapped/model" && last.body.length >= kb * 1024; } catch (_) {}
        rec.check(`${kb} KB body forwarded and model rewritten`, ok, "upstream body wrong or model not rewritten");
        rec.info(`${kb} KB request via proxy (median)`, L.round(L.median(v)), "ms");
        rec.atMost(`${kb} KB added latency (median)`, L.median(v) - L.median(d), kb > 500 ? 60 : 25, "ms");
      }
    });

    await rec.test("large response (5 MB)", async () => {
      const d = (await direct({ body: small, mock: { bytes: 5 * 1024 * 1024 }, timeout: 20000 })).total;
      const v = (await via({ body: small, mock: { bytes: 5 * 1024 * 1024 }, timeout: 20000 })).total;
      rec.info("5 MB response direct / via proxy", `${L.round(d)} / ${L.round(v)}`, "ms");
    });

    await rec.test("per-request file-read cost (.env + config.json)", async () => {
      const envF = path.join(proxy.dir, ".env"), cfgF = path.join(proxy.dir, "config.json");
      const N = 5000, t0 = process.hrtime.bigint();
      for (let i = 0; i < N; i++) { fs.readFileSync(envF, "utf8"); JSON.parse(fs.readFileSync(cfgF, "utf8")); }
      const us = Number(process.hrtime.bigint() - t0) / 1000 / N;
      rec.info("read+parse both files", L.round(us, 1), "us/request", "re-done on every request");
    });

    await rec.test("upstream connection reuse", async () => {
      const before = mock.connections;
      for (let i = 0; i < 100; i++) await via({ body: small });
      const used = mock.connections - before;
      rec.atMost("new upstream connections per 100 requests", used, 10, "conns");
    });

    await rec.test("memory and handles after sustained load", async () => {
      const a = await proxy.freshProbe();
      const total = ctx.quick ? 600 : 2500;
      await L.load({ port: proxy.port, agent: agentProxy, mock: { delay: 5 } }, total, 20, () => ({ body: small }));
      await L.sleep(1200);
      const b = await proxy.freshProbe();
      rec.info("RSS before -> after", `${L.round(a.rss / 1048576, 1)} -> ${L.round(b.rss / 1048576, 1)}`, "MB");
      rec.atMost("RSS growth", (b.rss - a.rss) / 1048576, 60, "MB");
      rec.atMost("open handles growth", b.handles - a.handles, 5, "handles");
      const logged = proxy.requestLines().length;
      rec.check("every request logged", logged >= total, `${logged} lines for ${total}+ requests`, logged, "lines");
    });
  } finally {
    await proxy.kill();
    await mock.close();
  }
};
