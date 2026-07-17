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
PD_GH_REPO="${PD_GH_REPO:-scolacur/personal-dashboard}"

# NOTE: the legacy `sortie-*` container helpers were removed — the third-party Sortie
# runtime (its container, ops/sortie/ scripts, and the sortie-watchdog Action) has been
# retired. Robot-loop operator helpers are tracked separately under PD-391.

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
  printf 'Source: %s\n' "$PD_REPO_ROOT/scripts/pd-aliases.sh"
}
