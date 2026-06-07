#!/usr/bin/env bash
#
# provision.sh — stand up ONE new isolated deployment of the construction BI
# pipeline for a single business. Idempotent: safe to re-run. Read-only toward
# live business systems (it only validates + smoke-tests; it never writes a
# Jobber/Drive/Calendar/Notion record).
#
# What it does:
#   1. ensure git + Node 22
#   2. clone (or fast-forward) the repo
#   3. npm ci
#   3b. set up the speaker-ID Python venv (resemblyzer; local, no cloud key)
#   4. place config.json + credential files from an operator secrets dir
#   5. validate-config.js  (ABORTS on schema errors)
#   6. generate Hermes cron wrapper scripts
#   7. register the 6 crons (daily times derived from the configured timezone)
#   8. read-only smoke-test  (reported, non-fatal)
#
# Everything business-specific comes from the secrets dir's config.json — no
# code is edited to onboard a business.
#
# Usage:
#   ./provision.sh --secrets /path/to/secrets [options]
#
# Options:
#   --secrets DIR     dir holding config.json (+ drive-service-account.json,
#                     jobber-tokens.json, cruz-calendar.json). REQUIRED unless
#                     the repo already has a config.json.
#   --repo-dir DIR    install location        (default: /root/construction-bi-pipeline)
#   --repo-url URL    git remote              (default: git@github.com:ZGhost33/Construction-AI.git)
#   --branch NAME     branch to deploy        (default: main)
#   --profile NAME    Hermes profile to register crons under (default: z)
#   --node-bin PATH   node binary             (default: /root/.hermes/node/bin/node)
#   --force           overwrite an existing config.json from --secrets
#   --skip-cron       do not touch Hermes crons
#   --skip-voice      do not set up the speaker-ID Python venv
#   --dry-run         print every action, change nothing
#   -h, --help        this help
#
set -euo pipefail

# ── defaults ──────────────────────────────────────────────────────────────────
SECRETS=""
REPO_DIR="/root/construction-bi-pipeline"
REPO_URL="git@github.com:ZGhost33/Construction-AI.git"
BRANCH="main"
PROFILE="z"
NODE_BIN="/root/.hermes/node/bin/node"
HERMES_SCRIPTS="$HOME/.hermes/scripts"
HERMES_LOGS="$HOME/.hermes/logs"
FORCE=0
SKIP_CRON=0
SKIP_VOICE=0
DRY_RUN=0
# Speaker-ID venv path is hardcoded in pocket-ingest.js (PYTHON); keep in sync.
VOICE_VENV="/root/venv-voice"

# ── arg parsing ───────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --secrets)   SECRETS="$2"; shift 2 ;;
    --repo-dir)  REPO_DIR="$2"; shift 2 ;;
    --repo-url)  REPO_URL="$2"; shift 2 ;;
    --branch)    BRANCH="$2"; shift 2 ;;
    --profile)   PROFILE="$2"; shift 2 ;;
    --node-bin)  NODE_BIN="$2"; shift 2 ;;
    --force)     FORCE=1; shift ;;
    --skip-cron) SKIP_CRON=1; shift ;;
    --skip-voice) SKIP_VOICE=1; shift ;;
    --dry-run)   DRY_RUN=1; shift ;;
    -h|--help)   sed -n '2,42p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# ── helpers ───────────────────────────────────────────────────────────────────
c_blue=$'\033[34m'; c_red=$'\033[31m'; c_grn=$'\033[32m'; c_yel=$'\033[33m'; c_off=$'\033[0m'
log()  { printf '%s==>%s %s\n' "$c_blue" "$c_off" "$*"; }
ok()   { printf '%s ok %s %s\n' "$c_grn" "$c_off" "$*"; }
warn() { printf '%s warn%s %s\n' "$c_yel" "$c_off" "$*"; }
die()  { printf '%s err %s %s\n' "$c_red" "$c_off" "$*" >&2; exit 1; }
# run CMD... — honors --dry-run
run() {
  if [ "$DRY_RUN" -eq 1 ]; then printf '   %s[dry-run]%s %s\n' "$c_yel" "$c_off" "$*"; return 0; fi
  "$@"
}

