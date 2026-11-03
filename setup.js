#!/usr/bin/env node
// setup.js — one-shot installer for the model-alias proxy (Windows).
//
//   node setup.js                 interactive
//   node setup.js --yes           no prompts: keep existing values, create the
//                                 project shortcut, skip desktop/autostart
//   node setup.js --desktop       also put a shortcut on the Desktop
//   node setup.js --autostart     also start the proxy at login
//   node setup.js --no-claude     do not touch ~/.claude/settings.json
//   node setup.js --uninstall     remove shortcuts and the Claude wiring
//
// Safe to re-run, and re-run it after moving the project folder: everything
// location-specific (shortcuts, .local.env) is regenerated here.
// Zero dependencies.

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { Writable } = require("stream");
const { spawnSync } = require("child_process");

const HERE = __dirname;
const P = (f) => path.join(HERE, f);
const args = new Set(process.argv.slice(2));
const YES = args.has("--yes") || args.has("-y");
const INTERACTIVE = process.stdin.isTTY && !YES;
const SHORTCUT_NAME = "Claude (Proxy).lnk";
const DEFAULT_PROVIDER = "https://api.xkiro.com";

const say = (m = "") => console.log(m);
const ok = (m) => console.log("  [ok]   " + m);
const warn = (m) => console.log("  [warn] " + m);
const step = (m) => console.log("\n" + m);

// ---------- helpers ----------

function ps(script, extraEnv = {}) {
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", env: { ...process.env, ...extraEnv }, windowsHide: true }
  );
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

// readline echoes keystrokes through its output stream; route it through a
// stream we can mute while a secret is typed.
let muted = false;
const out = new Writable({ write(chunk, enc, cb) { if (!muted) process.stdout.write(chunk, enc); cb(); } });
const rl = INTERACTIVE ? readline.createInterface({ input: process.stdin, output: out, terminal: true }) : null;
if (rl) out.columns = process.stdout.columns;

function ask(question, def = "") {
  if (!INTERACTIVE) return Promise.resolve(def);
  return new Promise((res) => rl.question(`  ${question}${def ? ` [${def}]` : ""}: `, (a) => res(a.trim() || def)));
}

async function confirm(question, def) {
  if (!INTERACTIVE) return def;
  const a = (await ask(`${question} (${def ? "Y/n" : "y/N"})`)).toLowerCase();
  return a ? a.startsWith("y") : def;
}

// Prompt without echoing (API keys).
function askSecret(question) {
  if (!INTERACTIVE) return Promise.resolve("");
  process.stdout.write(`  ${question}: `);
  muted = true;
  return new Promise((res) => rl.question("", (a) => {
    muted = false;
    process.stdout.write("\n");
    res(a.trim());
  }));
}

function readEnvFile(file) {
  const env = {};
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1].toUpperCase()] = m[2].replace(/^(["'])(.*)\1$/, "$2");
    }
  } catch (_) {}
  return env;
}

// Update KEY=value lines in place (keeps comments/order); append missing keys.
function setEnvValues(file, values) {
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  for (const [k, v] of Object.entries(values)) {
    const re = new RegExp(`^(\\s*${k}\\s*=).*$`, "m");
    if (re.test(text)) text = text.replace(re, () => `${k}=${v}`);
    else text += (text && !text.endsWith("\n") ? "\n" : "") + `${k}=${v}\n`;
  }
  fs.writeFileSync(file, text);
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(P("config.json"), "utf8")); } catch (_) { return {}; }
}

function claudeSettingsPath() {
  return path.join(os.homedir(), ".claude", "settings.json");
}

// ---------- steps ----------

function checkPlatform() {
  step("1. Checking environment");
  if (process.platform !== "win32") {
    warn("Shortcuts and the Claude Desktop launcher are Windows-only; on this OS only the proxy config is set up.");
  }
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 14) throw new Error(`Node ${process.versions.node} is too old (need 14+).`);
  ok(`Node ${process.versions.node} at ${process.execPath}`);
  ok(`Project folder: ${HERE}`);
}

async function setupEnv() {
  step("2. Provider settings (.env)");
  if (!fs.existsSync(P(".env"))) {
    if (fs.existsSync(P(".env.example"))) fs.copyFileSync(P(".env.example"), P(".env"));
    else fs.writeFileSync(P(".env"), "PROVIDER_BASE_URL=\nAPI_KEY=\nAUTH_STYLE=bearer\n");
    ok("created .env from .env.example");
  }
  const env = readEnvFile(P(".env"));
  const updates = {};

  const url = await ask("Provider base URL", env.PROVIDER_BASE_URL || DEFAULT_PROVIDER);
  if (url !== (env.PROVIDER_BASE_URL || "")) updates.PROVIDER_BASE_URL = url;
  try { new URL(url || DEFAULT_PROVIDER); } catch (_) { warn(`"${url}" is not a valid URL — fix PROVIDER_BASE_URL in .env`); }

  if (env.API_KEY) {
    ok("API key already set (kept)");
    if (INTERACTIVE && (await confirm("Replace the API key?", false))) {
      const k = await askSecret("New API key");
      if (k) updates.API_KEY = k;
    }
  } else {
    const k = await askSecret("API key (input hidden, Enter to skip)");
    if (k) updates.API_KEY = k;
    else warn("no API key set — add API_KEY to .env before using the proxy");
  }

  if (Object.keys(updates).length) {
    setEnvValues(P(".env"), updates);
    ok("saved .env");
  }
}

