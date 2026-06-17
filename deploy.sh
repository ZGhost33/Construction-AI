#!/usr/bin/env bash
#
# deploy.sh — push CODE (and optional Hermes skills) from this working copy to
# one or more live deployments listed in a registry. This is the SHARED-CODEBASE
# update path: a fix written once is rolled out to every business.
#
# Safety:
#   • Local preflight: `node -c` every JS file (and `bash -n` every .sh) BEFORE
#     touching any target. One syntax error aborts the whole deploy.
#   • rsync ships code + templates only. config.json, credentials, and ALL
#     state files are excluded — a deployment's live config/state is never
#     overwritten. No --delete, so remote-only files are left alone.
#   • After each target: remote validate-config.js + read-only smoke-test.js,
#     with a per-target PASS/FAIL line.
#
# Registry: deployments.json (gitignored). Template: deployments.example.json.
#
# Usage:
#   ./deploy.sh [target-name|all] [options]
#
# Options:
#   --registry FILE   registry path        (default: ./deployments.json)
#   --skills          also rsync skills_src -> skills_dir (if set per target)
#   --no-smoke        skip the post-deploy smoke-test (still runs validate)
#   --dry-run         print every action + rsync --dry-run; change nothing
#   -h, --help        this help
#
set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_ARG="all"
REGISTRY="$SELF_DIR/deployments.json"
DO_SKILLS=0
NO_SMOKE=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --registry) REGISTRY="$2"; shift 2 ;;
    --skills)   DO_SKILLS=1; shift ;;
    --no-smoke) NO_SMOKE=1; shift ;;
    --dry-run)  DRY_RUN=1; shift ;;
    -h|--help)  sed -n '2,33p' "$0"; exit 0 ;;
    --*) echo "unknown option: $1" >&2; exit 2 ;;
    *) TARGET_ARG="$1"; shift ;;
  esac
done

c_blue=$'\033[34m'; c_red=$'\033[31m'; c_grn=$'\033[32m'; c_yel=$'\033[33m'; c_off=$'\033[0m'
log()  { printf '%s==>%s %s\n' "$c_blue" "$c_off" "$*"; }
ok()   { printf '%s ok %s %s\n' "$c_grn" "$c_off" "$*"; }
warn() { printf '%s warn%s %s\n' "$c_yel" "$c_off" "$*"; }
die()  { printf '%s err %s %s\n' "$c_red" "$c_off" "$*" >&2; exit 1; }

[ -f "$REGISTRY" ] || die "registry not found: $REGISTRY (copy deployments.example.json -> deployments.json)"
command -v rsync >/dev/null 2>&1 || die "rsync not found"
NODE_LOCAL="$(command -v node || echo "/root/.hermes/node/bin/node")"

# ── 1. local preflight (syntax gate) ──────────────────────────────────────────
log "Preflight: syntax-checking JS + shell"
JS_FILES="$(find "$SELF_DIR" -name node_modules -prune -o -name '*.js' -print)"
fail=0
for f in $JS_FILES; do
  "$NODE_LOCAL" -c "$f" 2>/tmp/deploy_synerr || { warn "syntax: $f"; sed 's/^/      /' /tmp/deploy_synerr; fail=1; }
