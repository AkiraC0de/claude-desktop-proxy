# mimo-proxy — Anthropic → any-provider model alias

Claude Code talks to `http://127.0.0.1:8787` believing it is Anthropic. The
proxy forwards everything to the provider in `.env` and rewrites only the
`model` field using `config.json`.

## Files
- `.env` — `PROVIDER_BASE_URL` (Anthropic-compatible endpoint), `API_KEY`,
  optional `AUTH_STYLE` (`bearer` | `x-api-key` | `both`).
- `config.json` — alias map: `"claude-sonnet-5": "xiaomi/mimo-v2.6-pro"`.
  Exact matches win; unlisted claude/anthropic ids fall back to `default_model`.
- `proxy.js` — the proxy (Node, zero dependencies).
- `setup.js` — installer (see Setup). `.local.env` — machine-specific paths it generates.
- `start.vbs` — hidden proxy-only launcher (the autostart shortcut points at it).
- `launch.vbs` — Desktop launcher with proxy lifecycle (see Usage).
- `proxy.log` — one line per request (no bodies, no keys); rotated to
  `proxy.log.1` at 5 MB.

## Setup (Windows)
```
node setup.js
```
Creates `.env` (asks for provider URL and API key), detects Node and Claude
Desktop, writes the git-ignored `.local.env`, creates `Claude (Proxy).lnk` in
this folder, and sets `ANTHROPIC_BASE_URL` in `~/.claude/settings.json` (with a
backup). It can also add a Desktop shortcut and a start-at-login entry.

- The shortcut opens Claude Desktop and starts the proxy first if needed. Copy
  or pin it anywhere; it points at this folder.
- **Moved the folder?** Run `node setup.js` again — shortcuts and `.local.env`
  are regenerated. Nothing in the project hardcodes a path.
- Flags: `--yes` (no prompts), `--desktop`, `--autostart`, `--no-claude`,
  `--uninstall`.

## Usage
- Start manually: `node proxy.js` (or double-click `start.vbs` for hidden mode).
- Edit `.env` / `config.json` any time — re-read per request, no restart needed.
- Claude Code wiring (`~/.claude/settings.json`):
  - `ANTHROPIC_BASE_URL` = `http://127.0.0.1:8787`
  - `ANTHROPIC_MODEL` = any alias from config.json (e.g. `claude-sonnet-5`)
- `/v1/models` is relayed to the provider by default. Set
  `"models_list": "aliases"` in `config.json` to serve the alias keys locally
  instead, so the model picker shows the Claude-style names.
- Optional `PROXY_TOKEN` in `.env`: when set, clients must send it as their API
  key (`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`). Requests with a non-loopback
  `Host` header or browser cross-site headers are always rejected.
- `launch.vbs` opens Claude Desktop, starting the proxy first if the configured
  port is not listening, and stops that proxy once Claude Desktop (not the CLI)
  exits. `config.json` `"exit_with_client": "always"` also stops a pre-existing proxy.
- Copy `.env.example` to `.env`. `.env`, `proxy.log` and `proxy.pid` are git-ignored.

## Reliability and tuning (`config.json`, all optional)
- `retry`: `{ "max": 2, "base_ms": 200 }` — retries 502/503/504/529 and
  connection errors with backoff, **only before any response byte is sent**.
  `Retry-After` over 5 s is not waited for. 429 and other 4xx are never retried.
- `fallback_models`: `{ "openai/gpt-6-sol": "anthropic/claude-sonnet-5.5" }` —
  if the model a request was mapped to answers 429/502/503/504/529, the request
  is re-sent once with the fallback model. The log shows `fell_back_from=`.
- `timeouts`: `{ "headers_ms": 300000, "idle_ms": 120000 }` — cuts off an
  upstream that never answers, or a stream that goes silent. Slow-but-live
  streams are not affected.
- Upstream connections are reused (keep-alive), `.env` and `config.json` are
  re-read only when they change, and logging is asynchronous.

## Observability
One line per request, written when the response closes (so `ms=` covers the
whole stream):

```
POST /v1/messages model=claude-sonnet-5->xiaomi/mimo-v2.6-pro via=default status=200 ms=842 bytes=1348 ua=claude-cli/2.1.0 rid=req_abc retries=1
```
- `via=alias|default|passthrough` — `default` means the id had no entry in
  `config.json` and fell back to `default_model`. Add an alias if unwanted.
- `ua=` is the client, `rid=` the provider's request id (match it in their
  request-log page), `src=upstream|network|proxy|client` says who failed.
- `GET /_proxy/health` and `GET /_proxy/stats` (counts by status/model/source).

## Tests and benchmarks
Zero dependencies; everything runs on loopback against a mock upstream in temp
folders, never your real proxy, `.env` or provider.
```
node test/run.js                               all areas, ~4 min
node test/run.js --area perf,rel,obs --quick   shorter
node test/run.js --out test/results/x.json     save results
node test/compare.js test/results/before.json test/results/after.json
```
`test/results/before.json` is the baseline of the pre-optimisation proxy
(`before.txt`/`compare.md` hold the readable versions).

## Effort (thinking) control
Effort is client-side and per model-alias — no proxy involvement:
- `/effort low|medium|high|max` in the composer switches it live and saves it to
  `~/.claude/settings.json` as `modelSettings.<alias>.effortLevel` (`max` is
  session-only by design).
- `modelSettings.<alias>.maxEffortLevel` sets a per-alias ceiling.
- The model-menu dropdown only shows for built-in Claude ids; `/effort` works
  for every alias.

## Notes
- Auth is injected from `.env` (client headers are dropped), so the key never
  has to live in Claude Code.
- `count_tokens` is synthesized locally if the provider lacks it.