function setupConfig() {
  step("3. Model aliases (config.json)");
  if (!fs.existsSync(P("config.json"))) {
    fs.writeFileSync(P("config.json"), JSON.stringify({
      listen: { host: "127.0.0.1", port: 8787 },
      exit_with_client: "owned",
      default_model: "xiaomi/mimo-v2.6-pro",
      models: {},
    }, null, 2) + "\n");
    ok("created default config.json");
  } else {
    const cfg = readConfig();
    ok(`config.json found (${Object.keys(cfg.models || {}).length} aliases, port ${(cfg.listen || {}).port || 8787})`);
  }
}

function detectDesktop() {
  step("4. Locating Claude Desktop");
  const found = { appId: "", exe: "" };
  if (process.platform !== "win32") return found;
  const a = ps("(Get-StartApps | Where-Object { $_.Name -eq 'Claude' } | Select-Object -First 1).AppID");
  if (a.out) { found.appId = a.out.split(/\r?\n/)[0].trim(); ok(`AppUserModelID ${found.appId}`); }
  else warn("Claude Desktop not found in the Start menu; the launcher will use its built-in default id.");
  const l = ps("(Get-AppxPackage -Name Claude | Select-Object -First 1).InstallLocation");
  if (l.out) {
    const exe = path.join(l.out.split(/\r?\n/)[0].trim(), "app", "Claude.exe");
    if (fs.existsSync(exe)) { found.exe = exe; ok(`icon source ${exe}`); }
  }
  return found;
}

function writeLocalEnv(desktop) {
  step("5. Writing machine-specific settings (.local.env)");
  const lines = [
    "# Generated by setup.js — machine-specific, git-ignored. Re-run setup.js to refresh.",
    `NODE_PATH=${process.execPath}`,
  ];
  if (desktop.appId) lines.push(`DESKTOP_APP_ID=${desktop.appId}`);
  fs.writeFileSync(P(".local.env"), lines.join("\n") + "\n");
  ok(`NODE_PATH=${process.execPath}`);
}

function makeShortcut(lnkPath, target, targetArgs, icon, description) {
  const r = ps(
    "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK_PATH);" +
    "$s.TargetPath=$env:LNK_TARGET;$s.Arguments=$env:LNK_ARGS;$s.WorkingDirectory=$env:LNK_CWD;" +
    "$s.IconLocation=$env:LNK_ICON;$s.Description=$env:LNK_DESC;$s.WindowStyle=7;$s.Save()",
    { LNK_PATH: lnkPath, LNK_TARGET: target, LNK_ARGS: targetArgs, LNK_CWD: HERE, LNK_ICON: icon, LNK_DESC: description }
  );
  if (r.code !== 0 || !fs.existsSync(lnkPath)) throw new Error(`could not create ${lnkPath}: ${r.err || r.out}`);
}

function specialFolder(name) {
  const r = ps(`[Environment]::GetFolderPath('${name}')`);
  return r.out.split(/\r?\n/)[0].trim();
}

async function setupShortcuts(desktop) {
  step("6. Shortcuts");
  if (process.platform !== "win32") return;
  const wscript = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe");
  const icon = desktop.exe ? `${desktop.exe},0` : `${wscript},0`;
  const launch = P("launch.vbs");

  const here = P(SHORTCUT_NAME);
  makeShortcut(here, wscript, `"${launch}"`, icon, "Start the proxy, then open Claude Desktop");
  ok(`${here}`);
  say("         (double-click it, or copy/pin it anywhere — it always points at this folder)");

  if (args.has("--desktop") || (await confirm("Also create a shortcut on the Desktop?", false))) {
    const dir = specialFolder("Desktop");
    if (dir) {
      const lnk = path.join(dir, SHORTCUT_NAME);
      makeShortcut(lnk, wscript, `"${launch}"`, icon, "Start the proxy, then open Claude Desktop");
      ok(lnk);
    } else warn("could not resolve the Desktop folder");
  }

  if (args.has("--autostart") || (await confirm("Start the proxy automatically at login?", false))) {
    const dir = specialFolder("Startup");
    if (dir) {
      const lnk = path.join(dir, "Claude Proxy.lnk");
      makeShortcut(lnk, wscript, `"${P("start.vbs")}"`, icon, "Start the Claude model-alias proxy (hidden)");
      ok(lnk);
      const legacy = path.join(dir, "mimo-proxy.vbs");
      if (fs.existsSync(legacy)) {
        const txt = fs.readFileSync(legacy, "utf8");
        if (/proxy\.js/i.test(txt) && (await confirm("Remove old Startup entry mimo-proxy.vbs (hardcoded path, breaks if moved)?", true))) {
          fs.unlinkSync(legacy);
          ok("removed old mimo-proxy.vbs");
        } else if (fs.existsSync(legacy)) {
          warn("old mimo-proxy.vbs left in Startup — a second start attempt is harmless but it will break if the folder moves");
        }
      }
    }
  }
}

