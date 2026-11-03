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
- `start.vbs` — hidden launcher (copied to the Startup folder for autostart).
- `launch.vbs` — Desktop launcher with proxy lifecycle (see Usage).
- `proxy.log` — one line per request (no bodies, no keys); rotated to
  `proxy.log.1` at 5 MB.

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
