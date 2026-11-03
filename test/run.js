#!/usr/bin/env node
// Test / benchmark runner.
//   node test/run.js                          all areas, against ../proxy.js
//   node test/run.js --area perf,obs --quick  shorter runs
//   node test/run.js --proxy path/to/proxy.js --out results/before.json
//   node test/run.js --soak 120               longer soak (seconds)
// Everything runs on loopback in temp dirs; it never touches the real proxy,
// .env or provider. Exit code is 1 on any FAIL only with --strict.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const L = require("./lib");

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes("--" + n);

const AREAS = { perf: "performance", rel: "reliability", obs: "observability" };
const wanted = (opt("area", "perf,rel,obs")).split(",").map((s) => s.trim());
const proxyFile = path.resolve(opt("proxy", path.join(__dirname, "..", "proxy.js")));
const out = opt("out");
const ctx = { proxyFile, quick: flag("quick"), soak: opt("soak") ? Number(opt("soak")) : undefined };

(async () => {
  const results = [];
  const md5 = crypto.createHash("md5").update(fs.readFileSync(proxyFile)).digest("hex");
  console.log(`proxy under test: ${proxyFile}\nmd5 ${md5}  node ${process.version}  ${ctx.quick ? "(quick)" : ""}`);

  for (const key of wanted) {
    if (!AREAS[key]) { console.error("unknown area: " + key); continue; }
    const file = { perf: "perf", rel: "reliability", obs: "observability" }[key];
    console.log(`\n=== ${AREAS[key]} ===`);
    const t0 = Date.now();
    const rec = L.recorder(AREAS[key], results);
    try { await require(`./suites/${file}`)(ctx, rec); }
    catch (e) { rec.check("suite crashed", false, e && e.stack || String(e)); }
    console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }

  console.log("\n=== summary ===");
  for (const a of Object.values(AREAS)) {
    const r = results.filter((x) => x.area === a);
    if (!r.length) continue;
    const c = (s) => r.filter((x) => x.status === s).length;
    console.log(`  ${a.padEnd(14)} pass ${String(c("pass")).padStart(3)}   fail ${String(c("fail")).padStart(3)}   info ${String(c("info")).padStart(3)}`);
  }
  const fails = results.filter((x) => x.status === "fail");
  if (fails.length) {
    console.log("\nfailures:");
    for (const f of fails) console.log(`  [${f.area}] ${f.name}${f.note ? "  — " + f.note : ""}`);
  }
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ meta: { when: new Date().toISOString(), proxyFile, md5, node: process.version, quick: ctx.quick }, results }, null, 2));
    console.log(`\nsaved ${out}`);
  }
  process.exit(flag("strict") && fails.length ? 1 : 0);
})();
