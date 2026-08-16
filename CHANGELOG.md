# Changelog

All notable changes to dsh-full-remote (formerly dsh-reverse-proxy) are
documented in this file.

## Unreleased

### Added

- Config `trustForwardedFor`: when enabled and the direct peer is loopback,
  the proxy uses `CF-Connecting-IP` when present, otherwise the rightmost
  `X-Forwarded-For` value, as the remote client IP for CIDR allowlist,
  login rate limiting, audit and logs. This lets a local tunnel
  (cloudflared/ngrok/frp/SSH) distinguish real remote clients instead of
  treating them all as `127.0.0.1`. Keep disabled for LAN direct access.
- Config `requestTimeoutMs` (default 120s) to control the complete request
  timeout; the effective proxy request timeout is always at least
  `headersTimeoutMs`.
- The reverse-proxy self-check now reports whether `trustForwardedFor` is
  active, so operators can see the tunnel IP behavior from the panel.
- In-panel audit log viewer: Settings → Reverse proxy can load the most
  recent JSONL audit events through a loopback-only control route. The
  viewer supports an event-name filter, a bounded result limit, and JSON
  export/download.
- WebSocket upgrades now emit audit events for auth denials, successful
  opens, and non-101 rejections (`access.denied`, `ws.open`, `ws.reject`).
- WebSocket upgrade rate limiting: config `upgradeMaxAttempts` and
  `upgradeLockoutSeconds` lock out a remote IP after repeated failed
  upgrade attempts.

### Fixed

- Add an end-to-end TLS proxy test with a self-signed fixture certificate.
- Audit log reads now use a bounded tail window instead of loading the whole
  JSONL file into memory.
- Prevent `ERR_OUT_OF_RANGE` when `headersTimeoutMs` exceeds the default
  request timeout: `requestTimeoutMs` is now configurable and the effective
  request timeout is at least `headersTimeoutMs`.
- `trustForwardedFor` now prefers `CF-Connecting-IP` and otherwise uses the
  rightmost `X-Forwarded-For` value, reducing client-side spoofing of CIDR /
  rate-limit / audit inputs.
- Add IPv6 CIDR parse and match tests.
- Drain upstream responses in the WebSocket non-101 fallback and destroy the
  downstream response when an upstream response stream errors.
- Remove legacy `?token=` prefill from the login page so tokens are not
  placed into browser history.
- Remove the stale `dsh-reverse-proxy-0.1.0.tgz` artifact from the repo root.
- Document the tunnel IP limitation and the new opt-in in both READMEs.

## 0.2.4 (2026-08-16)

### Changed

- Login and wait pages: product kicker and slightly clearer card chrome.

### Documentation

- README: the copyable tunnel target (and extra reachable URLs) is what a
  remote client opens; binding `0.0.0.0` is not a URL.
- Phone invite: Origin must be reachable from the scanning device. Encoding
  `127.0.0.1` makes a phone hit its own loopback.
- Screenshot gallery recaptured; README notes pairing with a mobile-layout
  plugin such as dsh-web-mobile.

## 0.2.3 (2026-08-16)

### Added

- **Fence self-check** in Settings → Reverse proxy: probes
  `settings.describe` against the backend with the same Host/Origin rewrite
  the proxy uses, and reports client trust-bootstrap status.
- **Phone invite**: one-time invite login URL
  (`/_dsh_reverse_proxy/login?invite=…`) with QR (via `uqr`) and one-click
  auto-submit on the login page.
- **Structured audit log** (JSONL beside the state file; default on): login,
  approve/revoke/rename, rotate, token reveal, start/stop.
- **CIDR allowlist** (`allowedCidrs`), **session idle timeout**
  (`sessionIdleSeconds`), and **device rename**.
- **Optional local TLS** (`tlsCertFile` / `tlsKeyFile`) for LAN plaintext
  mitigation; Cookie `Secure` when TLS or `x-forwarded-proto: https`.
- Config `allowTokenRead` to disable standing `GET /token` (token only from
  rotate).
- Persist now **rehydrates sessions** across restarts.

### Changed

- Split control-plane **read/write gates** so status/session polls no longer
  queue behind a slow bind.
- Forwarded requests normalize `sec-fetch-site` to `same-origin`.
- ModuleLoader trust wrap **warns on failure** instead of failing silently.
- Phone invite URLs use single-use `?invite=` codes (15 min TTL); the
  standing access token is no longer embedded in QR / invite links.
- Host sources migrated from `.js` to `.ts`; `noImplicitAny` is now
  enabled and all host parameters are annotated. Unit tests still run as
  plain JS through `node --experimental-strip-types`.

### Fixed

- Strip hop-by-hop headers from upstream responses; reject non-loopback
  `backendHost`; expire pending wait-page sessions; serialize state saves
  through the write gate; drain unauthenticated bodies; default
  `requestTimeout` 120s; require control header for status/sessions reads.
- Do not trust client `X-Forwarded-Proto` unless `trustForwardedProto: true`.
- Warn on invalid `allowedCidrs` entries.
- Panel: reject empty listen port; honor `{ ok: false }` on device actions;
  map `tls-failed` / `token-read-disabled`; per-action busy labels; show
  reachables + self-check tls/audit; unmount-safe async updates.
