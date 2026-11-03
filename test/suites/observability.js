// Observability suite — can proxy.log answer the questions we actually ask?
// Tests tagged "feature" need log fields the baseline proxy does not write yet.
const fs = require("fs");
const path = require("path");
const L = require("../lib");

const MSG = (model, text = "hello") => ({ model, max_tokens: 8, messages: [{ role: "user", content: text }] });
const UA = "claude-cli/2.1.0 (external, cli)";
const TOKEN = "SECRET-PROXY-TOKEN";

module.exports = async function observability(ctx, rec) {
  const mock = await L.startMock();
  const p = await L.startProxy({
    proxyFile: ctx.proxyFile, mockPort: mock.port,
    config: { default_model: "dflt/target", models: { "alias-model": "mapped/model" } },
    env: { PROXY_TOKEN: TOKEN },
  });
  const send = async (opts) => {
    const before = p.lines().length;
    const r = await L.request({ port: p.port, headers: { "user-agent": UA, "x-api-key": TOKEN, ...(opts.headers || {}) }, ...opts });
    await L.sleep(120);
    return { r, line: p.lines().slice(before).join("\n") };
  };
  const field = (line, name) => { const m = line.match(new RegExp(`\\b${name}=(\\S+)`)); return m ? m[1] : undefined; };

  try {
    const A = await send({ body: MSG("alias-model", "SECRET-BODY-TEXT") });
    const B = await send({ body: MSG("claude-unknown-9") });
    const C = await send({ body: MSG("foo/bar") });
    const D = await send({ body: MSG("alias-model"), mock: { status: 503 } });
    const G = await send({ body: MSG("alias-model"), mock: { stream: { n: 8, interval: 40, size: 100 } } });
    const H = await send({ body: MSG("alias-model"), mock: { key: "obs-retry", seq: [503, 200] } });
    const F = await send({ body: MSG("alias-model"), headers: { host: "evil.com" } });

    const dead = await L.freePort();
    p.setEnv({ PROVIDER_BASE_URL: `http://127.0.0.1:${dead}` });
    const E = await send({ body: MSG("alias-model") });
    p.setEnv({});

    p.writeRawConfig("{ broken json");
    const I = await send({ body: MSG("alias-model") });
    p.setConfig({});

    rec.info("sample line (normal request)", A.line.trim().slice(0, 220));

    // ---- can the log answer these questions? ----------------------------
    await rec.test("questions the log must answer", async () => {
      rec.check("Q1 which client sent it (user-agent logged)", A.line.includes("claude-cli/2.1.0"), "no user-agent in log line");
      const marker = /(via=default|fallback|unmapped)/i;
      rec.check("Q2a alias requests show sent -> used model", /alias-model/.test(A.line) && /mapped\/model/.test(A.line), "sent/used model missing");
      rec.check("Q2b default_model fallback is visibly marked", marker.test(B.line) && !marker.test(A.line), "fallback looks identical to a deliberate alias");
      rec.check("Q2c passthrough id is distinguishable", /foo\/bar/.test(C.line) && !marker.test(C.line), "passthrough line wrong");
      const dur = /\b(ms|dur|duration|elapsed|took)=(\d+)/;
      rec.check("Q3a duration logged", dur.test(A.line), "no duration field");
      const gm = G.line.match(dur);
      rec.check("Q3b duration covers the whole stream", !!gm && Number(gm[2]) >= 250, gm ? `logged ${gm[2]}ms for a ~300ms stream` : "no duration field");
      rec.check("Q4 upstream request id logged (match provider logs)", /\b(rid|req_id|request[-_]?id)=mock-\d+/i.test(A.line), "no request id from upstream response");
      rec.check("Q5a upstream error marked as upstream", /src=upstream/.test(D.line), "cannot tell upstream 503 from a proxy fault");
      rec.check("Q5b network failure shows cause and source", /ECONNREFUSED/.test(E.line) && /src=(network|proxy)/.test(E.line), "refused-connection line lacks cause/source");
      rec.check("Q5c blocked request marked as proxy-generated", /blocked/.test(F.line) && /src=proxy/.test(F.line), "blocked line lacks src=proxy");
      rec.check("Q6 retries visible when they happen", /\b(retries|attempts)=[1-9]/.test(H.line), "no retry/attempt count");
    });

    // ---- log hygiene ------------------------------------------------------
    await rec.test("log hygiene", async () => {
      const text = p.readLog();
      const leaks = ["test-key", TOKEN, "SECRET-BODY-TEXT"].filter((s) => text.includes(s));
      rec.check("no keys, tokens or request bodies in log", leaks.length === 0, "found: " + leaks.join(", "));

      const reqLines = p.lines().filter((l) => /^\S+ (GET|POST|HEAD|PUT|DELETE|OPTIONS|PATCH) /.test(l));
      const unparsable = reqLines.filter((l) => !/^\d{4}-\d\d-\d\dT[\d:.]+Z [A-Z]+ \S+ .*\bstatus=\d{3}\b/.test(l));
      rec.check("every request line has one fixed shape (status=NNN)", unparsable.length === 0, `${unparsable.length} of ${reqLines.length} lines differ, e.g. ${unparsable[0] && unparsable[0].slice(0, 90)}`);

      const avg = reqLines.reduce((n, l) => n + l.length + 1, 0) / Math.max(1, reqLines.length);
      rec.atMost("average log line size", avg, 400, "bytes");

      rec.check("blocked requests are logged", /blocked/.test(F.line), "no line for blocked request");
      rec.check("config errors are logged", /config\.json unreadable/.test(I.line), "no line for broken config");
      rec.check("startup is logged", p.lines().some((l) => l.includes("proxy started")), "no startup line");
      rec.check("config error line says which config is used", /last good|defaults/.test(I.line), "line does not say what the proxy fell back to");
      rec.check("status code present on failed requests", /(status=|-> )503\b/.test(D.line), "503 not in log");
    });
  } finally {
    await p.kill();
  }

  // ---- rotation: pre-fill the log past the limit, then check it rotates ------
  const q = await L.startProxy({
    proxyFile: ctx.proxyFile, mockPort: mock.port,
    beforeStart: (d) => fs.writeFileSync(path.join(d, "proxy.log"), "x".repeat(5.2 * 1024 * 1024) + "\n"),
  });
  try {
    for (let i = 0; i < 250; i++) await L.request({ port: q.port, body: MSG("alias-model") });
    await L.sleep(300);
    const rotated = fs.existsSync(q.logPath + ".1");
    const size = fs.existsSync(q.logPath) ? fs.statSync(q.logPath).size : -1;
    rec.check("log rotates past the size limit", rotated && size < 1024 * 1024, `rotated=${rotated}, current log ${L.round(size / 1048576, 2)} MB`);
  } finally {
    await q.kill();
    await mock.close();
  }
};
