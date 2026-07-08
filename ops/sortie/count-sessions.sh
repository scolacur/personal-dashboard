#!/usr/bin/env bash
#
# count-sessions.sh — report how many Sortie sessions ONE issue has consumed against
# the per-issue `max_sessions` cap (WORKFLOW.md agent.max_sessions).
#
# READ-ONLY sibling of reset-sessions.sh: opens .sortie.db with -readonly and never
# stops the container, writes, or prompts. Counts `run_history` rows per issue_id —
# the exact accounting Sortie uses to enforce max_sessions (a quota-lost run still
# writes a row and counts here; see quota-refund.sh).
#
# Runs on the NAS (where .sortie.db and the `sortie` container live). Uses a throwaway
# official `alpine` + `apk add sqlite` container (no sqlite3 on the DSM host).
#
# Usage:  sudo ./count-sessions.sh <issue-id>
#   e.g.  sudo ./count-sessions.sh 34

set -euo pipefail

# ── config (mirrors reset-sessions.sh) ───────────────────────────────────────────
DOCKER="sudo docker"
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

# run one READ-ONLY sqlite query in a throwaway alpine. -readonly is safe against the
# live writer (WAL allows concurrent readers), so the container stays up. $1 = SQL.
sq() {
  $DOCKER run --rm -v "$DATA_DIR:/data" "$SQLITE_IMG" \
    sh -c "apk add --no-cache -q sqlite && sqlite3 -readonly \"$DB\" \"$1\""
}

echo "== Sortie session count — issue #$ISSUE =="
echo

TOTAL="$(sq "SELECT count(*) FROM run_history WHERE issue_id='$ISSUE';" | tr -d '[:space:]')"
echo "Sessions consumed (run_history rows): ${TOTAL}"
echo
echo "Breakdown by status:"
sq "SELECT status, count(*) AS n FROM run_history WHERE issue_id='$ISSUE' GROUP BY status ORDER BY n DESC;"
echo
echo "The max_sessions cap is set in ops/sortie/WORKFLOW.md (agent.max_sessions)."
echo "Once consumed >= cap, Sortie stops dispatching this issue; clear it with reset-sessions.sh."