done
for f in "$SELF_DIR"/*.sh; do
  [ -f "$f" ] || continue
  bash -n "$f" 2>/tmp/deploy_synerr || { warn "syntax: $f"; sed 's/^/      /' /tmp/deploy_synerr; fail=1; }
done
rm -f /tmp/deploy_synerr
[ "$fail" -eq 0 ] || die "preflight failed — fix syntax errors before deploying."
ok "preflight passed"

# ── files NEVER shipped (secrets + state + local-only) ────────────────────────
# Mirrors .gitignore plus deploy-local artifacts.
RSYNC_EXCLUDES=(
  --exclude '.git'
  --exclude 'node_modules'
  --exclude '*.log'
  --exclude 'config.json'
  --exclude 'config.json.bak-*'
  --exclude '*.bak-*'
  --exclude 'jobber-tokens.json'
  --exclude 'drive-service-account.json'
  --exclude 'processed_recordings.json'
  --exclude 'ingest-attempts.json'
  --exclude 'location-cache.json'
  --exclude 'client-scopes.json'
  --exclude 'converted-quotes.json'
  --exclude 'job-plans.json'
  --exclude 'commitments.json'
  --exclude 'cruz-calendar.json'
  --exclude 'review-queue.json'
  --exclude 'voice-profiles.json'
  --exclude 'expenses.json'
  --exclude 'receipts.json'
  --exclude 'recall-index.json'
  --exclude 'capture-queue.json'
  --exclude 'capture-inbox'
  --exclude 'ui-metrics.json'
  --exclude 'leaderboard-archive.json'
  --exclude 'contacts.json'
  --exclude 'new-client-drafts.json'
  --exclude 'job-context.json'
  --exclude 'job-context.json.lock'
  --exclude 'job-context.json.tmp-*'
  --exclude 'inference-log.json'
  --exclude 'inference-log.json.lock'
  --exclude 'inference-log.json.tmp-*'
  --exclude 'deployments.json'
  --exclude 'PIPELINE_CONTEXT.md'
)

# ── 2. parse registry -> tuples ───────────────────────────────────────────────
# Emit: name<TAB>host<TAB>repo_dir<TAB>node_bin<TAB>skills_src<TAB>skills_dir
TUPLES="$("$NODE_LOCAL" -e '
  const fs=require("fs");
  const reg=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const want=process.argv[2];
  for (const t of (reg.targets||[])) {
    if (t.enabled===false) continue;
    if (want!=="all" && t.name!==want) continue;
    process.stdout.write([t.name,t.host,t.repo_dir,t.node_bin||"/root/.hermes/node/bin/node",t.skills_src||"",t.skills_dir||""].join("\t")+"\n");
  }
' "$REGISTRY" "$TARGET_ARG")"
[ -n "$TUPLES" ] || die "no enabled target matched '$TARGET_ARG' in $REGISTRY"

# ── 3. deploy each target ─────────────────────────────────────────────────────
declare -a REPORT
RSYNC_FLAGS=(-az --human-readable)
[ "$DRY_RUN" -eq 1 ] && RSYNC_FLAGS+=(--dry-run)

while IFS=$'\t' read -r NAME HOST REPO_DIR NODE_BIN SKILLS_SRC SKILLS_DIR; do
  [ -n "$NAME" ] || continue
  log "Deploying to '$NAME' ($HOST:$REPO_DIR)"

  # 3a. code
  log "  rsync code -> $HOST:$REPO_DIR"
  rsync "${RSYNC_FLAGS[@]}" "${RSYNC_EXCLUDES[@]}" "$SELF_DIR"/ "$HOST:$REPO_DIR"/ \
    || { warn "rsync failed for $NAME"; REPORT+=("$NAME  CODE-FAIL"); continue; }
  ok "  code synced"

  # 3b. skills (optional)
  if [ "$DO_SKILLS" -eq 1 ] && [ -n "$SKILLS_SRC" ]; then
    if [ -d "$SELF_DIR/$SKILLS_SRC" ] || [ -d "$SKILLS_SRC" ]; then
      local_skills="$SKILLS_SRC"; [ -d "$SELF_DIR/$SKILLS_SRC" ] && local_skills="$SELF_DIR/$SKILLS_SRC"
      log "  rsync skills -> $HOST:$SKILLS_DIR"
      rsync "${RSYNC_FLAGS[@]}" "$local_skills"/ "$HOST:$SKILLS_DIR"/ \
        && ok "  skills synced" || warn "  skills rsync failed"
    else
      warn "  skills_src '$SKILLS_SRC' not found locally — skipping skills"
    fi
  fi

  # 3c. remote validate
  log "  remote validate-config"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '   %s[dry-run]%s ssh %s %s validate-config.js\n' "$c_yel" "$c_off" "$HOST" "$NODE_BIN"
    vres=0
  else
    # `&& vres=0 || vres=$?` keeps a non-zero exit from tripping `set -e`
    # before the per-target report is printed.
    ssh "$HOST" "$NODE_BIN $REPO_DIR/validate-config.js" >/tmp/deploy_val 2>&1 && vres=0 || vres=$?
    tail -n 4 /tmp/deploy_val | sed 's/^/      /'
  fi

  # 3d. remote smoke-test
  sres=0
  if [ "$NO_SMOKE" -eq 0 ]; then
    log "  remote smoke-test (read-only)"
    if [ "$DRY_RUN" -eq 1 ]; then
      printf '   %s[dry-run]%s ssh %s %s smoke-test.js\n' "$c_yel" "$c_off" "$HOST" "$NODE_BIN"
    else
      ssh "$HOST" "$NODE_BIN $REPO_DIR/smoke-test.js" >/tmp/deploy_smoke 2>&1 && sres=0 || sres=$?
      grep -E '✓|✖|·|RESULT' /tmp/deploy_smoke | sed 's/^/      /' || true
    fi
  fi

  if [ "$vres" -ne 0 ]; then REPORT+=("$NAME  VALIDATE-FAIL")
  elif [ "$sres" -ne 0 ]; then REPORT+=("$NAME  OK(code) · SMOKE-WARN")
  else REPORT+=("$NAME  OK"); fi
done <<< "$TUPLES"
rm -f /tmp/deploy_val /tmp/deploy_smoke

# ── 4. per-target report ──────────────────────────────────────────────────────
echo
log "Deploy report$([ $DRY_RUN -eq 1 ] && echo '  [DRY-RUN]')"
overall=0
for line in "${REPORT[@]}"; do
  case "$line" in
    *FAIL*) printf '  %s✖%s %s\n' "$c_red" "$c_off" "$line"; overall=1 ;;
    *WARN*) printf '  %s⚠%s %s\n' "$c_yel" "$c_off" "$line" ;;
    *)      printf '  %s✓%s %s\n' "$c_grn" "$c_off" "$line" ;;
  esac
done
exit $overall
