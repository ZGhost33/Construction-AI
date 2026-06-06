# Cruz Services — North Star

The purpose of this system, and the bar every change is measured against.

## Who it's for

A **general contractor and his upper management** running **many jobs at once**.
An intelligent layer that helps them **sort through the chaos of construction** —
so nothing falls through the cracks and the people in charge stay in control.

## What "good" looks like

1. **Easy to use.** Simple enough that a busy GC and his managers reach for it
   instead of avoiding it.
2. **Doesn't break all the time.** Reliable and predictable. When something does
   fail, it fails loudly to the office and degrades gracefully — it never goes
   quietly wrong.
3. **The field crew can learn and actually use it.** One simple mental model per
   role. Every field action returns a plain, trustworthy "got it."
4. **The CEO is confident in the output and can easily understand it.** Clear,
   consistent numbers with visible provenance — he always knows what's
   machine-read vs. human-confirmed.
5. **A steady cycle of information that liberates, not overwhelms.** A calm rhythm
   (morning brief, review nudges) that surfaces what matters without flooding.
6. **Nothing is missed.** Every conversation, every promise, and every piece of
   job data is captured and **readily retrievable**.

## How we serve it (current architecture)

- **Field crew (Danilo, Jorge)** — capture-only bots: notes, receipts/photos,
  and now narrow calendar add/list. They cannot touch live financial records.
- **Office (Z)** — the single trusted writer. Drains captures, runs the review
  queue, writes to Jobber/Drive/Calendar/Notion.
- **Human-in-the-loop gate** — nothing hits a live record until the office
  approves it via `/review`. Approvals enforce the closed client roster.
- **Steady cycle** — cron jobs: Pocket voice ingest (15m), field-capture drain
  (5m), commitments sync (15m), schedule scan (daily), morning brief (daily 7am ET).

## Scorecard (living — update as we improve)

| Goal | State | Notes |
|---|---|---|
| Nothing missed (capture) | **Strong** | ✅ Recall now built — `recall-cli.js "Client"` pulls jobs, P&L, promises, meetings, schedule & recent activity into one answer |
| Crew can learn it | **Improved** | ✅ Plain-language confidence receipts on every field action ("Got it — the office will see this") |
| Doesn't break | **Improving** | ✅ `health-check.js` watchdog (every 30m) pages the office only on a real problem (dead cron, offline bot, stuck drain, disk) |
| CEO trusts the output | **Improving** | ✅ Provenance markers — auto-read OCR numbers flagged "🤖 not yet confirmed" in review + morning brief |
| Steady, non-overwhelming cycle | Partly | Review-queue depth/aging now watched by health-check (advisory); morning brief surfaces $ awaiting confirmation |

## Design rules (don't regress these)

- **Capture is reversible; live writes are gated.** Keep the field bots
  capture-only; keep the office as the sole live writer.
- **Closed roster.** Never invent a client or a person. Fuzzy-match and ask.
- **Fail loud, degrade gracefully.** A dropped cron must page the office; a failed
  OCR still files the item as a plain note + photo.
- **Plain language out.** Crew and CEO messages avoid jargon and ambiguity.
- **Add inputs only when retrieval + reliability are solid.** More capture into a
  leaky system makes "nothing is missed" harder, not easier.