log "Provisioning deployment at $REPO_DIR (branch=$BRANCH, profile=$PROFILE)$([ $DRY_RUN -eq 1 ] && echo '  [DRY-RUN]')"

# ── 1. prerequisites ──────────────────────────────────────────────────────────
log "Checking prerequisites"
command -v git >/dev/null 2>&1 || die "git not found — install git first."
if [ ! -x "$NODE_BIN" ]; then
  if command -v node >/dev/null 2>&1; then NODE_BIN="$(command -v node)"; else die "node not found (looked for $NODE_BIN). Install Node 22."; fi
fi
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 22 ] 2>/dev/null && ok "node $("$NODE_BIN" --version) ($NODE_BIN)" || warn "node major=$NODE_MAJOR (<22). Pipeline targets Node 22; continuing."

# ── 2. clone or update ────────────────────────────────────────────────────────
if [ -d "$REPO_DIR/.git" ]; then
  log "Repo exists — fetching $BRANCH"
  run git -C "$REPO_DIR" fetch --quiet origin "$BRANCH"
  run git -C "$REPO_DIR" checkout --quiet "$BRANCH"
  run git -C "$REPO_DIR" merge --ff-only "origin/$BRANCH" || warn "fast-forward skipped (local changes?) — leaving working tree as-is"
else
  log "Cloning $REPO_URL"
  run git clone --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
fi
ok "code in place"

# ── 3. dependencies ───────────────────────────────────────────────────────────
log "Installing dependencies (npm ci)"
if [ -f "$REPO_DIR/package-lock.json" ]; then
  run sh -c "cd '$REPO_DIR' && npm ci --omit=dev 2>/dev/null || npm ci"
else
  warn "no package-lock.json — running npm install"
  run sh -c "cd '$REPO_DIR' && npm install"
fi
ok "dependencies installed"

# ── 3b. speaker-ID Python venv (local resemblyzer; no cloud key) ──────────────
# Speaker identification runs locally via voice-identify.py (resemblyzer/torch)
# inside a dedicated venv that pocket-ingest.js invokes by absolute path.
# Idempotent: skips if the venv already imports the full stack. Non-fatal —
# if this can't complete, the pipeline still runs and degrades to no speaker
# attribution.
if [ "$SKIP_VOICE" -eq 1 ]; then
  warn "skipping speaker-ID venv setup (--skip-voice)"
else
  log "Setting up speaker-ID venv at $VOICE_VENV (resemblyzer)"
  VPY="$VOICE_VENV/bin/python3"
  command -v ffmpeg >/dev/null 2>&1 || warn "ffmpeg not found — speaker ID needs it (apt-get install -y ffmpeg)"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '   %s[dry-run]%s python3 -m venv %s && %s -m pip install numpy resemblyzer soundfile librosa\n' "$c_yel" "$c_off" "$VOICE_VENV" "$VPY"
  elif [ -x "$VPY" ] && "$VPY" -c 'import numpy,resemblyzer,soundfile,librosa,torch' 2>/dev/null; then
    ok "speaker-ID venv already complete — skipping"
  elif ! command -v python3 >/dev/null 2>&1; then
    warn "python3 not found — skipping speaker-ID venv (install python3 + python3-venv, then re-run)"
  else
    [ -x "$VPY" ] || python3 -m venv "$VOICE_VENV" || die "failed to create venv at $VOICE_VENV (need python3-venv)"
    "$VPY" -m pip install --quiet --upgrade pip || warn "pip upgrade failed — continuing"
    if "$VPY" -m pip install --quiet numpy resemblyzer soundfile librosa \
       && "$VPY" -c 'import numpy,resemblyzer,soundfile,librosa,torch' 2>/dev/null; then
      ok "speaker-ID venv ready ($VOICE_VENV)"
    else
      warn "speaker-ID venv install failed — pipeline will run without speaker attribution; re-run after fixing Python deps"
    fi
  fi
fi

