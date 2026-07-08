#!/usr/bin/env sh
# pd-aliases.sh — canonical source of truth for Personal Dashboard shell commands.
# Compatible with bash and zsh.
#
# NAS setup: replace inline definitions in ~/.profile with:
#   source "$PD_REPO_ROOT/scripts/pd-aliases.sh"
# Mac setup: add to ~/.zshrc:
#   export PD_REPO_ROOT=/path/to/local/checkout
#   source "$PD_REPO_ROOT/scripts/pd-aliases.sh"

PD_REPO_ROOT="${PD_REPO_ROOT:-/volume1/docker/personal-dashboard/personal-dashboard}"
PD_COMPOSE="$PD_REPO_ROOT/ops/sortie/docker-compose.egress.yml"
PD_GH_REPO="${PD_GH_REPO:-scolacur/personal-dashboard}"

sortie-uptime() {
  sudo docker ps --format '{{.Names}}: {{.Status}}' | grep -E 'sortie'
}

sortie-healthcheck() {
  sudo docker exec sortie curl -s http://localhost:7678/readyz
}

sortie-logs() {
  # Tail live sortie container logs. Optional $1 = lines of history to show first (default 200).
  sudo docker logs -f --tail "${1:-200}" sortie
}

sortie-refresh() {
  git -C "$PD_REPO_ROOT" pull \
    && sudo docker-compose -f "$PD_COMPOSE" up -d --force-recreate
}

sortie-refresh-proxy() {
  git -C "$PD_REPO_ROOT" pull \
    && sudo docker-compose -f "$PD_COMPOSE" up -d --force-recreate egress-proxy
}

sortie-refresh-no-proxy() {
  git -C "$PD_REPO_ROOT" pull \
    && sudo docker-compose -f "$PD_COMPOSE" up -d --force-recreate sortie
}

sortie-sessions() {
  # Read-only: report how many sessions issue $1 has consumed vs the max_sessions cap.
  git -C "$PD_REPO_ROOT" pull \
    && "$PD_REPO_ROOT/ops/sortie/count-sessions.sh" "$1"
}

sortie-reset() {
  git -C "$PD_REPO_ROOT" pull \
    && "$PD_REPO_ROOT/ops/sortie/reset-sessions.sh" "$1"
}

sortie-watchdog() {
  # Manually dispatch the stuck-issue watchdog GitHub Action (runs the version on main).
  # Pass "dry" for a report-only run that makes no label/comment changes: sortie-watchdog dry
  if [ "$1" = "dry" ]; then
    gh workflow run sortie-watchdog.yml -R "$PD_GH_REPO" -f dry_run=true
  else
    gh workflow run sortie-watchdog.yml -R "$PD_GH_REPO"
  fi
}

pd-help() {
  printf '%-28s %-40s %s\n' 'COMMAND' 'DESCRIPTION' 'EXPANSION HINT'
  printf '%-28s %-40s %s\n' '-------' '-----------' '--------------'
  printf '%-28s %-40s %s\n' 'sortie-uptime'         'Show sortie container uptime/status'    'docker ps | grep sortie'
  printf '%-28s %-40s %s\n' 'sortie-healthcheck'    'Hit /readyz inside the sortie container' 'docker exec sortie curl …/readyz'
  printf '%-28s %-40s %s\n' 'sortie-logs [lines]'   'Tail live sortie container logs'        'docker logs -f --tail 200 sortie'
  printf '%-28s %-40s %s\n' 'sortie-refresh'        'git pull + recreate both containers'    'docker-compose up -d --force-recreate'
  printf '%-28s %-40s %s\n' 'sortie-refresh-proxy'  'git pull + recreate egress-proxy only'  'docker-compose up -d … egress-proxy'
  printf '%-28s %-40s %s\n' 'sortie-refresh-no-proxy' 'git pull + recreate sortie only'      'docker-compose up -d … sortie'
  printf '%-28s %-40s %s\n' 'sortie-sessions <issue>' 'Count sessions an issue has consumed (read-only)' 'ops/sortie/count-sessions.sh $1'
  printf '%-28s %-40s %s\n' 'sortie-reset <issue>'  'git pull + run reset-sessions.sh'       'ops/sortie/reset-sessions.sh $1'
  printf '%-28s %-40s %s\n' 'sortie-watchdog [dry]' 'Dispatch the stuck-issue watchdog Action' 'gh workflow run sortie-watchdog.yml'
  printf '\n'
  printf 'Source: %s\n' "$PD_REPO_ROOT/scripts/pd-aliases.sh"
}
