# TODO — Agent Dashboard (Mission Control)

## ability to view the progress / status / output / token usage of sub agents and for maintaining the various scheduled jobs

## Sortie observability — PR preview control

GUI half of the "Preview branches" item (full details + NAS infra in the root [TODO.md](../../TODO.md) Sortie Integration section). In this page's Sortie observability area: a control to **build/launch a preview from a given PR #** (surfaces the LAN URL), plus a **"currently previewing" panel** showing which PR / branch / short-SHA occupies the single preview slot, when it launched, health, and an open link. Backend needs NAS-side Docker control — reuse whatever the Mission Control → `sortie:7678` access mechanism lands on.

## scheduled jobs:

- first one: a token audit

## Construction site (meta)

-- TODOs in the Personal Dashboard Repo that have not been implemented because they are awaiting the technology to exist / some api to be available - background job to check nightly if anythings changed. (if i get to a more autonomous multi-agent setup, create an inbox that queues messages from agents either because they need my input to continue working, when an important decision has been made or significant progress has been made, or when something needs my attention. (3 different notification types) Also create an inbox for this if one doesnt already exist.

## Automated Site Maintenance

- Weekly Privacy Checkup: A weekly automated job scan all my apps, dependencies, plugins, and chrome extensions on both pc, nas, and the ai server itself and the web to see if anything is a security risk