# ── 4. place secrets ──────────────────────────────────────────────────────────
log "Placing config + credentials"
copy_secret() { # src-name [required]
  local name="$1" required="${2:-0}" src="$SECRETS/$1" dst="$REPO_DIR/$1"
  if [ -z "$SECRETS" ]; then
    [ -f "$dst" ] && { ok "$name already present (no --secrets given)"; return 0; }
    [ "$required" -eq 1 ] && die "$name missing and no --secrets dir provided"; return 0
  fi
  if [ ! -f "$src" ]; then
    [ "$required" -eq 1 ] && die "required secret $name not found in $SECRETS"
    warn "$name not in secrets dir — skipping (integration disabled)"; return 0
  fi
  if [ -f "$dst" ] && [ "$name" = "config.json" ] && [ "$FORCE" -eq 0 ]; then
    warn "config.json already exists — keeping it (use --force to overwrite)"; return 0
  fi
  run install -m 600 "$src" "$dst"
  ok "$name placed (0600)"
}
copy_secret "config.json" 1
copy_secret "drive-service-account.json" 0
copy_secret "jobber-tokens.json" 0
copy_secret "cruz-calendar.json" 0

# ── 5. validate config (hard gate) ────────────────────────────────────────────
log "Validating config"
if [ "$DRY_RUN" -eq 1 ]; then
  printf '   %s[dry-run]%s %s validate-config.js\n' "$c_yel" "$c_off" "$NODE_BIN"
else
  "$NODE_BIN" "$REPO_DIR/validate-config.js" || die "config invalid — fix the errors above and re-run."
fi
ok "config valid"

# Resolve timezone from the (now-validated) config for cron scheduling.
if [ "$DRY_RUN" -eq 1 ] && [ ! -f "$REPO_DIR/config.json" ]; then
  TZ_CONF="America/New_York"; warn "dry-run without config.json — assuming timezone $TZ_CONF"
else
  TZ_CONF="$("$NODE_BIN" -e "try{const s=require('$REPO_DIR/src/config').settings();process.stdout.write(s.timezone||'America/New_York')}catch(e){process.stdout.write('America/New_York')}")"
fi
log "Business timezone: $TZ_CONF"

# ── 6. cron wrappers + 7. registration ────────────────────────────────────────
if [ "$SKIP_CRON" -eq 1 ]; then
  warn "skipping cron setup (--skip-cron)"
