# Off-LAN access runbook — Personal Dashboard (PD-34)

How to reach the dashboard from off the home network (e.g. your phone on cellular),
without exposing it to the public internet.

**Status legend:** 🧑 = Steve (needs your hands / NAS / phone) · 🤖 = Tank can run it.

See [DECISIONS.md D-030](../../DECISIONS.md) for the *why*.

---

## The model: Tailscale, tailnet = auth

The app is **not** published publicly. Instead it rides the existing Tailscale
tailnet, and **tailnet membership is the authentication** — only your own logged-in
devices can reach it, and there is no inbound port-forward or public URL to attack.

```
Phone (Tailscale on)  ──WireGuard tunnel──▶  NAS (Tailscale on)  ──▶  app :8088
     off-wifi                encrypted            same tailnet         (0.0.0.0)
```

Why this and not a public reverse proxy: no app login to build, nothing exposed,
already-encrypted transport, and it **ports to the Mac Mini** by just installing
Tailscale there. Full reasoning in D-030.

No app code is involved: the container already publishes `8088` on all host
interfaces (`host: '0.0.0.0'` in `apps/server/src/index.ts`), so it is already
reachable on the NAS's tailnet address.

---

## Bring-up (one-time) 🧑

1. **Confirm Tailscale is up on the NAS** and note its tailnet name/IP:
   ```sh
   tailscale status        # NAS should be listed, logged in
   tailscale ip -4         # its 100.x.y.z tailnet address
   ```
   (Tailscale on Synology runs as a DSM package or container — whichever is already
   in use for the other NAS apps.)

2. **Enable MagicDNS** (Tailscale admin console → DNS → MagicDNS) so you can use a
   stable hostname instead of the `100.x` IP. The NAS is then reachable at
   `http://<nas-name>.<your-tailnet>.ts.net:8088` (or just `http://<nas-name>:8088`
   from a device with MagicDNS).

3. **Install Tailscale on the phone** and log into the same tailnet.

4. **Verify off-wifi:** turn off wifi (use cellular), open
   `http://<nas-name>:8088` — the dashboard should load. That confirms the tunnel,
   not just LAN.

---

## Notes

- **Ports:** app is on host `8088` (8080 is the gluetun VPN container). Use `:8088`.
- **HTTPS is deferred.** Tailnet traffic is already WireGuard-encrypted, so plain
  HTTP is fine. If you later want a real cert (for PWA/service-worker secure-context
  features, or to drop the browser "not secure" label), add it without exposing
  anything public:
  ```sh
  tailscale serve --bg 8088     # serves https://<nas-name>.<tailnet>.ts.net → :8088
  ```
- **Sharing with non-tailnet people** is the only case that needs a public reverse
  proxy (Synology RP + DDNS + Let's Encrypt, or Cloudflare Tunnel) — and that would
  require building app-level auth first. Out of scope until there's a real need.

---

## Porting to the Mac Mini

When the app moves off Synology: install Tailscale on the Mac Mini, log into the same
tailnet, and this exact model holds (`http://<macmini-name>:8088`). Nothing in the app
changes.