async function wireClaude() {
  step("7. Wiring Claude Code to the proxy");
  if (args.has("--no-claude")) { ok("skipped (--no-claude)"); return; }
  const cfg = readConfig();
  const listen = cfg.listen || { host: "127.0.0.1", port: 8787 };
  const url = `http://${listen.host || "127.0.0.1"}:${listen.port || 8787}`;
  const file = claudeSettingsPath();
  let doc = {};
  if (fs.existsSync(file)) {
    try { doc = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) { warn(`${file} is not valid JSON (${e.message}) — not modified. Set env.ANTHROPIC_BASE_URL=${url} yourself.`); return; }
  }
  doc.env = doc.env || {};
  if (doc.env.ANTHROPIC_BASE_URL === url) { ok(`ANTHROPIC_BASE_URL already ${url}`); return; }
  if (!(await confirm(`Set ANTHROPIC_BASE_URL=${url} in ${file}?`, true))) { warn("skipped — Claude will not use the proxy until this is set"); return; }
  if (fs.existsSync(file)) {
    const bak = `${file}.bak-${Date.now()}`;
    fs.copyFileSync(file, bak);
    ok(`backup: ${bak}`);
  } else fs.mkdirSync(path.dirname(file), { recursive: true });
  doc.env.ANTHROPIC_BASE_URL = url;
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  ok(`set ANTHROPIC_BASE_URL=${url}`);
}

function portListening(port) {
  const r = ps(`if (Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue) { 'yes' }`);
  return r.out === "yes";
}

function finish() {
  step("8. Status");
  const cfg = readConfig();
  const port = (cfg.listen || {}).port || 8787;
  if (process.platform === "win32") {
    if (portListening(port)) ok(`a proxy is already listening on port ${port}`);
    else say(`  proxy is not running yet — "${SHORTCUT_NAME}" will start it.`);
  }
  const env = readEnvFile(P(".env"));
  if (!env.API_KEY) warn("API_KEY is empty in .env");
  if (env.PROXY_TOKEN) warn("PROXY_TOKEN is set: also set ANTHROPIC_AUTH_TOKEN to the same value in ~/.claude/settings.json env");
  say("\nDone. Open the shortcut to launch Claude Desktop through the proxy.");
  say("Moved the folder? Run `node setup.js` again.");
}

async function uninstall() {
  step("Uninstalling");
  const dirs = process.platform === "win32" ? [HERE, specialFolder("Desktop")] : [];
  for (const d of dirs) {
    const f = d && path.join(d, SHORTCUT_NAME);
    if (f && fs.existsSync(f)) { fs.unlinkSync(f); ok(`removed ${f}`); }
  }
  const st = specialFolder("Startup");
  const s = st && path.join(st, "Claude Proxy.lnk");
  if (s && fs.existsSync(s)) { fs.unlinkSync(s); ok(`removed ${s}`); }
  if (fs.existsSync(P(".local.env"))) { fs.unlinkSync(P(".local.env")); ok("removed .local.env"); }

  const file = claudeSettingsPath();
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    const url = doc.env && doc.env.ANTHROPIC_BASE_URL;
    if (url && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url) &&
        (await confirm(`Remove ANTHROPIC_BASE_URL (${url}) from ${file}?`, true))) {
      fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
      delete doc.env.ANTHROPIC_BASE_URL;
      fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
      ok("removed ANTHROPIC_BASE_URL (Claude talks to Anthropic directly again)");
    }
  } catch (_) {}
  say("\nKept .env, config.json and the project files. Delete the folder to remove everything.");
}

(async () => {
  try {
    say("Claude model-alias proxy — setup");
    if (args.has("--uninstall")) { await uninstall(); return; }
    checkPlatform();
    await setupEnv();
    setupConfig();
    const desktop = detectDesktop();
    writeLocalEnv(desktop);
    await setupShortcuts(desktop);
    await wireClaude();
    finish();
  } catch (e) {
    console.error("\nSetup failed: " + e.message);
    process.exitCode = 1;
  } finally {
    if (rl) rl.close();
  }
})();
