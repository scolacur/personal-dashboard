#!/usr/bin/env bash
# pd-aliases.sh — canonical source of truth for Personal Dashboard shell commands.
#
# bash and zsh ONLY — NOT POSIX sh. Every helper here is hyphenated (`pd-runs`, `robot-logs`), and
# POSIX forbids a hyphen in a function name, so dash rejects this file with "Bad function name".
# (The shebang said `sh` until PD-391; it was decorative — the file is sourced, not executed — but
# it advertised a compatibility the file never had. On macOS `/bin/sh` is bash, so `sh -n` passes
# there and fails on a Debian/Ubuntu host, which is exactly how this stayed unnoticed.)
#
# NAS setup: replace inline definitions in ~/.profile with:
#   source "$PD_REPO_ROOT/scripts/pd-aliases.sh"
# Mac setup: add to ~/.zshrc:
#   export PD_REPO_ROOT=/path/to/local/checkout
#   source "$PD_REPO_ROOT/scripts/pd-aliases.sh"

PD_REPO_ROOT="${PD_REPO_ROOT:-/volume1/docker/personal-dashboard/personal-dashboard}"
PD_GH_REPO="${PD_GH_REPO:-scolacur/personal-dashboard}"
# The board API — the only source of real data (local :8080 serves dummy dev data).
PD_API="${PD_API:-http://192.168.68.50:8088/api/widgets/task-monitor}"
PD_WORKER="${PD_WORKER:-agent-worker}"
PD_COMPOSE="${PD_COMPOSE:-ops/agent-worker/docker-compose.egress.yml}"
PD_IMAGE="${PD_IMAGE:-agent-worker-dashboard}"

# ── Robot loop / agent-worker operator helpers (PD-391) ──────────────────────
#
# The legacy `sortie-*` helpers were removed with the third-party Sortie runtime. These are their
# new-world replacements, and three of the old ones deliberately have NO successor:
#
#   sortie-healthcheck (/readyz)  → `robot-status`. The agent-worker serves no HTTP at all; its
#                                   liveness is a heartbeat row in the DB, which system-status reads.
#   sortie-watchdog (GH Action)   → nothing to run. Stall detection is an in-process sweep in the
#                                   loop itself (C5/PD-346).
#   sortie-sessions / -reset      → the board's per-ticket Reset / Unstick buttons (C4/PD-345).
#                                   Deliberately not wrapped: they are per-ticket remediation with
#                                   a retry-budget boundary, not a global lever.
#
# NOTE: the agent-worker is NOT on the Watchtower/GHCR auto-update path (only the web app is), so
# `robot-refresh` — build the image, recreate the container — IS the deploy.

robot-uptime() {
  # Is the loop's container up? Shows the squid sidecar too, on purpose: when the proxy is down the
  # worker is up but every API call fails, and the symptom reads like a Claude outage.
  sudo docker ps -a --filter "name=$PD_WORKER" --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
}

robot-logs() {
  # Pretty-print the agent-worker's pino JSON logs.
  #   robot-logs                 last 200 lines
  #   robot-logs -f              follow
  #   robot-logs 429             only ticket 429
  #   robot-logs -f 429          follow, one ticket
  #   robot-logs --raw           original JSON (for jq, or when the formatter hides something)
  # `local` keeps these out of the interactive shell — this is sourced into a login session, and
  # leaking `_n`/`_ticket` into it is how a later command picks up a value nobody set.
  local _follow='' _ticket='' _raw='' _n=200
  while [ $# -gt 0 ]; do
    case "$1" in
      -f|--follow) _follow='-f' ;;
      --raw)       _raw='--raw' ;;
      -n)          if [ -z "${2:-}" ]; then echo "robot-logs: -n needs a line count" >&2; return 2; fi
                   _n="$2"; shift ;;
      -*)          echo "robot-logs: unknown flag $1" >&2; return 2 ;;
      *)           _ticket="$1" ;;
    esac
    shift
  done
  # 2>&1 because pino writes to stdout but the container's own startup errors go to stderr, and the
  # ones worth seeing are usually the latter.
  if [ -n "$_ticket" ]; then
    sudo docker logs $_follow --tail "$_n" "$PD_WORKER" 2>&1 \
      | python3 "$PD_REPO_ROOT/scripts/robot-logs-format.py" --ticket "$_ticket" $_raw
  else
    sudo docker logs $_follow --tail "$_n" "$PD_WORKER" 2>&1 \
      | python3 "$PD_REPO_ROOT/scripts/robot-logs-format.py" $_raw
  fi
}

robot-status() {
  # The loop's live state: armed/paused, any hold, budget, GitHub rate-limit headroom, and worker
  # liveness. Reads the same system-status the dashboard header does, so the two cannot disagree.
  curl -fsS "$PD_API/system-status" | python3 -m json.tool
}

