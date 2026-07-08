#!/usr/bin/env bash
#
# reset-sessions.sh — clear ONE issue's Sortie run-history so it can be re-dispatched
# past the per-issue `max_sessions` cap (WORKFLOW.md agent.max_sessions).
#
# Surgical: touches ONLY the given issue's rows in `run_history` + `session_metadata`
# (both keyed by issue_id). Every other issue's history, the reactions state, and the
# workspaces are untouched. Interactive — confirms the delete (the inspected rows above
# are the confirmation) and confirms the restart, and never writes until the container is
# stopped + the DB backed up.
#
# Runs on the NAS (where .sortie.db and the `sortie` container live). Uses a throwaway
# official `alpine` + `apk add sqlite` container (no sqlite3 on the DSM host; official
# image per the data/infra image-safety rule) rather than an unvetted third-party image.
#
# Usage:  sudo ./reset-sessions.sh <issue-id>
#   e.g.  sudo ./reset-sessions.sh 34
#
# NOTE: unlike quota-refund.sh (which refunds ONLY provably quota-lost sessions), this
# resets ALL of an issue's sessions unconditionally — use it deliberately, on an issue you
# know is safe to re-run.

set -euo pipefail

# ── config ─────────────────────────────────────────────────────────────────────
DOCKER="sudo docker"
CONTAINER="sortie"
DATA_DIR="/volume1/docker/personal-dashboard/data"   # holds .sortie.db on the NAS
DB_HOST="$DATA_DIR/.sortie.db"                         # host path (for the existence check)
DB="/data/.sortie.db"                                 # path INSIDE the alpine helper
SQLITE_IMG="alpine"

# ── args ───────────────────────────────────────────────────────────────────────
ISSUE="${1:-}"
if [[ -z "$ISSUE" ]]; then
  echo "usage: $0 <issue-id>" >&2
  exit 2
fi
if [[ ! "$ISSUE" =~ ^[0-9]+$ ]]; then
  echo "error: issue id must be numeric (got: '$ISSUE')" >&2
  exit 2
fi
if [[ ! -f "$DB_HOST" ]]; then
  echo "error: DB not found at $DB_HOST — check DATA_DIR." >&2
  exit 1
fi

STOPPED=0
on_err() {
  echo >&2
  echo "!! aborted on error." >&2
  [[ "$STOPPED" == "1" ]] && echo "!! $CONTAINER is STOPPED — restart it with:  $DOCKER start $CONTAINER" >&2
  echo "!! a backup (if taken) is in $DATA_DIR (.sortie.db.bak-*)." >&2
}
trap on_err ERR

confirm() {  # confirm "prompt"  → 0 on yes, 1 otherwise
  local reply
  read -r -p "$1 [y/N] " reply
  [[ "$reply" == "y" || "$reply" == "Y" ]]
}

# run one sqlite invocation in a throwaway alpine (installs sqlite each call — a few
# seconds; fine for an interactive tool). $1 = SQL or dot-command(s).
sq() {
  $DOCKER run --rm -v "$DATA_DIR:/data" "$SQLITE_IMG" \
    sh -c "apk add --no-cache -q sqlite && sqlite3 \"$DB\" \"$1\""
}

echo "== Sortie session reset — issue #$ISSUE =="
echo

# ── 1. inspect (read-only; container may stay running for this) ──────────────────
echo "Tables in .sortie.db:"
sq ".tables"
echo
echo "run_history rows for #$ISSUE:"
sq "SELECT rowid, status, total_tokens FROM run_history WHERE issue_id='$ISSUE';"
echo
echo "session_metadata rows for #$ISSUE:"
sq "SELECT * FROM session_metadata WHERE issue_id='$ISSUE';"
echo

# ── 2. confirm delete (single gate — the rows above are the confirmation) ────────
if ! confirm "Delete the run_history + session_metadata rows shown above for GitHub Issue #$ISSUE?"; then
  echo "Aborted. Nothing changed."
  exit 0
fi

# ── 3. stop → backup → delete → verify ───────────────────────────────────────────
echo "Stopping $CONTAINER (so the DB is quiescent during the edit)..."
$DOCKER stop "$CONTAINER"
STOPPED=1

BAK="/data/.sortie.db.bak-$(date +%Y%m%d-%H%M%S)"
echo "Backing up -> ${BAK/\/data/$DATA_DIR} (consistent snapshot)"
sq ".backup '$BAK'"

echo "Deleting #$ISSUE rows..."
sq "BEGIN; DELETE FROM run_history WHERE issue_id='$ISSUE'; DELETE FROM session_metadata WHERE issue_id='$ISSUE'; COMMIT;"

REMAIN="$(sq "SELECT count(*) FROM run_history WHERE issue_id='$ISSUE';" | tr -d '[:space:]')"
echo "Remaining run_history rows for #$ISSUE: ${REMAIN}"
if [[ "$REMAIN" != "0" ]]; then
  echo "WARNING: expected 0 — inspect manually. Backup: ${BAK/\/data/$DATA_DIR}" >&2
fi

# ── 4. confirm restart ───────────────────────────────────────────────────────────
echo
if confirm "Restart $CONTAINER now?"; then
  $DOCKER start "$CONTAINER"
  STOPPED=0
  echo "$CONTAINER started — it will re-dispatch #$ISSUE with a fresh session budget."
else
  echo "Left $CONTAINER STOPPED. Start it later with:  $DOCKER start $CONTAINER"
fi

trap - ERR
echo "Done. Backup: ${BAK/\/data/$DATA_DIR}"
