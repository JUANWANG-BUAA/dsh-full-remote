# Security Policy

dsh-reverse-proxy is an authentication gate in front of a loopback-trusted
Web UI. Please take security issues seriously.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | ✅ |
| < 0.1.0 | ❌ |

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
- Spoofable forwarding and hop-by-hop headers are stripped; the proxy's own
  session cookie never reaches the backend; request bodies are size-limited
  on the stream.

Keep the token secret and always terminate TLS on the public side of your
tunnel. See `README.md` for the full model and configuration notes.
