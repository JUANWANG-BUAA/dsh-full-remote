# Changelog

All notable changes to dsh-reverse-proxy are documented in this file.

## 0.1.0 (2026-08-15)

### Documentation

- Standard open-source project docs: bilingual READMEs with cross-links and
  badge strip, CONTRIBUTING, SECURITY, issue/PR templates, EditorConfig and
  gitattributes.
- Feature-indexed screenshot gallery (sidebar entry, control panel, runtime
  listen address with warning, token reveal, desktop and mobile login gate).

### Added

- Authenticated reverse proxy for HTTP, SSE, and WebSocket traffic with a
  192-bit access token and derived HttpOnly session cookies.
- Per-device sessions: each login mints an independent device credential
  (hash at rest, never the raw secret); the control panel lists devices and
  can kick any one instantly. Sessions are persisted, capped
  (`maxSessions`), and expire after `sessionMaxAgeSeconds` without activity.
- First-visit approval mode (`approvalMode`): new devices wait on a polling
  page until the local panel approves or rejects them.
- Sidebar entry and control panel: start/stop, status, one-click target copy,
  token reveal and rotation.
- Runtime listen-address UI (IP/port) with persistence and automatic rollback
  to the previous address when a bind fails.
- Hardening knobs in Config: `maxRequestBytes`, `upstreamTimeoutMs`,
  `sessionMaxAgeSeconds`, `maxHeaderSizeBytes`, `headersTimeoutMs`,
  `keepAliveTimeoutMs`, `loginDelayMs`, `loginMaxAttempts`,
  `loginLockoutSeconds`.
- Optional per-request debug logging (`logRequests`).
- Guarded `crypto.randomUUID` polyfill injected into the Web index so remote
  browsers on plain-HTTP (insecure) origins can still attach files; the
  sidebar panel copies the tunnel target and token through the legacy
  clipboard path when the async Clipboard API is unavailable.
- Bilingual README (English / 中文).
- Bilingual control panel: the client UI follows the DeepSeek Harness locale service when
  present (zh/en, optional dependency with zh fallback) and the login gate
  follows the browser's Accept-Language.
- Self-loop protection: starting is refused when the backend address equals
  the listen address.
- Idempotent proxy `close()` (safe for runtime rollback races).

### Security

- Stream-level request body limit (chunked uploads cannot bypass it).
- Spoofable forwarding and hop-by-hop headers stripped; the proxy's own
  session cookie never reaches the backend; upstream `set-cookie` stripped.
- Per-remote-IP login rate limiting (`429` lockout after
  `loginMaxAttempts` failures, `Retry-After` header, bounded in-memory
  buckets) on top of the fixed per-attempt delay.
- Control routes restricted to loopback with a control header and loopback
  Origin check; control paths never forwarded through the public proxy.

### Refactoring

- Host modules split by responsibility: `http-util.js` (shared path/body/response
  plumbing), `pages.js` (all user-facing copy as zh/en tokens + page templates),
  `sessions.js` (device-session store). Removed duplicated `pathnameOf`,
  bounded-body readers, `safeEqual`, and page CSS; every source file now
  carries a module-level JSDoc contract. Client panel extracted
  `DevicesSection` from the overlay.

### Tooling

- ESLint flat config wired into `check` / `check:ci`.
- Fixed CI on GitHub: the CodeQL job now provisions pnpm explicitly, and the
  smoke job builds the harness checkout (`pnpm run build`) before booting —
  a fresh checkout otherwise fails with MissingClientBundleError / "frontend
  dist not built".
- Host entry ships TypeScript declarations (`lib/index.d.ts` via tsdown
  `dts`), and the tarball now includes CONTRIBUTING.md.
- Community-standard install verified end to end: dependencies install from
  npm (no sibling-checkout requirement), self-contained `prepare`, and the
  tarball / directory / git `dsh plugin add` routes are documented and tested.
- CI: `check:ci` (self-contained declarations) plus a real-boot smoke job
  that installs the bundle via `dsh plugin add` and exercises the control
  surface, login gate, rate limiter, and index polyfill against a live
  harness composition (`scripts/smoke.mjs`).
- Dependabot (npm + GitHub Actions) and CodeQL workflows; npm publish
  workflow with provenance (`docs/publishing.md` covers the strategy).
- GitHub metadata checklist (`docs/github-metadata.md`).

### Tests

- Unit and integration tests via `node:test` (security, persistence, header
  forwarding, authenticated proxying, chunked limit, WebSocket upgrade and
  FIN propagation on close, login rate limiting, control surface, Cordis
  lifecycle, self-loop refusal, index fixture snapshot) and `vitest` +
  Testing Library for the client UI (sidebar promotion, clipboard fallback,
  i18n dictionaries).
