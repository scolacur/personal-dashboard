# D-030: Off-LAN access via Tailscale, with tailnet membership as the authentication (PD-34)

**Decision:** Reach the dashboard off-LAN over **Tailscale**, not a public reverse proxy.
Tailnet membership **is** the auth — the app stays login-less and is never publicly exposed.

**Why (over Synology RP + DDNS + Let's Encrypt, or Cloudflare Tunnel):**

- Tailscale already runs on the NAS for other apps, and the app container already publishes
  `8088` on all host interfaces, so it's reachable at `http://<nas-tailnet-name>:8088` from any
  device on the tailnet with **zero** app changes — no port-forward, no DDNS, no inbound ingress.
- The ticket requires "authentication before exposing." A public URL would mean building an app
  login (out of scope, and a standing attack surface). Tailscale makes the **tailnet the auth
  boundary** (WireGuard device identity): only my own devices can reach it, and it's never exposed.
  For a single-user personal dashboard, tailnet membership is sufficient and stronger than a
  bolt-on password. This also matches the egress-hardening security posture already in place.
- **Ports to the Mac Mini for free** — the app is moving off Synology ([[D-029]] context); Tailscale
  is just installed on the new host and the same access model holds.

**HTTPS deferred, not required:** traffic over the tailnet is already WireGuard-encrypted end-to-end,
so plain HTTP is fine. `tailscale serve` can later add a real Let's Encrypt cert on `*.ts.net`
(still private) if a secure-context browser feature (PWA/service worker) or the "not secure" label
makes it worth it. Public exposure via RP/Cloudflare only earns its complexity if the dashboard ever
needs to be shared with someone **not** on the tailnet.

**Manual (🧑) steps** (no code): confirm Tailscale + MagicDNS are up on the NAS, install/log in the
phone, hit the MagicDNS URL off-wifi. Runbook: `ops/access/README.md`.
