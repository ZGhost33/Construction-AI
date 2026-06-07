# CLAUDE.md — orientation for Claude Code sessions

Single-business construction back-office pipeline. One deployment = one business,
fully described by `config.json` + credential files (never in code). See `CONFIG.md`.

## Live vs. legacy — READ THIS BEFORE EDITING INGEST CODE

There are **two ingest implementations**. Only one runs in production.

- **LIVE: `pocket-ingest.js`** — invoked by a Hermes cron every 15 min. This is the
  real path: Pocket MCP audio → `src/segmenter.js` → 3-signal confidence gate →
  `review-queue.json` (strict mode) or `jobber-cli.js` note (normal mode). Speaker ID
  is **local resemblyzer** via `voice-identify.py` (venv at `/root/venv-voice`).
  **Edit this file for any ingest behavior change.**

- **LEGACY / DEAD: `src/index.js` → `src/pipeline.js` → `src/voice-identifier.js`** —
  the old PM2-managed process (`npm start` / `npm run dev`). REST-only, writes straight
  to Notion/Jobber. **No cron runs it.** Kept only because `src/voice-identifier.js`
  still exports helpers used by `voice-cli.js`. Do **not** edit it to change live
  ingest behavior — you'll be editing the wrong file. (The duplicate root `index.js`,
  `pipeline.js`, `voice-identifier.js` were deleted; only the `src/` copies remain.)

## Crons (Hermes, profile `z`)

`pocket-ingest` (15m → pocket-ingest.js) · `field-capture-drain` (5m → capture-drain.js) ·
`commit-sync-notion` (15m → commit-sync.sh → commit-sync-notion.js) ·
`morning-brief` (`0 11 * * *`) · `schedule-scan` (`30 11 * * *` → schedule-cli.js scan) ·
`health-check` (30m). No PM2. Node: `/root/.hermes/node/bin/node` (Node 22).

## Speaker ID

Local only (resemblyzer/GE2E), no cloud. `voice-identify.py` run through the
`/root/venv-voice` venv; enrollment via `voice-cli.js`. Azure was fully retired —
the only `azure` string left is a "remove this unused key" warning in `validate-config.js`.

## Config

`businesses[0]` is the **single source of truth** (incl. `notion_token`,
`notion_databases`). `config.json` is never committed. Validate with
`node validate-config.js`; read-only health via `node smoke-test.js`.

## Deploy

`./deploy.sh <target|all>` — rsync from this working copy to targets in `deployments.json`
(gitignored). Excludes all secrets/state; **no `--delete`** (remote-only files are left
alone — deleting a repo file does NOT remove it from the VPS). Runs remote validate +
smoke-test per target. `provision.sh` stands up a fresh box (incl. the speaker-ID venv).

## Standing constraints

- **Closed client roster** — the pipeline never invents clients outside `businesses[0].clients`.
- **Strict mode is the safety model** — `auto_write_mode` defaults to strict; the
  `/review` human gate + `--confirm` previews guard all live writes. Z is the sole live writer.
- **Never commit** `config.json`, `*-tokens.json`, `drive-service-account.json`, or any
  client-data/state JSON (`.gitignore` blocks them; `node_modules` is gitignored too).

## Known caveat — mark-processed timing (unfixed as of this writing)

`pocket-ingest.js` marks a recording processed on *any normal return* of
`processRecording()`. Two failure paths return normally and thus silently mark
(never retried): (A) MCP fetch fails → REST list has no transcript segments →
"no segments, skipping" → whole recording dropped; (B) `analyzeConversation` throws →
that conversation is dropped. Download/Jobber failures degrade gracefully (no drop).
If touching ingest reliability, make marking conditional on a terminal outcome + add a
bounded attempt counter in `processed_recordings.json`.
