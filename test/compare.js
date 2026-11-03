#!/usr/bin/env node
// node test/compare.js results/before.json results/after.json  -> markdown table
const fs = require("fs");
const [a, b] = process.argv.slice(2).map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
const key = (r) => `${r.area}|${r.name}`;
const mapB = new Map(b.results.map((r) => [key(r), r]));
const show = (r) => !r ? "—" : r.status === "info" || r.value !== undefined
  ? `${r.status === "pass" ? "PASS " : r.status === "fail" ? "FAIL " : ""}${r.value}${r.unit ? " " + r.unit : ""}`
  : r.status.toUpperCase();

console.log(`before: ${a.meta.md5.slice(0, 8)} (${a.meta.when})   after: ${b.meta.md5.slice(0, 8)} (${b.meta.when})\n`);
let area = "";
for (const r of a.results) {
  if (r.area !== area) { area = r.area; console.log(`\n### ${area}\n\n| check | before | after |\n|---|---|---|`); }
  const n = mapB.get(key(r));
  const changed = n && (n.status !== r.status) ? (n.status === "pass" ? " ✔" : n.status === "fail" ? " ✘" : "") : "";
  console.log(`| ${r.name} | ${show(r)} | ${show(n)}${changed} |`);
}
for (const n of b.results) if (!a.results.some((r) => key(r) === key(n))) console.log(`| ${n.area}: ${n.name} (new) | — | ${show(n)} |`);

const count = (res, area, s) => res.filter((r) => r.area === area && r.status === s).length;
console.log("\n| area | pass before | pass after | fail before | fail after |\n|---|---|---|---|---|");
for (const ar of [...new Set(a.results.map((r) => r.area))])
  console.log(`| ${ar} | ${count(a.results, ar, "pass")} | ${count(b.results, ar, "pass")} | ${count(a.results, ar, "fail")} | ${count(b.results, ar, "fail")} |`);
