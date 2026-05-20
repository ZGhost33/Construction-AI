# Construction BI Pipeline

Polls Pocket AI devices every 15 minutes, analyzes recordings with Claude, and writes structured data to Notion.

```
Pocket AI → Claude Sonnet → Notion (5 databases per business)
```

## Setup

### 1. Install dependencies

```bash
cd construction-bi-pipeline
npm install
```

### 2. Configure credentials

Edit `config.json` and replace every `REPLACE_ME` value:

| Field | Where to get it |
|-------|----------------|
| `anthropic_api_key` | console.anthropic.com → API Keys |
| `pocket_api_key` | Pocket AI app → Settings → API |
| `notion_token` | notion.so → Settings → Integrations → New integration |
| `notion_databases.*` | Open the database in Notion, copy the ID from the URL |

**Notion database IDs** are the 32-character hex string in the URL:
```
https://notion.so/yourworkspace/DATABASE_ID_HERE?v=...
```

### 3. Share Notion databases with your integration

In each Notion database:
- Click ··· → Add connections → select your integration

You must do this for all 5 databases per business.

### 4. Run

```bash
npm start
```

Logs look like:
```
[2026-05-12 09:00:00] Starting pipeline — polling every 15 minutes
[2026-05-12 09:00:00] [Cruz Services] Fetching recordings...
[2026-05-12 09:00:01] [Cruz Services] Found 12 total, 8 completed
[2026-05-12 09:00:01] [Cruz Services] Skipping already-processed recording rec_abc123
[2026-05-12 09:00:01] [Cruz Services] Processing recording rec_xyz789...
[2026-05-12 09:00:03] [Cruz Services] Claude identified client: "Lisa Galan" (high confidence)
[2026-05-12 09:00:04] [Cruz Services] Writing conversation log to Notion...
[2026-05-12 09:00:04] [Cruz Services] Writing 3 client detail(s)...
[2026-05-12 09:00:05] [Cruz Services] Writing 2 commitment(s)...
[2026-05-12 09:00:05] [Cruz Services] ✓ Recording rec_xyz789 processed successfully
```

### Run as a background service (VPS)

Using PM2:
```bash
npm install -g pm2
pm2 start src/index.js --name "construction-bi"
pm2 save
pm2 startup   # follow the printed command to auto-start on reboot
```

Or with systemd — create `/etc/systemd/system/construction-bi.service`:
```ini
[Unit]
Description=Construction BI Pipeline

[Service]
WorkingDirectory=/path/to/construction-bi-pipeline
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10
User=your-user

[Install]
WantedBy=multi-user.target
```

## File reference

| File | Purpose |
|------|---------|
| `config.json` | All credentials and business configuration |
| `processed_recordings.json` | Auto-created. Tracks which recording IDs have been processed so they're never written twice |
| `src/index.js` | Entry point — polling loop |
| `src/pipeline.js` | Orchestrates one business: fetch → analyze → write |
| `src/pocket.js` | Pocket AI API client |
| `src/claude.js` | Claude API with prompt caching |
| `src/notion.js` | Notion API writes |
| `src/storage.js` | Reads/writes `processed_recordings.json` |

## Notion database schema

All five databases must be created manually in Notion. Required properties:

### Clients
| Property | Type |
|----------|------|
| Name | Title |
| Status | Select: Lead / Active / Punch List / Closed |
| Start Date | Date |
| Target Completion | Date |
| Address | Text |
| Primary Contact | Text |
| Notes | Text |

### Conversation Log
| Property | Type |
|----------|------|
| Title | Title |
| Client | Relation → Clients |
| Date | Date |
| Participants | Multi-select |
| Summary | Text |
| Full Transcript | Text |
| Confidence | Select: High / Medium / Low |

### Client Details
| Property | Type |
|----------|------|
| Detail | Title |
| Client | Relation → Clients |
| Category | Select: Finishes / Layout / Schedule / Budget / Other |
| Source Conversation | Relation → Conversation Log |
| Date Captured | Date |

### Commitments
| Property | Type |
|----------|------|
| What | Title |
| Client | Relation → Clients |
| Who Promised | Text |
| Promised To | Text |
| By When | Date |
| Status | Select: Open / Done / Overdue / Cancelled |
| Source Conversation | Relation → Conversation Log |

### Open Questions
| Property | Type |
|----------|------|
| Question | Title |
| Client | Relation → Clients |
| Asked By | Text |
| Status | Select: Open / Answered / Dropped |
| Source Conversation | Relation → Conversation Log |

## Adding a new business

Add an entry to the `businesses` array in `config.json` following the same structure as Cruz Services. The pipeline will pick it up on the next run without restarting.

## Prompt caching

The client list and people roster are sent to Claude as a cached system prompt. After the first call per session, Anthropic caches this content — you'll see `cache_read` tokens in the logs, which cost ~10× less than regular input tokens. With 10–20 recordings per poll, this saves meaningfully over time.

## Troubleshooting

**"Client not found in Notion"** — The client exists in Claude's response but not in your Notion Clients database. Create the client page there; the recording will be written without a relation until then.

**Notion 400 errors** — Usually a property name mismatch. The property names in `src/notion.js` must exactly match your Notion database columns (case-sensitive).

**Recording stuck pending** — Pocket AI recordings in `state: pending` are skipped. They'll be picked up once they transition to `state: completed`.

**Config changes** — The pipeline reloads `config.json` at the start of each poll, so you can add clients or fix credentials without restarting.
