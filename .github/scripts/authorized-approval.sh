#!/usr/bin/env bash
# Does a PR carry a standing APPROVED review from an authorized human? Prints "true" or "false".
#
# Reads `gh pr view --json reviews` JSON on stdin. Shared by `robot-auto-merge.yml` (merge bridge)
# and `review-gate.yml` (PD-764) so the two cannot disagree about who may approve:
#   - the repo OWNER (scolacur), or
#   - a COLLABORATOR whose review carries the `<!-- robot:human-reply -->` marker (HUMAN_REPLY_MARKER
#     in @dashboard/shared; the board's reply mirror stamps it).
# The bot account's own reviews never count. Only each reviewer's LATEST review counts, so a later
# CHANGES_REQUESTED from the same person supersedes an earlier APPROVED.
set -euo pipefail

BOT_LOGIN="${BOT_LOGIN:-sortie-bot-55}"

jq -r --arg bot "$BOT_LOGIN" '
  .reviews
  | map(select(.author != null))
  | group_by(.author.login)
  | map(sort_by(.submittedAt) | last)
  | map(select(
      .state == "APPROVED" and
      .author.login != $bot and
      (
        .authorAssociation == "OWNER" or
        (
          .authorAssociation == "COLLABORATOR" and
          ((.body // "") | contains("<!-- robot:human-reply -->"))
        )
      )
    ))
  | length > 0
'
