# Construction BI Pipeline — System Context for Hermes

This document describes a voice-to-CRM pipeline built for **Cruz Services**, a residential construction company in Stuart, FL. Luis (the owner) wears a **Pocket AI** device on the job site. Every conversation gets automatically transcribed, analyzed, and written to Notion and Jobber — with no manual input required.

---

## What the System Does

1. **Pocket AI device** records field conversations (client walkthroughs, crew briefings, supplier calls)
2. Every 15 minutes the pipeline fetches new completed recordings from the Pocket API
3. **Claude (claude-sonnet-4-6)** analyzes the transcript and extracts:
   - Which client the conversation was about
   - A plain-English summary
   - Commitments made (who owes what, by when)
   - Open questions that need answers
   - Client preference details (finishes, layout decisions, schedule notes)
4. Results are written to **5 linked Notion databases**
5. A formatted note is added to the client's active job in **Jobber CRM**
6. The pipeline runs 24/7 on a **Hetzner VPS** — MacBook does not need to be on

---

## Infrastructure

| Component | Details |
|---|---|
| VPS | Hetzner — IP `5.161.227.111`, server name ZGhost |
| Process manager | PM2, process name `construction-bi` |
| Pipeline path | `/root/construction-bi-pipeline/` |
| Node binary | `/root/.hermes/node/bin/node` |
| PM2 binary | `/root/.hermes/node/lib/node_modules/pm2/bin/pm2` |
| Poll interval | Every 15 minutes |
| Location webhook | Port 3456 (GPS check-ins from phones) |

---

## Key Files

```
/root/construction-bi-pipeline/
├── config.json              # All credentials and client list
├── jobber-tokens.json       # Jobber OAuth tokens (auto-refreshed)
├── jobber-cli.js            # CLI for Hermes to call (note/jobs/clients/run)
├── processed_recordings.json # Deduplication log
├── location-cache.json      # GPS check-in state
└── src/
    ├── index.js             # Entry point, starts location server + poll loop
    ├── pipeline.js          # Main orchestration
    ├── pocket.js            # Pocket AI API client
    ├── claude.js            # Claude analysis + prompt caching
    ├── notion.js            # Writes to all 5 Notion databases
    ├── jobber.js            # Jobber GraphQL API client
    ├── location-server.js   # HTTP webhook for GPS check-ins
    ├── location-cache.js    # Reads/writes location-cache.json
    ├── storage.js           # Processed recording deduplication
    └── logger.js            # Timestamped console logging
```

---

## Businesses Configured

| Business | Status |
|---|---|
| Cruz Services | ✅ Fully live — Pocket, Notion, Jobber all connected |
| Tobias | ⏳ Placeholder — credentials not yet added |
| FSC | ⏳ Placeholder — credentials not yet added |

---

## Active Clients (Cruz Services)

| Name | Address |
|---|---|
| Lisa and Joe Galan | 6022 SE Oakmont Pl, Stuart FL |
| Brian Harris | 6285 SE Oakmont Pl, Stuart FL |
| Jane Joyce | 5071 SE Brandywine Way, Stuart FL |
| Kathrine Boland | 6320 SE Mariner Sands Dr, Stuart FL |
| Lisa Hannan | 5070 SE Burning Tree Circle, Stuart FL |
| Jack Mennella | 5957 SE Oakmont Pl, Stuart FL |
| Jesse and Eva Gallan | 503 Sabal Palm Lane, Palm Beach Gardens FL |
| Martha Glantz | 5611 SE Winged Foot Dr, Stuart FL |
| Diane Costello | 5243 SE Club Way, Stuart FL |
| Deb Vivian | 7029 SE Golf House Drive, Stuart FL |

Client identification uses a keyword shortlist (last name + street name + custom keywords). Example: a recording mentioning "Martha" or "Glantz" maps to Martha Glantz.

---

## Notion Databases (Cruz Services)

| Database | ID | Purpose |
|---|---|---|
| Clients | `34d0b35e5a9e80db9258db9593bed4e1` | Master client list |
| Conversation Log | `34d0b35e5a9e80a887e3e45e2bfd5270` | One entry per recording |
| Client Details | `34d0b35e5a9e80a1b732e7fd6d850caa` | Preferences, decisions, notes |
| Commitments | `34d0b35e5a9e80c7b37afa02631bf146` | Action items with owner + due date |
| Open Questions | `34d0b35e5a9e80e9949bc5c857a06aaa` | Unanswered questions |

