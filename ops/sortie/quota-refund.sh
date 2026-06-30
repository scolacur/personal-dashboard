#!/usr/bin/env bash
#
# quota-refund.sh — refund max_sessions budget lost to Anthropic usage/session-quota
# exhaustion, and ONLY that.
#
# WHY THIS EXISTS
# ---------------
# Sortie enforces `agent.max_sessions` by counting rows in `run_history` per issue in
# .sortie.db. A run that fails *solely* because the Anthropic Pro session quota was
# exhausted still writes a run_history row (status='failed', error contains
# 'turn_failed: success', total_tokens=0). Three such instant-fails in ~2 minutes
# permanently cap an issue at max_sessions, and when the quota window resets the issue
# stays capped forever. Sortie has no native knob to detect a usage-limit failure or
# exempt it from the session count (confirmed against docs.sortie-ai.com — see README),
# and its HTTP API exposes no write/reset endpoint (only POST /api/v1/refresh = poll).
# The only supported reset is editing the DB directly, exactly as the proven manual fix
# does. This script automates the SAFE equivalent of that manual fix.
#
# WHAT IT DOES (and does NOT do)
# ------------------------------
#   1. LIVENESS GATE (anti-re-storm): probes the coding agent with a trivial prompt
#      using the SAME credentials Sortie uses. If the quota is STILL exhausted, it does
#      nothing and exits. Budget is refunded ONLY after the window has actually reset,
#      so a refund can never feed 3 fresh instant-fails (a slow storm).
#   2. CLASSIFY: selects issues whose run_history is composed *entirely* of quota-fails
#      (>=1 quota-fail row AND 0 non-quota rows). An issue with ANY other failure class
#      (e.g. #8's after_create git-clone exit-128) has non-quota rows and is NOT touched.
#   3. REFUND: stops the container (quiesce the SQLite writer), backs up the DB, deletes
#      ONLY those issues' run_history + session_metadata rows in a single transaction,
#      restarts the container. Mirrors the manual procedure documented in the README.
#
# It is idempotent and safe to run repeatedly: if nothing is quota-capped, or the quota
# is still out, it makes no changes. Designed for hourly host cron on the Synology NAS.
#
# DEPLOY: see ops/sortie/README.md "Quota-fail budget refund (janitor)".
#
# CONSTRAINTS HONORED
#   * Backs up the DB before any write.
#   * Never writes while Sortie holds the write lock (container is stopped first).
#   * Refunds ONLY provably-quota-lost sessions; leaves real failures capped.
#   * No invented Sortie schema/fields — only the columns confirmed in the task context
#     and the observed quota signature; the reset-timestamp parse is deliberately NOT
#     relied upon (see README "Why a liveness probe, not reset-time parsing").

set -euo pipefail

# ─── Config (override via env in the cron line if your layout differs) ──────────────
BASE_DIR="${SORTIE_BASE_DIR:-/volume1/docker/personal-dashboard}"
DB_PATH="${SORTIE_DB_PATH:-$BASE_DIR/data/.sortie.db}"
CONTAINER="${SORTIE_CONTAINER:-sortie}"
BACKUP_DIR="${SORTIE_BACKUP_DIR:-$BASE_DIR/backups}"
BACKUP_RETAIN_DAYS="${SORTIE_BACKUP_RETAIN_DAYS:-14}"   # prune this script's own backups older than N days
COMPOSE_FILE="${SORTIE_COMPOSE_FILE:-$BASE_DIR/personal-dashboard/ops/sortie/docker-compose.egress.yml}"
SQLITE="${SQLITE_BIN:-/bin/sqlite3}"
DOCKER="${DOCKER_BIN:-docker}"
LOCKFILE="${SORTIE_LOCKFILE:-/tmp/sortie-quota-refund.lock}"

# The quota-fail signature. A run row is a quota-fail iff ALL of these hold.
# Keep in sync with README "failure-classification rule". Refine ERROR_LIKE only if a
# deploy-time inspection of run_history.error gives a tighter, still-safe match.
QUOTA_STATUS="failed"
QUOTA_ERROR_LIKE='%turn_failed: success%'
QUOTA_TOKENS=0

