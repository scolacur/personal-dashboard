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
# The worker's env file (secrets — outside the repo, never committed). Set PD_BOT_LOGIN to the bot
# account's GitHub login to make `robot-token` refuse any other account; unset, it asks instead.
PD_WORKER_ENV="${PD_WORKER_ENV:-/volume1/docker/personal-dashboard/agent-worker.env}"
PD_BOT_LOGIN="${PD_BOT_LOGIN:-}"

# ── Robot loop / agent-worker operator helpers (PD-391) ──────────────────────
#
# NOTE: the agent-worker is NOT on the Watchtower/GHCR auto-update path (only the web app is), so
# `robot-refresh` — build the image, recreate the container — IS the deploy.
#
# Liveness is a heartbeat row in the DB (the worker serves no HTTP), which `robot-status` reads.
# Stall detection is an in-process sweep in the loop, so there is nothing to run for it. Per-ticket
# remediation is the board's Reset / Unstick buttons (C4/PD-345) — deliberately not wrapped here:
# they carry a retry-budget boundary and are not a global lever.

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
    # PD-528: stamp the commit into the image so the dashboard reports the worker's REAL version,
    # not the grounding checkout's HEAD (which tracks main and looks fresh regardless).
    sudo docker build --build-arg "BUILD_SHA=$(git rev-parse --short HEAD)" \
      -f ops/agent-worker/Dockerfile -t "$PD_IMAGE" . || return 1
    sudo docker-compose -f "$PD_COMPOSE" up -d || return 1
    sudo docker ps --filter "name=$PD_WORKER" --format 'table {{.Names}}\t{{.Status}}'
  )
}

robot-token() {
  # Rotate the Robot's GitHub WRITE token (ROBOT_GITHUB_TOKEN) in the worker's env file, then
  # recreate the worker so it takes effect. An env change needs no image rebuild.
  #
  # The token is read at a hidden prompt, so it never reaches the screen, the shell history, or a
  # command line in `ps` (curl and the file rewrite both read it from stdin, never argv). It is checked against
  # GitHub BEFORE the file is touched: a wrong or under-scoped token is refused, and the old one
  # stays in place. Found necessary 2026-11-13, when the bot's token had expired and PD-714's run
  # could verify green but not push.
  local _tok _login _push _ok
  if [ ! -f "$PD_WORKER_ENV" ] && ! sudo test -f "$PD_WORKER_ENV"; then
    echo "robot-token: env file not found: $PD_WORKER_ENV" >&2; return 1
  fi
  # printf + read -rs rather than `read -p`: in zsh `-p` means a coprocess, not a prompt.
  printf 'New ROBOT_GITHUB_TOKEN (the bot account'"'"'s write token): '; read -rs _tok; echo
  if [ -z "$_tok" ]; then echo "robot-token: empty token — nothing changed" >&2; return 2; fi
  case "$_tok" in *[!A-Za-z0-9_]*) echo "robot-token: unexpected characters in token — nothing changed" >&2; return 2 ;; esac

  # 1. Who is it? Must be the bot, or the Robot would push as someone else.
  # The auth header goes in on stdin (`-H @-`), never as an argument, so it is not visible in `ps`.
  _login=$(printf 'Authorization: token %s\n' "$_tok" | curl -fsS -H @- https://api.github.com/user 2>/dev/null \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("login",""))' 2>/dev/null)
  if [ -z "$_login" ]; then
    echo "robot-token: GitHub rejected the token (bad or expired) — nothing changed" >&2; return 1
  fi
  if [ -n "$PD_BOT_LOGIN" ]; then
    if [ "$_login" != "$PD_BOT_LOGIN" ]; then
      echo "robot-token: token belongs to '$_login', not '$PD_BOT_LOGIN' — nothing changed" >&2; return 1
    fi
  else
    printf 'Token belongs to GitHub user %s. The Robot will push as them. Use it? [y/N] ' "$_login"
    read -r _ok
    case "$_ok" in y|Y|yes) ;; *) echo "robot-token: not confirmed — nothing changed" >&2; return 1 ;; esac
  fi
  # 2. Can it push to the repo? (`permissions.push` reflects both classic and fine-grained scopes.)
  _push=$(printf 'Authorization: token %s\n' "$_tok" | curl -fsS -H @- "https://api.github.com/repos/$PD_GH_REPO" 2>/dev/null \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("permissions",{}).get("push",False))' 2>/dev/null)
  if [ "$_push" != "True" ]; then
    echo "robot-token: $_login's token cannot push to $PD_GH_REPO (needs Contents + Pull requests: write, or public_repo) — nothing changed" >&2
    return 1
  fi

  # 3. Back up, then replace the line (or append it if missing). Python rather than `sed -i`, whose
  #    flags differ between GNU and BSD; the token goes in on stdin, and writing in place keeps the
  #    file's owner and mode (it is a secrets file).
  sudo cp -p "$PD_WORKER_ENV" "$PD_WORKER_ENV.bak.$(date +%Y%m%d-%H%M%S)" || return 1
  printf '%s\n' "$_tok" | sudo python3 -c '
import sys
path, tok = sys.argv[1], sys.stdin.readline().strip()
lines = open(path).read().splitlines()
hits = [i for i, l in enumerate(lines) if l.startswith("ROBOT_GITHUB_TOKEN=")]
for i in hits:
    lines[i] = "ROBOT_GITHUB_TOKEN=" + tok
if not hits:
    lines.append("ROBOT_GITHUB_TOKEN=" + tok)
with open(path, "w") as f:
    f.write("\n".join(lines) + "\n")
' "$PD_WORKER_ENV" || { unset _tok; return 1; }
  unset _tok
  echo "robot-token: verified as $_login with push on $PD_GH_REPO; $(sudo grep -c '^ROBOT_GITHUB_TOKEN=' "$PD_WORKER_ENV") line set (backup kept beside it)"

  # 4. Recreate the worker so it reads the new env. Forced, because an env_file edit alone does not
  #    always register as a config change to compose.
  ( cd "$PD_REPO_ROOT" || return 1
    sudo docker-compose -f "$PD_COMPOSE" up -d --force-recreate "$PD_WORKER" || return 1
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
  printf '%-28s %-40s %s\n' 'robot-token'             'Rotate the bot write token, recreate'    'verify on GitHub, edit env, up -d'
  printf '\n'
  printf 'Source: %s\n' "$PD_REPO_ROOT/scripts/pd-aliases.sh"
}