- Invite login CSP allows auto-submit; `Referrer-Policy: no-referrer`;
  strip `Referer` before upstream; drain lockout/early login bodies;
  sanitize WebSocket upgrade headers (drop `Set-Cookie`); equal login
  delay on success/failure; regenerate short tokens without hydrating
  stale sessions; `close()` only succeeds when the listener is gone.
- Panel: clear invite QR on rotate/listen change; rotate toast when
  restart fails; sessions epoch to avoid poll races; loading status;
  `invalid-base` toast; listen description; safer QR SVG gate.
- Only clear `bound` after `close()` succeeds; scale session touch
  throttle for short idle windows; mark pending revoke as `rejected`
  so the wait page shows the rejection copy.

### Refactoring

- `src/index.ts`: the control-action dispatch map is built once per
  runtime instead of once per request.

### Documentation

- README screenshot gallery recaptured against the 0.2.3 panel; new
  phone-invite QR and fence self-check shots (`docs/rp-demo-*.png`), both
  READMEs updated.

## 0.2.2 (2026-08-16)

### Documentation

- README screenshot gallery recaptured against Settings → Reverse proxy
  (status, listen-address warning, token reveal) plus a phone shot of the
  in-app workspace directory browser. Login-gate shots retaken on 390×844
  and a desktop viewport.

## 0.2.1 (2026-08-15)

### Added

- Reverse-proxy controls now live on the official Settings left nav
  (`settings.section`, order 30), matching the Models / Plugins page
  rhythm. The sidebar footer action, overlay dialog, and DOM-guessed
  layout promotion are gone.

### Fixed

- **Rotate token no longer freezes the control surface.** The HTTP handler
  wrapped `rotateToken` in the serial gate twice; the inner wait deadlocked
  the same gate. `proxy.close()` also has a 2s grace so a lingering SSE
  cannot pin rotate/stop forever.
- Official settings edits persist on a tunnel hostname. The index tap
  declares `__DSH_FULL_REMOTE_TRUSTED__` and wraps `__ModuleLoader__` so
  `connection.isLoopback` is true before official plugins bind. A late
  `settingsScope.bind` wrap cannot rewrite scopes that already chose
  memory persistence.
- **Add workspace works on a phone.** The bundle patch disables
  `directory-picker-auto` (native chooser on the host display) and mounts
  the in-app browse backend + UI pair.
- Opening **Settings → Reverse proxy** from a tunnel hostname maps the
  proxy's plain-text `403` to the "use the local 127.0.0.1 window" toast
  instead of a locale-stuck HTTP blurb.
- Clicking **启动代理** when the listen port is occupied (or would loop
  onto the backend) now surfaces the failure in the panel. `GET /status`
  keeps the last start `reason` until the listen address changes or a
  later start succeeds.

### Changed

- Settings page uses a two-node bridge glyph (local solid, remote
  hollow) instead of the diamond-and-cross that collided with other
  panel icons. Status, start/stop, listen, token, and devices are
  grouped like the official Plugins page; the primary action sits in
  the status card instead of at the bottom.
- Control panel toasts for start/stop/listen outcomes. Bind failures,
  self-loop refusals, disposed plugins, and forbidden remote control each
  get a dedicated message with the next step, instead of a silent 200 or
  a raw `reason` code.
- Client graph inject no longer lists `ui-layout` / `ui-sidebar`; the
  page waits on `slots` from `@deepseek-ai/dsh-client-ui-slots`.

### Documentation

- README install sections now say how to upgrade:
  `dsh plugin --profile web update dsh-full-remote`, then restart.
  Profiles do not auto-update on boot.
- Known Limitations cover settings persistence, the browse-picker pin,
  and the harness-default gear icon on the Settings left nav.

## 0.2.0 (2026-08-15)

### Changed

- npm package and GitHub repository renamed to `dsh-full-remote`. Plugin
  id, cookie name, control prefix, forwarding headers, polyfill marker,
  and state file name are frozen so existing sessions keep working.
- README lead is now the Host/Origin rewrite story, scoped to **server-side
  API completeness**, with the client `isLoopback` boundary written down.
- Install is a single command: `dsh plugin --profile web add dsh-full-remote`.
- `GET /token` requires the same control header and loopback Origin as
  mutations.

### Fixed

- Host/Origin rewrite always uses `127.0.0.1`, decoupled from `backendHost`.
  A `backendHost: 0.0.0.0` can no longer 403 every `/api` call.
- Wildcard listen (`0.0.0.0` / `::`) reports a reachable tunnel target
  instead of an unconnectable bind address; IPv6 authorities are bracketed.
- Self-loop detection treats wildcard listen as covering the backend.
- Wildcard `backendHost` is rejected at plugin load.

### Added

- Panel copy for bind-vs-reachable, plus a "how to choose a listen address"
  section in both READMEs.
- `AbortSignal.any` polyfill next to the existing `randomUUID` shim.
- Console warning when sidebar-foot layout detection falls back to the
  native inline button.

### Documentation

- Proxy healthz path documented as `/_dsh_reverse_proxy/healthz` (the
  public control prefix is never forwarded).
- Overlay mask `aria-label` follows the active locale.
- Mobile-profile docs no longer imply a blank profile is enough; the
  second process still needs a Web UI.

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