# Liveness probe: how we ask "has the quota window reset?" without burning a real
# session. We run a one-word prompt through Claude Code inside the container. A healthy
# token answers; an exhausted one prints the usage-limit error and is detected below.
PROBE_TIMEOUT_S="${SORTIE_PROBE_TIMEOUT_S:-60}"

log() { printf '%s quota-refund: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

# ─── Unified cleanup (single EXIT trap) ─────────────────────────────────────────────
# One trap handles BOTH releasing the mkdir-lock (if used) and restarting the container
# (if we stopped it). Guarded by flags so each action only runs when relevant. Defining
# it before the lock means the lock fallback can register cleanup without a second trap.
LOCKDIR=""
CONTAINER_STOPPED=0
cleanup() {
  if [ "$CONTAINER_STOPPED" -eq 1 ]; then
    log "restarting container '$CONTAINER'"
    if ! "$DOCKER" start "$CONTAINER" >/dev/null 2>&1; then
      log "bare 'docker start' failed; trying compose up -d"
      "$DOCKER" compose -f "$COMPOSE_FILE" up -d >/dev/null 2>&1 \
        || command docker-compose -f "$COMPOSE_FILE" up -d >/dev/null 2>&1 \
        || log "WARN: could not restart container automatically; START IT MANUALLY"
    fi
  fi
  [ -n "$LOCKDIR" ] && rmdir "$LOCKDIR" 2>/dev/null || true
}
trap cleanup EXIT

# ─── Single-instance guard (no overlapping runs) ────────────────────────────────────
# flock is the clean path; if it is absent (some DSM busybox shells lack it), fall back
# to a best-effort mkdir lock released by cleanup(). Either way, two concurrent runs
# cannot both proceed.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCKFILE" || die "cannot open lockfile $LOCKFILE"
  if ! flock -n 9; then
    log "another quota-refund run holds the lock; exiting"
    exit 0
  fi
else
  LOCKDIR="${LOCKFILE}.d"
  if ! mkdir "$LOCKDIR" 2>/dev/null; then
    LOCKDIR=""   # not ours — don't let cleanup remove someone else's lock
    log "another quota-refund run holds the lock; exiting"
    exit 0
  fi
fi

# ─── Preflight ──────────────────────────────────────────────────────────────────────
command -v "$DOCKER" >/dev/null 2>&1 || die "docker not found ($DOCKER)"
[ -x "$SQLITE" ] || command -v "$SQLITE" >/dev/null 2>&1 || die "sqlite3 not found ($SQLITE)"
[ -f "$DB_PATH" ] || die "DB not found at $DB_PATH"

# ─── Step 0: anything to do? (read-only; safe while Sortie runs) ────────────────────
# An issue is refund-eligible iff it has >=1 quota-fail row AND 0 rows that are NOT a
# quota-fail. SUM(NOT quota)=0 means every row is a quota-fail. SUM(quota)>0 means at
# least one. This is what leaves #8 capped: #8's rows fail with a git-clone error, not
# the quota signature, so SUM(NOT quota) > 0 for #8 and it is excluded.
ELIGIBLE_SQL="
SELECT issue_id FROM run_history
GROUP BY issue_id
HAVING SUM(
         CASE WHEN status = '${QUOTA_STATUS}'
               AND error LIKE '${QUOTA_ERROR_LIKE}'
               AND total_tokens = ${QUOTA_TOKENS}
              THEN 1 ELSE 0 END
       ) > 0
   AND SUM(
         CASE WHEN status = '${QUOTA_STATUS}'
               AND error LIKE '${QUOTA_ERROR_LIKE}'
               AND total_tokens = ${QUOTA_TOKENS}
              THEN 0 ELSE 1 END
       ) = 0;
"

# Run the eligibility query into a newline-delimited string (portable; no bash-4 mapfile,
# which DSM's older bash may lack). issue_ids are simple tokens, safe on one line each.
query_eligible() {
  "$SQLITE" "$DB_PATH" "$ELIGIBLE_SQL" 2>/dev/null || true
}

ELIGIBLE="$(query_eligible)"
if [ -z "$ELIGIBLE" ]; then
  log "no all-quota-fail issues found; nothing to refund"
  exit 0
fi
log "candidate quota-capped issues: $(printf '%s' "$ELIGIBLE" | tr '\n' ' ')"

# ─── Step 1: liveness gate — refuse to refund while the quota is still exhausted ────
# Probe the agent the same way Sortie does (Claude Code CLI inside the running
# container, inheriting the container's CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY).
# If the container is stopped we cannot probe -> treat as "still out" and do nothing,
# rather than refund blindly.
if ! "$DOCKER" inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
  log "container '$CONTAINER' not running; cannot probe liveness; exiting without changes"
  exit 0
fi

PROBE_OUT="$(
  "$DOCKER" exec "$CONTAINER" sh -lc \
    "timeout ${PROBE_TIMEOUT_S} claude -p 'Reply with the single word: ok' 2>&1" \
  || true
)"

