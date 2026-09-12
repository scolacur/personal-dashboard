# Off-LAN access runbook — Personal Dashboard (PD-34)

How to reach the dashboard from off the home network (e.g. your phone on cellular),
without exposing it to the public internet.

**Status legend:** 🧑 = Steve (needs your hands / NAS / phone) · 🤖 = Tank can run it.

See [D-030](../../DECISIONS/D-030-off-lan-access-via-tailscale-tailnet.md) for the *why*.

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
interfaces (`host: '0.0.0.0'` in `apps/server/src/index.ts`), and tailscaled
delivers inbound tailnet connections to it.

**How that delivery actually happens on the NAS, because it is not what it
looks like.** Synology's package runs `tailscaled --tun=userspace-networking`,
so there is **no `tailscale0` interface** — `ip -4 addr` shows only `lo`,
`sit0`, `eth0`, `eth1` and the docker bridges, and the NAS's `100.x` address is
on **no host interface at all**. Nothing routes to it. What makes the dashboard
reachable is tailscaled's **userspace proxy**, which accepts the tunnelled
connection and dials the local port itself. The `0.0.0.0` bind matters because
the proxy dials a local address — but it is the proxy, not a host route, doing
the work. Same outcome, different mechanism, and the difference only shows up
when something is being debugged.

On the **Mac Mini** this stops being a special case: Tailscale there creates a
real `utun`, the `100.x` address lives on an interface, and the host-route
reading finally is the true one.

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

## Troubleshooting 🧑

**Never test reachability by curling the NAS's own tailnet IP from the NAS.** It
returns nothing under userspace-networking whether or not inbound access is
perfectly healthy — a node cannot reach its own tailnet address without a TUN
device. It is a hairpin artifact, not a result.

```sh
# ✗ proves nothing, from the NAS itself
curl http://100.x.y.z:8088

# ✓ the only test that means anything — from a SECOND device on the tailnet
curl http://<nas-name>:8088
route -n get 100.x.y.z     # macOS: the interface should be a utun, not en0
```

**When the dashboard is unreachable from a laptop or phone, check these in order:**

1. **Is this device logged in?** `tailscale status` — "Logged out" is by far the
   most common cause. Every login mints a *new* node rather than reusing one, so
   a long list of offline `<host>-1`, `<host>-2`… entries is normal and is worth
   pruning in the admin console.
2. **Is it the LAN, not the tailnet?** A plain connect timeout to
   `192.168.68.50:8088` on home wifi is an ordinary network fault and says
   nothing about off-LAN access. Rule this out first.
3. **Is the NAS itself on the tailnet?** `tailscale status` from the NAS should
   list it as logged in.

This section exists because on 2026-09-11 a session worked down the host
interfaces, found no TUN, ran the bad self-directed curl above, and concluded
off-LAN access had never worked — then nearly ran `tailscale serve --bg 8088`
against production to fix a system that was not broken. The real fault was (1).

---

## Porting to the Mac Mini

When the app moves off Synology: install Tailscale on the Mac Mini, log into the same
tailnet, and this exact model holds (`http://<macmini-name>:8088`). Nothing in the app
changes.
