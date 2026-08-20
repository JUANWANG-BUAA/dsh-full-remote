# Security Policy

dsh-full-remote is an authentication gate in front of a loopback-trusted
Web UI. Please take security issues seriously.

## Supported versions

| Version | Supported |
|---|---|
| 0.3.x | ✅ |
| ≤ 0.2.x | ❌ |

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private disclosure channel:

1. Open the repository → **Security** tab → **Report a vulnerability**
   (GitHub Security Advisory).
2. Include: affected version, a description of the impact, and reproduction
   steps or a proof of concept.
3. You will receive an acknowledgement; we will keep you informed of the
   resolution and coordinate the disclosure timing with you.

## What to report

- Authentication or authorization bypasses (token check, cookie handling,
  control-surface access).
- Request smuggling or header-injection vectors through the proxy.
- Anything that lets a remote client reach DeepSeek Harness control routes or the loopback
  backend without the access token.

## Security model at a glance

- 192-bit access token, stored locally with mode `0600`.
- Remote browsers exchange the token for an HttpOnly, SameSite session cookie
  carrying a per-device secret; only its hash is stored, so one kicked device
  cannot affect any other.
- Optional approval mode holds new devices on a waiting page until the local
  panel approves or rejects them.
- Control routes (`/dsh-reverse-proxy/*`) are loopback-only and never
  forwarded through the public proxy.
- Failed logins are rate-limited per remote IP (configurable
  `loginMaxAttempts` / `loginLockoutSeconds`) on top of a fixed per-attempt
  delay.
- Phone invites are one-time 15-minute links. A repeat submit of the same
  code is only accepted from the same remote IP within 60 seconds of the
  first use (browser retry after a lost redirect), and reuses the original
  device session instead of minting a second one. This retry grace is a
  usability trade-off for shared-NAT networks: shorten or disable it in a
  deployment where another user can observe the invite URL and share the same
  source IP. Any other reuse is rejected.
- `trustForwardedFor` is only for a trusted loopback edge. Cloudflare's
  `CF-Connecting-IP` is ignored unless `trustCloudflareConnectingIp` is also
  enabled; enabling either setting on a client-controlled proxy makes IP-based
  controls spoofable.
- Revoking a device closes its active proxied HTTP streams and upgraded
  WebSocket connections. Existing requests may still finish if the upstream
  has already sent a response; rotate the master token for a full deployment
  reset.
- `GET /_dsh_reverse_proxy/healthz` is behind the CIDR allowlist, not the
  login gate: an empty allowlist means the probe is public on the proxy
  port (use CIDR or bind loopback if you do not want that).
- Spoofable forwarding and hop-by-hop headers are stripped; the proxy's own
  session cookie never reaches the backend; request bodies are size-limited
  on the stream.
- Response gzip (when enabled) runs only on authenticated proxied HTTP
  responses, never on WebSocket upgrades or SSE. Hashed-asset
  `Cache-Control: immutable` is applied only to Vite content-hashed
  `/assets/*` 200s; `index.html` and `/api` are never given that header.

Keep the token secret and always terminate TLS on the public side of your
tunnel. See `README.md` for the full model and configuration notes.