Notion token: `ntn_z30093052465h0MgqjPH2X87SlXUp4SDAeJca78DzU3dCI`

---

## Jobber Integration

- **API:** GraphQL at `https://api.getjobber.com/api/graphql`
- **Version header:** `X-JOBBER-GRAPHQL-VERSION: 2026-05-12`
- **Tokens file:** `/root/construction-bi-pipeline/jobber-tokens.json`
- **Auto-refresh:** tokens refresh automatically when within 5 minutes of expiry
- **Token re-auth:** if the refresh token itself goes stale, Luis must run `node jobber-setup.js` on his MacBook once to re-authorize via browser

What gets written to Jobber per recording:
- 📅 Date + "Field Recording" header
- Summary paragraph
- ✅ Commitments (who → what, by when)
- ❓ Open questions
- 📋 Details discussed

---

## Jobber CLI (for Hermes to use)

All commands use: `/root/.hermes/node/bin/node /root/construction-bi-pipeline/jobber-cli.js`

```bash
# Add a note to a client's active job
node jobber-cli.js note "Brian Harris" "Tile delivery confirmed Friday, white grout"
node jobber-cli.js note "Galan" "Client approved oak finish on cabinets"
node jobber-cli.js note "Martha" "Pushing start by one week — confirm with Jorge"

# List jobs for a client
node jobber-cli.js jobs "Brian Harris"

# List all Jobber clients
node jobber-cli.js clients

# Trigger an immediate pipeline run
node jobber-cli.js run
```

Client name matching is fuzzy — first name, last name, or full name all work.

---

## GPS Location System

Luis and crew can check in to a client location by hitting:
```
POST http://localhost:3456/set-location
Body: { "pocket_api_key": "pk_...", "client": "Brian Harris" }
```

When a recording comes in from a device that checked in within the last 12 hours, the pipeline uses the GPS-confirmed client instead of Claude's guess (and marks confidence as "high").

Intended setup: iPhone Shortcuts / Android MacroDroid geofences that auto-post to this endpoint when arriving at a job site. Not yet fully deployed to crew.

---

## Pipeline PM2 Commands

```bash
# Check status
/root/.hermes/node/bin/node /root/.hermes/node/lib/node_modules/pm2/bin/pm2 list

# View logs
/root/.hermes/node/bin/node /root/.hermes/node/lib/node_modules/pm2/bin/pm2 logs construction-bi --lines 50 --nostream

# Restart (picks up config/code changes)
/root/.hermes/node/bin/node /root/.hermes/node/lib/node_modules/pm2/bin/pm2 restart construction-bi

# Stop
/root/.hermes/node/bin/node /root/.hermes/node/lib/node_modules/pm2/bin/pm2 stop construction-bi
```

---

## People at Cruz Services

| Name | Role |
|---|---|
| Luis | General contractor, always present |
| Jorge Cruz | Contractor and partner |
| Danilo | Field supervisor |
| Jose / Ze | Lead carpenter and framer (same person) |
| Andre | Electrician (Beaver Smart) |
| Max / Edmilson / Jamusa | Cabinet installers |
| Renato | Drywaller |
| Reynaldo Farias | Plumber |
| Sean VanArman | Electrician |
| Juan Paz | Countertops |
| George Bruce | Flooring |
| David Hutchinson | Supplier at Lansing Building Products |
| Tobias Brown | Contractor and partner |
| Suely / Fernando Canuto | FSC owners |
| John Govea | Project manager at Alto Investments |
| Fabrizio Santoro | Owner at Alto Investments |

---

## Things Hermes Can Do

- **Add a note to a Jobber job** — just say "note for [client]: [text]"
- **Check what jobs a client has** — "what jobs does Brian Harris have?"
- **List all clients** — "show me all Jobber clients"
- **Force a pipeline run** — "run the pipeline now" or "check for new recordings"
- **Check pipeline health** — "is the pipeline running?" or "show me the pipeline logs"
- **Restart the pipeline** — after a config change or error

---

## Known Limitations

- Jobber tokens expire every ~1 hour and auto-refresh — but if the refresh token itself expires or is invalidated, Luis must run `node jobber-setup.js` on his MacBook to re-authorize
- New clients can be added by voice (say "new client, [name], address is [address]" during a recording) — Claude will detect it and create the client in Notion + config.json automatically
- Tobias and FSC pipelines are stubbed in config.json but not yet live (keys say `REPLACE_ME`)
