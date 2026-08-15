# Changelog

All notable changes to dsh-reverse-proxy are documented in this file.

## 0.1.0 (unreleased)

### Added

- Authenticated reverse proxy for HTTP, SSE, and WebSocket traffic with a
  192-bit access token and derived HttpOnly session cookies.
- Sidebar entry and control panel: start/stop, status, one-click target copy,
  token reveal and rotation.
- Runtime listen-address UI (IP/port) with persistence and automatic rollback
  to the previous address when a bind fails.
- Hardening knobs in Config: `maxRequestBytes`, `upstreamTimeoutMs`,
  `sessionMaxAgeSeconds`, `maxHeaderSizeBytes`, `headersTimeoutMs`,
  `keepAliveTimeoutMs`, `loginDelayMs`.
- Optional per-request debug logging (`logRequests`).
- Bilingual README (English / 中文).

### Security

- Stream-level request body limit (chunked uploads cannot bypass it).
- Spoofable forwarding and hop-by-hop headers stripped; the proxy's own
  session cookie never reaches the backend; upstream `set-cookie` stripped.
- Fixed delay on failed login to slow token guessing.
- Control routes restricted to loopback with a control header and loopback
  Origin check; control paths never forwarded through the public proxy.

### Tests

- Unit and integration tests via `node:test` (security, persistence, header
  forwarding, authenticated proxying, chunked limit, WebSocket upgrade,
  control surface, Cordis lifecycle) and `vitest` + Testing Library for the
  client UI.