# Detect the usage/session-limit signature in either known Claude Code form:
#   "Claude AI usage limit reached|<unix_ts>"  or  "...hit your limit · resets <time>"
if printf '%s' "$PROBE_OUT" | grep -Eiq 'usage limit reached|hit your (session )?limit|resets [0-9]'; then
  log "liveness probe: quota STILL exhausted (probe said: $(printf '%s' "$PROBE_OUT" | tr '\n' ' ' | cut -c1-160)); refusing to refund"
  exit 0
fi

# A probe that neither succeeded cleanly nor showed the limit signature is ambiguous
# (network/proxy hiccup, agent error). Be conservative: do not refund on ambiguity.
if ! printf '%s' "$PROBE_OUT" | grep -Eiq '\bok\b'; then
  log "liveness probe inconclusive (no 'ok', no limit signature); refusing to refund. probe said: $(printf '%s' "$PROBE_OUT" | tr '\n' ' ' | cut -c1-160)"
  exit 0
fi

log "liveness probe: quota window has reset (agent responded); proceeding to refund"

# ─── Step 2: quiesce the writer ─────────────────────────────────────────────────────
# Stop the container so no Sortie writer holds the SQLite lock during our DELETE. The
# cleanup() EXIT trap (set above) brings it back even if a later step fails.
log "stopping container '$CONTAINER' to quiesce the DB writer"
"$DOCKER" stop "$CONTAINER" >/dev/null
CONTAINER_STOPPED=1

# ─── Step 3: back up the DB before any write ────────────────────────────────────────
mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="$BACKUP_DIR/.sortie.db.$STAMP.quota-refund.bak"
# `.backup` is consistent even if a stray reader exists; container is already stopped.
"$SQLITE" "$DB_PATH" ".backup '$BACKUP'" || die "backup failed; aborting before any write"
log "backed up DB -> $BACKUP"
# Prune this script's own backups so backups/ can't grow unbounded. Scoped to the
# *.quota-refund.bak suffix so it never touches manual-reset backups (.sortie.db.bak.*).
find "$BACKUP_DIR" -maxdepth 1 -name '*.quota-refund.bak' -mtime "+${BACKUP_RETAIN_DAYS}" -delete 2>/dev/null || true

# ─── Step 4: refund (single transaction, only the eligible issues) ──────────────────
# Re-read eligibility from the now-quiesced DB so we act on a consistent snapshot.
ELIGIBLE="$(query_eligible)"
if [ -z "$ELIGIBLE" ]; then
  log "no eligible issues on re-read; nothing to delete"
  exit 0
fi

# Build a quoted IN-list of issue_ids (SQL-escaping single quotes). issue_ids come
# straight out of the DB; one per line.
IN_LIST=""
COUNT=0
while IFS= read -r id; do
  [ -n "$id" ] || continue
  esc="$(printf '%s' "$id" | sed "s/'/''/g")"
  IN_LIST="${IN_LIST:+$IN_LIST,}'$esc'"
  COUNT=$((COUNT + 1))
done <<EOF
$ELIGIBLE
EOF

REFUND_SQL="
BEGIN IMMEDIATE;
DELETE FROM run_history      WHERE issue_id IN ($IN_LIST);
DELETE FROM session_metadata WHERE issue_id IN ($IN_LIST);
COMMIT;
"
log "refunding budget for issues: $(printf '%s' "$ELIGIBLE" | tr '\n' ' ')"
"$SQLITE" "$DB_PATH" "$REFUND_SQL" || die "DELETE failed; DB unchanged-or-rolled-back, backup at $BACKUP"

log "refund complete for $COUNT issue(s); re-queue their labels to let Sortie pick them up"
# cleanup() EXIT trap restarts the container
exit 0
