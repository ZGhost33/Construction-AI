# Configuration Reference (`config.json`)

Every deployment of this pipeline is a single, isolated instance for **one
business**. Everything business-specific lives in `config.json` and the
credential files beside it — **never in code**. Standing up a new business
requires only a new `config.json` plus credentials; no source edits.

`config.json` is **never committed** (it holds live secrets and client PII).
Copy `config.example.json`, fill it in, and validate with:

```
node validate-config.js
```

## Schema version

The file is versioned with a top-level `schema_version` (current: **1**).
Migrations are applied by `migrate-config.js`, which reads `schema_version`,
runs ordered migrations, writes a `.bak`, and bumps the version. A config that
is already at the current version is a no-op.

## Top-level keys

| Key | Type | Required | Default | Purpose |
|-----|------|----------|---------|---------|
| `schema_version` | int | yes | `1` | Config schema version for migrations. |
| `business_short_name` | string | no | falls back to `businesses[0].name` | Short label used in prompts/UI. |
| `timezone` | IANA string | no | `America/New_York` | Drives all date math (briefs, schedules, "today"), and the cron times in `provision.sh`. **Set this per business.** |
| `calendar_name` | string | no | `Cruz Schedule` | Exact name of the shared Google Calendar the pipeline writes job events to. The service account must have edit access to a calendar with this name. |
| `anthropic_api_key` | string | **yes** | — | Claude API key. `loadConfig()` throws if missing or still the placeholder. |
| `notion_token` | string | yes (for Notion sync) | mirrors `businesses[0].notion_token` | Notion integration token used by the monitor/sync scripts. |
| `notion_databases` | object | yes (for Notion sync) | may live under `businesses[0]` | Map of database IDs: `clients`, `conversation_log`, `client_details`, `commitments`, `open_questions`. |
| `google_drive_root_folder_id` | string | yes (for Drive) | — | Root Drive folder where per-client folders & schedule docs are written. |
| `azure_speaker_key` | string | no | — | Azure Speech key for speaker identification. If empty/omitted, voice ID is skipped. |
| `azure_speaker_region` | string | no | `eastus` | Azure Speech region. |
| `auto_write_mode` | bool | no | `false` | If true, bypasses some manual gating. Keep `false` — the `/review` human gate and `--confirm` previews are the safety model. |
| `silence_threshold_seconds` | int | no | `1800` | Recording-gap threshold used during ingest. |
| `poll_interval_minutes` | int | no | `15` | Pipeline poll cadence. |
| `location_server_port` | int | no | `3456` | Local location-server port. |
| `location_timeout_hours` | int | no | `12` | Location staleness window. |
| `businesses` | array | **yes** | — | **Exactly one** business object (see below). The array form is retained for backward compatibility; only `businesses[0]` is used. |

## `businesses[0]` (the business object)

| Key | Type | Required | Purpose |
|-----|------|----------|---------|
| `name` | string | **yes** | Legal/display business name. Used in planner prompts. |
| `pocket_api_key` | string | yes (for ingest) | Primary Pocket (recorder) API key. |
| `pocket_devices` | array | no | `[{ "api_key", "person" }]` — maps each recorder device to the person wearing it. |
| `notion_token` | string | yes (for Notion) | Notion integration token (mirror of the top-level one). |
| `jobber` | object | yes (for Jobber) | `{ client_id, client_secret, redirect_uri }`. OAuth tokens are stored separately in `jobber-tokens.json`. |
| `notion_databases` | object | yes (for Notion) | Same shape as the top-level map. |
| `clients` | array | yes | The **closed client roster**: `[{ name, address, keywords? }]`. The pipeline never invents clients outside this list. |
| `people` | array | yes | `[{ name, role }]` — the crew, for speaker attribution. |

## Credential files (alongside `config.json`, all gitignored)

| File | Purpose |
|------|---------|
| `config.json` | This file — secrets + roster. |
| `jobber-tokens.json` | Jobber OAuth access/refresh tokens. |
| `drive-service-account.json` | Google service-account key (Drive + Calendar). |
| `cruz-calendar.json` | Cached resolved Google Calendar id (auto-discovered by name). |

## Runtime/state files (machine-specific, gitignored — do not copy between deployments)

`processed_recordings.json`, `location-cache.json`, `client-scopes.json`,
`converted-quotes.json`, `job-plans.json`, `commitments.json`,
`cruz-calendar.json`, `review-queue.json`, `voice-profiles.json`,
`expenses.json`, `receipts.json`, `recall-index.json`, `capture-queue.json`.

## Security notes

- Keys are stored in plaintext in `config.json`. Restrict file permissions and
  **rotate any key that was ever committed or pasted into a chat.**
- The Telegram bot token is **not** in `config.json` — it lives in the Hermes
  profile environment (delivery side). `config.telegram` is reserved/optional.
- Never commit `config.json`, `*-tokens.json`, `drive-service-account.json`, or
  any client-data JSON. `.gitignore` blocks them; `validate-config.js` and the
  deploy tooling re-confirm.
