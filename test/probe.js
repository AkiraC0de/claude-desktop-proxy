// Preloaded into the proxy under test (node -r test/probe.js proxy.js).
//  1. Samples RSS / handles / event-loop delay into $PROBE_FILE every 200 ms.
//  2. Blocks every non-loopback outbound connection, so a test run can never
//     reach a real provider (e.g. when .env is deliberately removed).
const fs = require("fs");
const net = require("net");
const { monitorEventLoopDelay } = require("perf_hooks");

const hist = monitorEventLoopDelay({ resolution: 10 });
hist.enable();
let peakRss = 0;
const file = process.env.PROBE_FILE;

function snap() {
  const m = process.memoryUsage();
  peakRss = Math.max(peakRss, m.rss);
  const s = {
    t: Date.now(), rss: m.rss, peakRss, heap: m.heapUsed,
    handles: process._getActiveHandles().length,
    el: { mean: hist.mean / 1e6, p99: hist.percentile(99) / 1e6, max: hist.max / 1e6 },
  };
  try { fs.writeFileSync(file, JSON.stringify(s)); } catch (_) {}
}
if (file) { setInterval(snap, 200).unref(); snap(); }

const LOCAL = /^(127\.\d+\.\d+\.\d+|localhost|::1|\[::1\])$/i;
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = args[0];
  const host = o && typeof o === "object" ? o.host : undefined;
  if (host && !LOCAL.test(host)) {
    process.nextTick(() => this.destroy(new Error("probe: external connection blocked: " + host)));
    return this;
  }
  return origConnect.apply(this, args);
};