robot-pause() {
  # Global dispatch killswitch (C4/PD-345). In-flight runs are NOT killed — this stops the next
  # dispatch. Same flag a system-wide fault sets, so `robot-resume` clears either.
  curl -fsS -X POST -H 'Content-Type: application/json' \
    -d "{\"reason\":\"${1:-paused from the shell}\"}" "$PD_API/robot/pause" | python3 -m json.tool
}

robot-resume() {
  # Re-arm dispatch, clearing a human pause OR a system-wide fault pause.
  curl -fsS -X POST "$PD_API/robot/resume" | python3 -m json.tool
}

robot-refresh() {
  # THE DEPLOY for the agent-worker: pull, rebuild the image, recreate the container.
  # Runs from the repo root because the Dockerfile's build context is the whole repo.
  ( cd "$PD_REPO_ROOT" || return 1
    git pull --ff-only || return 1
    sudo docker build -f ops/agent-worker/Dockerfile -t "$PD_IMAGE" . || return 1
    sudo docker-compose -f "$PD_COMPOSE" up -d || return 1
    sudo docker ps --filter "name=$PD_WORKER" --format 'table {{.Names}}\t{{.Status}}'
  )
}

pd-runs() {
  # List recent GitHub Actions runs (newest first). Works from any host with gh.
  #   pd-runs                     recent runs across all workflows
  #   pd-runs robot-auto-merge   recent runs for one workflow (name w/o .yml)
  #   pd-runs robot-auto-merge 30   ...with a custom limit (default 15)
  if [ -n "${1:-}" ]; then
    gh run list -R "$PD_GH_REPO" --workflow="$1.yml" --limit "${2:-15}"
  else
    gh run list -R "$PD_GH_REPO" --limit "${2:-15}"
  fi
}

pd-run-log() {
  # Print a run's full log; optional 2nd arg greps it (case-insensitive extended regex).
  #   pd-run-log <run-id>
  #   pd-run-log <run-id> 'Checking PR|mergeStateStatus|CLEAN|skip|merged'
  # Get the run-id from `pd-runs [workflow]`.
  if [ -z "${1:-}" ]; then echo "usage: pd-run-log <run-id> [grep-regex]" >&2; return 2; fi
  if [ -n "${2:-}" ]; then
    gh run view "$1" -R "$PD_GH_REPO" --log | grep -iE "$2"
  else
    gh run view "$1" -R "$PD_GH_REPO" --log
  fi
}

pd-help() {
  printf '%-28s %-40s %s\n' 'COMMAND' 'DESCRIPTION' 'EXPANSION HINT'
  printf '%-28s %-40s %s\n' '-------' '-----------' '--------------'
  printf '%-28s %-40s %s\n' 'pd-runs [workflow] [n]' 'List recent GitHub Actions runs'        'gh run list [--workflow=X.yml]'
  printf '%-28s %-40s %s\n' 'pd-run-log <id> [regex]' 'Print a run log (optionally grepped)'  'gh run view <id> --log | grep'
  printf '\n'
  printf '%-28s %-40s %s\n' 'ROBOT LOOP (agent-worker)' '' ''
  printf '%-28s %-40s %s\n' '-------------------------' '-----------' '--------------'
  printf '%-28s %-40s %s\n' 'robot-uptime'            'Container status (+ squid sidecar)'      'docker ps --filter name=agent-worker'
  printf '%-28s %-40s %s\n' 'robot-logs [-f] [ticket]' 'Pretty-print pino logs, filter by ticket' 'docker logs | robot-logs-format.py'
  printf '%-28s %-40s %s\n' 'robot-status'            'Armed/paused, holds, budget, API limits' 'GET /system-status'
  printf '%-28s %-40s %s\n' 'robot-pause [reason]'    'Stop the NEXT dispatch (not in-flight)'  'POST /robot/pause'
  printf '%-28s %-40s %s\n' 'robot-resume'            'Re-arm dispatch (clears fault pause too)' 'POST /robot/resume'
  printf '%-28s %-40s %s\n' 'robot-refresh'           'THE DEPLOY: pull, build image, recreate' 'git pull && docker build && up -d'
  printf '\n'
  printf 'Retired, with no command needed:\n'
  printf '  sortie-healthcheck  -> robot-status (the worker serves no HTTP; liveness is a heartbeat row)\n'
  printf '  sortie-watchdog     -> nothing: stall detection is an in-process sweep in the loop\n'
  printf '  sortie-sessions/-reset -> the board Reset / Unstick buttons (per-ticket, not a global lever)\n'
  printf '\n'
  printf 'Source: %s\n' "$PD_REPO_ROOT/scripts/pd-aliases.sh"
}