else
  log "Generating Hermes cron wrappers in $HERMES_SCRIPTS"
  run mkdir -p "$HERMES_SCRIPTS" "$HERMES_LOGS"

  # write_wrapper NAME ENTRYPOINT STYLE
  #   STYLE=silent     -> log to file; emit stdout only on nonzero exit (watchdog)
  #   STYLE=passthrough -> stdout IS the delivered message (brief/scan summaries)
  write_wrapper() {
    local name="$1" entry="$2" style="$3" dst="$HERMES_SCRIPTS/$1.sh"
    if [ "$DRY_RUN" -eq 1 ]; then printf '   %s[dry-run]%s write %s (%s)\n' "$c_yel" "$c_off" "$dst" "$style"; return 0; fi
    local body_silent body_pass
    cat > "$dst" <<WRAP
#!/bin/bash
# ${name} — generated by provision.sh. Hermes cron wrapper.
LOG="$HERMES_LOGS/${name}.log"
mkdir -p "$HERMES_LOGS"
if [ -f "\$LOG" ] && [ "\$(wc -l < "\$LOG")" -gt 2000 ]; then tail -n 1000 "\$LOG" > "\$LOG.tmp" && mv "\$LOG.tmp" "\$LOG"; fi
WRAP
    if [ "$style" = "passthrough" ]; then
      cat >> "$dst" <<WRAP
echo "===== run \$(date -u +%FT%TZ) =====" >> "\$LOG"
OUT="\$($NODE_BIN $REPO_DIR/$entry 2>>"\$LOG")"; code=\$?
printf '%s\n' "\$OUT" | tee -a "\$LOG"
if [ "\$code" -ne 0 ]; then echo "(exit \$code)"; fi
exit 0
WRAP
    else
      cat >> "$dst" <<WRAP
{ echo "===== run \$(date -u +%FT%TZ) ====="; $NODE_BIN $REPO_DIR/$entry; } >> "\$LOG" 2>&1
code=\$?
if [ "\$code" -ne 0 ]; then echo "⚠️ ${name} failed (exit \$code) at \$(date -u +%FT%TZ). Last log:"; tail -n 10 "\$LOG"; fi
exit 0
WRAP
    fi
    chmod +x "$dst"
    ok "wrapper $name.sh"
  }

  write_wrapper "pocket-ingest"        "pocket-ingest.js"      "silent"
  write_wrapper "field-capture-drain"  "capture-drain.js"     "silent"
  write_wrapper "commit-sync-notion"   "commit-sync-notion.js" "silent"
  write_wrapper "health-check"         "health-check.js"      "silent"
  write_wrapper "morning-brief"        "morning-brief.js"     "passthrough"
  write_wrapper "schedule-scan"        "schedule-cli.js scan" "passthrough"

  # Convert a local HH:MM in the configured tz to a UTC "M H * * *" cron expr.
  # NOTE: fixed UTC offset captured at provision time — does not auto-track DST.
  utc_cron() { # HH:MM
    "$NODE_BIN" -e '
      const tz=process.argv[1], [h,m]=process.argv[2].split(":").map(Number);
      const now=new Date();
      // tz offset (minutes) vs UTC: compare the same instant rendered in each
      // zone, parsed back as local — local = UTC + offMin.
      const utcD=new Date(now.toLocaleString("en-US",{timeZone:"UTC"}));
      const tzD=new Date(now.toLocaleString("en-US",{timeZone:tz}));
      const offMin=Math.round((tzD-utcD)/60000);
      let total=h*60+m-offMin; total=((total%1440)+1440)%1440;
      const H=Math.floor(total/60), M=total%60;
      process.stdout.write(`${M} ${H} * * *`);
    ' "$TZ_CONF" "$1"
  }

  # utc_cron is a pure read (no side effects) — compute real times even in dry-run.
  if [ -f "$REPO_DIR/src/config.js" ]; then
    BRIEF_CRON="$(utc_cron 07:00)"; SCAN_CRON="$(utc_cron 07:30)"
  else
    BRIEF_CRON="<utc from 07:00 $TZ_CONF>"; SCAN_CRON="<utc from 07:30 $TZ_CONF>"
  fi

  log "Registering crons under Hermes profile '$PROFILE'"
  command -v hermes >/dev/null 2>&1 || warn "hermes CLI not found — skipping cron registration (run it where Hermes lives)"
  cron_exists() { hermes cron list 2>/dev/null | grep -Fq -- "$1"; }
  reg() { # NAME SCHEDULE STYLE
    local name="$1" sched="$2"
    if command -v hermes >/dev/null 2>&1 && cron_exists "$name"; then ok "cron '$name' already registered — skipping"; return 0; fi
    run hermes cron create "$sched" --name "$name" --script "$name.sh" --no-agent \
        --deliver telegram --workdir "$REPO_DIR" --profile "$PROFILE"
    ok "cron '$name' -> $sched"
  }
  reg "pocket-ingest"       "every 15m"
  reg "field-capture-drain" "every 5m"
  reg "commit-sync-notion"  "every 15m"
  reg "health-check"        "every 30m"
  reg "morning-brief"       "$BRIEF_CRON"
  reg "schedule-scan"       "$SCAN_CRON"
fi

# ── 8. smoke-test (non-fatal) ─────────────────────────────────────────────────
log "Read-only smoke-test"
if [ "$DRY_RUN" -eq 1 ]; then
  printf '   %s[dry-run]%s %s smoke-test.js\n' "$c_yel" "$c_off" "$NODE_BIN"
else
  "$NODE_BIN" "$REPO_DIR/smoke-test.js" || warn "smoke-test reported failures — finish credential setup, then re-run smoke-test.js"
fi

log "Provisioning complete."
echo "Next steps:"
echo "  • If Jobber showed FAIL: run the OAuth flow to create jobber-tokens.json."
echo "  • If a daily cron time must track DST, re-run provision or edit it with: hermes cron edit"
echo "  • Verify crons: hermes cron list"
