# Deploy / CI-CD runbook — Personal Dashboard app

How code gets from a `main` merge onto the NAS, with no manual pull/rebuild.

**Status legend:** 🧑 = Steve (needs your hands / NAS / GitHub settings) · 🤖 = Tank can run it.

---

## The pipeline (what happens on a merge to `main`)

```
PR merged to main
  │
  ├─ ci.yml ............. runs `npm run verify` on the PR (build/typecheck/lint/test)   [cloud]
  │
  └─ deploy.yml ......... builds docker/Dockerfile, pushes ghcr.io/scolacur/            [cloud]
                          personal-dashboard:latest + :<sha>
                              │
                              ▼
        Watchtower on the NAS polls GHCR every 5 min, sees a new :latest digest,
        pulls it, and recreates the `app` container in place.                           [NAS]
```

The NAS **never builds** — it only pulls a prebuilt image. This keeps the heavy
multi-stage build off the weak Synology CPU (the boundless-resource risk in TODO.md).

---

## Why pull-based (not a self-hosted runner / push trigger)

The NAS is behind a home LAN/NAT with no public ingress, so cloud Actions can't reach
in to trigger a deploy. The options were: poll-and-build on the NAS (rebuilds on the
weak CPU — rejected), a self-hosted Actions runner (a self-hosted runner on a **public**
repo can run untrusted fork-PR code — security hazard, rejected), or **registry +
Watchtower pull** (build in the cloud, NAS pulls a finished image — chosen). No inbound
networking, no untrusted code on the NAS, build cost is on free cloud runners.

---

## CI half — already live 🤖

`.github/workflows/ci.yml` runs the verify gate on every PR + push to `main`. Nothing
to do on the NAS. To make a green run **block merge** (optional), wire it as a required
status check — exact `gh api` command is in the header comment of `ci.yml`. Defer until
a few runs prove the `verify` job name is stable.

---

## CD half — one-time NAS setup 🧑

> **Prerequisite that does not exist yet:** the app has never been deployed to the NAS
> (only Sortie has). Watchtower auto-*updates* a running container — there must first be
> one. Steps 1-4 below ARE that first deploy; after them, every future merge is hands-off.

### Step 0 — Confirm the GHCR package is reachable 🤖/🧑

After the first `deploy.yml` run (push something to `main`, or run it via the Actions
tab → "deploy" → Run workflow), confirm the image exists:

```sh
# from anywhere with gh authed:
gh api /user/packages/container/personal-dashboard/versions --jq '.[0].metadata.container.tags' 2>/dev/null \
  || echo "check github.com/scolacur?tab=packages"
```

A **public** repo publishes a **public** package by default — the NAS can then pull with
no login. If you'd rather keep it private, see "Private package" at the bottom.

### Step 1 — Place the compose + env on the NAS 🧑

Reuse the existing base dir from the Sortie runbook:

```sh
cd /volume1/docker/personal-dashboard/personal-dashboard
git pull                       # gets docker/docker-compose.nas.yml
mkdir -p data                  # SQLite + logs volume (persists across recreates)
```

Create `/volume1/docker/personal-dashboard/personal-dashboard/.env` (next to the
compose, `chmod 600`) — the app's runtime env (PORT=8080, DATA_DIR=/data, plus any
widget secrets). See `.env.example`.

### Step 2 — Bring it up 🧑

CLI:

```sh
cd /volume1/docker/personal-dashboard/personal-dashboard
sudo docker compose -f docker/docker-compose.nas.yml pull
sudo docker compose -f docker/docker-compose.nas.yml up -d
```

Or DSM GUI: Container Manager → Project → Create → point at
`docker/docker-compose.nas.yml` → build/run. This starts BOTH `app` and `watchtower`.

### Step 3 — Verify 🧑

```sh
curl http://localhost:8080/api/health        # -> {"ok":true}
sudo docker logs -f watchtower                # confirms it's watching the labelled app
```

Open `http://<nas-lan-ip>:8080` from a LAN browser.

### Step 4 — Prove the loop (once) 🧑

Merge a trivial PR to `main`, watch `deploy.yml` go green, then within ~5 min:

```sh
sudo docker logs watchtower | tail            # "Found new ...:latest, updating"
```

The `app` container recreates itself with the new image. From here, **deploys are
hands-off** — merge a PR, walk away.

---

## Operations

- **Roll back:** pin `app.image` to a known-good `:<sha>` tag in
  `docker-compose.nas.yml`, `compose up -d` again. (Watchtower only floats `:latest`.)
- **Pause auto-deploy:** stop the `watchtower` container; `app` keeps running the
  current image.
- **Manual deploy without a merge:** Actions tab → deploy → Run workflow
  (`workflow_dispatch`), then `docker compose ... pull && up -d` on the NAS (or wait for
  Watchtower's poll).

## Private package (only if you make the GHCR package private)

1. On a GitHub account, mint a classic PAT with `read:packages`.
2. On the NAS: `echo $PAT | sudo docker login ghcr.io -u scolacur --password-stdin`
   (writes `~/.docker/config.json`), then uncomment the `config.json` mount in the
   `watchtower` service so it can authenticate its polls.

## Follow-ups

- [ ] Wire `verify` as a required status check once the job name is stable (cmd in `ci.yml`).
- [ ] Decide public vs private GHCR package (public = zero NAS auth; default).
- [ ] Set Synology container resource limits on `app` (ties into TODO RAM/CPU item).
