# Changelog

All notable changes to dsh-full-remote (formerly dsh-reverse-proxy) are
documented in this file.

## Unreleased

## 0.3.7 (2026-08-21)

### Changed

- Verified against DeepSeek Harness **0.1.1-rc.1** (`528c682e061696f5a160f363f236ecbf53cbd006`).
  npm dist-tags `latest` and `next` both publish that version. Client
  typecheck pins `@deepseek-ai/dsh-client-runtime` / `-ui-slots`
  `0.1.1-rc.1`; the peer range remains `>=0.1.0-rc.5 <0.2`.
- Default `maxRequestBytes` is **160 MiB**, matching the Harness `/api`
  bridge sized for a 100 MiB aggregate image payload after base64. The
  previous 16 MiB default 413'd remote `session.prompt` bodies used by
  `deepseek-v4-flash-vision-exp` paste/drop before Harness saw them.
- Default `requestTimeoutMs` is **5 minutes** so a phone tunnel can finish
  sending that body. `upstreamTimeoutMs` is a TCP-connect deadline and, for
  POST/PUT/etc., a first-response-byte deadline after the client finishes
  sending. Slow uploads after connect are not killed; hung backends still
  502. GET/HEAD (SSE) do not use the post-body wait.
- Remote `ask_user_question` custom answers use a wrapping textarea;
  `Shift+Enter` inserts a newline and Enter still continues, matching
  Harness 0.1.1-rc.1.
- CI/dev installs exclude `@deepseek-ai/dsh-*` from pnpm
  `minimumReleaseAge` so same-day `0.1.1-rc.1` pins resolve.

## 0.3.6 (2026-08-21)

### Fixed

- Remote Settings → Models no longer fails with
  `加载提供方目录失败: settings are unavailable in this browser` on
  DeepSeek Harness 0.1.0-rc.8. That release's HTML queue facade
  `create()` replaces `__ModuleLoader__.load`; the page bootstrap now
  traps that assignment (and re-traps after `create()`) so
  `connection.isLoopback` is still pinned before official settings bind
  (#13).

### Changed

- CI real-boot smoke and contributor bootstrap pin DeepSeek Harness
  `0.1.0-rc.8` (`141eb6fef83422698aef7a981029e843e8161534`). Client peer
  range remains `>=0.1.0-rc.5 <0.2`.

## 0.3.5 (2026-08-20)

### Added

- HTTP gzip for compressible proxied responses when the client sends
  `Accept-Encoding: gzip`. SSE, WebSocket upgrades, fonts, already-encoded
  bodies, plugin gate pages, and responses under 1 KB are skipped. Measured
  through the proxy (gzip level 6, `@deepseek-ai/dsh-web-frontend@0.1.0-rc.6`
  dist, `tests/compress-matrix.test.ts`): first-load shell
  (`index.html` + hashed index/vendor JS/CSS) **1 285 699 → 350 802 bytes
  (−72.7%)**; `vendor-*.js` 744 872 → 180 729 (−75.7%); all 89 dist files
  −63.1% because fonts are left uncompressed. A repeated-padding JSON
  fixture can gzip −96%+; that is not a product number, and issue #11's
  "95%+" is not a general result. WebSocket event streams are unchanged.
  Disable with `compressResponses: false`. Full contract:
  [`docs/http-gzip.md`](./docs/http-gzip.md)
  ([中文](./docs/http-gzip.zh.md)).
- `Cache-Control: public, max-age=31536000, immutable` on successful hashed
  `/assets/*` responses that have no upstream cache header. `index.html` and
  `/api` are never cached. Node tests assert the header contract; they cannot
  measure a browser cache hit. Disable with `cacheHashedAssets: false`.

### Documentation

- HTTP gzip / hashed-asset cache contract, measured first-load sizes, and
  the cases that are intentionally not compressed:
  [`docs/http-gzip.md`](./docs/http-gzip.md)
  ([中文](./docs/http-gzip.zh.md)).

### Fixed

- Installing alongside `deepseek-harness-auth` no longer fails boot with
  `duplicate loader entry id: directory-picker-browse`. This bundle still
  disables the adaptive picker, but it no longer inserts the official browse
  rows; it creates them at runtime only when those ids are absent from the
  whole loader tree, including nested Include subtrees (#12).

## 0.3.4 (2026-08-18)

### Security and reliability

- CI now typechecks against the published Harness client contracts instead of
  a handwritten compatibility shim.
- Durable state mutations fail closed and roll back in-memory changes when a
  state write fails; revoking a device also closes its active HTTP, SSE, and
  WebSocket streams.
- Login admission is reserved before body parsing, approval mode never evicts
  an active device, and dynamic hop-by-hop headers are stripped.
- CIDR parsing, cookie/config bounds, tunnel download limits, cache digests,
  and audit paths are validated more strictly.
- Release smoke installs the packed tarball and CI covers Node 22 and 24.
- CI actions are SHA-pinned; checks run on Ubuntu, macOS, and Windows, with
  Node and client coverage thresholds, a Chromium browser smoke, and an
  effective-composition collision check.
- The proxy now has an explicit delayed-event SSE regression test. The
  directory-picker patch defaults to remote-safe browse mode and supports an
  explicit native-picker opt-out without duplicate providers.
- Screenshot gallery files are no longer shipped in the npm tarball; README
  images use the repository-hosted copies instead.

### Documentation

- Quick Start now leads with the one-click tunnel and documents the separate
  `trustCloudflareConnectingIp` opt-in.

## 0.3.2 (2026-08-18)

### Added

- Remote confirmation sheet: on a phone or any non-loopback browser,
  pending tool approvals, `ask_user_question` option lists, and plan
  reviews render as a `shell.overlay` bottom sheet so they can be
  answered without being stuck on the host conversation composer.
  README gallery includes live phone-drawer and remote-desktop-card
  shots.

### Changed

- Standing token reads now default to disabled (`allowTokenRead: false`);
  deployments that need local token re-reads must opt in explicitly.
- Production dependency auditing is available through `pnpm run audit:prod`.
- The npm package excludes embedded source maps while retaining the built
  runtime, declarations, documentation, and screenshot gallery.

### Fixed

- Partial TLS and malformed CIDR configuration now fails closed during
  plugin activation instead of being silently widened or partially applied.
- Forwarded client identity is trusted only from an eligible loopback edge;
  Cloudflare headers require explicit opt-in and tunnel forwarding is trusted
  only after the tunnel is online.
- Active session requests refresh idle expiry, while clock injection keeps
  expiry behavior deterministic in tests.
- Control-route authentication is exercised over a real HTTP listener, and
  the real Harness smoke flow now explicitly opts in to token reads only in
  its isolated test home.

## 0.3.1 (2026-08-18)

### Added

- One-click Cloudflare quick tunnel (Settings → Reverse proxy): resolves a
  cloudflared binary via `cloudflaredPath` → PATH → a pinned,
  SHA256-verified download cache (release `2026.8.2`; darwin tgz, linux
  bare binaries, windows exe), then runs `cloudflared tunnel --url` in
  front of the proxy listener. The token gate, approval, CIDR allowlist
  and audit all keep applying. Quick-tunnel URLs are random per start, so
  the tunnel is a session-scoped opt-in — it is never persisted or
  auto-restored.
- While the tunnel is active, forwarding-header trust
  (`trustForwardedFor` / `trustForwardedProto`) is enabled dynamically
  so tunnel users keep per-client IPs in rate limiting, CIDR and audit;
  it reverts the moment the tunnel stops. The proxy still only trusts
  forwarding headers from loopback peers.
- Tunnel-aware invite fallback: `publicBase ?? tunnel URL ?? local
  target` — open the tunnel, generate the QR, scan on the phone.
- Local TLS and the quick tunnel are mutually exclusive
  (`tls-unsupported`); tunnel start/stop/error events are audited; the
  tunnel process is torn down on stop, listen-address change and dispose.
- Invite retry grace: after a successful invite consume, the same code is
  accepted again only from the same remote IP within 60 seconds, so a flaky
  tunnel that drops the login redirect cannot deadlock the phone into the
  token form. The retry reuses the original device session (it does not
  mint a second one). Any other reuse stays rejected and the audit keeps
  the `via=invite` trail.
- Invite failure copy now tells the user they may already be signed in and
  to open the home page directly, instead of silently degrading to the
  token form.
- Opt-in device home page at `/_dsh_reverse_proxy/home`: session facts
  (device label, login IP/time, expiry estimate, security posture),
  self-rename and self-logout (`POST /_dsh_reverse_proxy/logout`
  revokes only the signed-in device and clears its cookie; audited as
  `session.logout`). Login still lands on `/` by default — the home
  page is reachable from a secondary button on the login form or a
  direct visit.

### Changed

- Control-surface HTTP dispatch is a route table with a single auth gate,
  so a new route cannot ship without the loopback Origin / control-header
  check. Host classification (`isLoopbackHost` / `isWildcardHost`) is
  shared by the host, the settings page, and the settings-persistence wrap.
- Control-surface JSON bodies: malformed JSON is still `400
  invalid-request`; unexpected handler throws become `500 action-failed`
  instead of being reported as a client error.
- Device rename on the settings page uses an inline field (Save / Cancel),
  not `window.prompt`.
- Self-check always reports whether standing token reads are on or off.
- `RuntimeStatus` no longer carries a constant `authenticated: true` field.
- The npm tarball now ships `docs/screenshots/*` so the README gallery
  renders on npm, not only on GitHub.

### Fixed

- Wait-page poll script embeds the status URL and copy via JSON (JavaScript
  context), not HTML escaping.
- Wait-status responses serialize `session.status` with `JSON.stringify`.
- Settings page loopback/wildcard checks now follow the same 127/8 and
  IPv4-mapped rules as the host (e.g. `127.0.0.2` is loopback).
- Invite retry no longer creates a second device; kicking the device
  during the grace window cannot be undone by re-POSTing the invite.
- README / npm screenshot gallery recaptured against the current settings
  page (listen address first, recommended-usage guide, one-click tunnel,
  token-read self-check, inline device rename) plus the login secondary
  button, device home, and approval wait page.

## 0.3.0 (2026-08-17)

### Added

- Device sessions now record the remote IP at login and the most recent
  validated request IP (`createdIp` / `lastSeenIp`), shown in the settings
  panel device list as "Source IP". Records persisted before this change
  keep working and simply have no IP fields.
- The audit log rotates past 8 MB, keeping one previous generation as
  `<auditFile>.1`, so the append-only JSONL can no longer grow without
  bound. Writes are serialized through a queue so concurrent events cannot
  interleave a rotation.

### Changed

- Invites can only be generated while the proxy is running: the control
  route answers `409 not-running` and the panel disables the generate
  button with an explanatory hint. A QR for a stopped proxy could only
  produce a connection-refused (or a literal `:0` URL with an
  auto-assigned port).
- `trustForwardedFor`: forwarded values are only trusted when they are
  literal, non-loopback IPs. A client-injected `CF-Connecting-IP` on a
  non-Cloudflare edge (ngrok/frp/SSH) can no longer impersonate loopback to
  bypass the CIDR allowlist or evade per-IP rate limiting.

### Fixed

- Audit viewer: the result limit now applies after the event filter, not
  before — filtered queries no longer miss matching events that sit just
  beyond the last N raw lines.
- Control actions (start/stop/rotate) answer `500 action-failed` instead
  of hanging the panel when the underlying operation rejects (e.g. a
  close-timeout during stop).
- Login cookie: omitting `sessionMaxAgeSeconds` in a direct `listenProxy`
  call no longer emits an invalid `Max-Age=undefined` attribute.
- Control routes now accept every 127/8 loopback alias (e.g. `127.0.0.2`),
  not just `127.0.0.1` / `::1`.
- Invite bases with a non-http(s) scheme are rejected with `invalid-base`.
- The upstream connect timer is disarmed on the body-overflow path instead
  of firing a second destroy up to `upstreamTimeoutMs` later.
- Concurrent first state loads share one read instead of racing two token
  generations and two state-file writes.
- Audit export: the object URL is revoked after a short delay so the
  download is not cancelled in some browsers (Firefox).
- Audit viewer: an empty limit input now means the default (50), not 1.

### Documentation

- Upgrade path: use `dsh plugin --profile web update --latest dsh-full-remote`.
  A bare `update` stays on an exact pin (`add …@0.2.4`).

## 0.2.5 (2026-08-16)

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

- Index-tap bootstrap no longer assigns `ctx.provide` (GitHub #9). Cordis 4
  Context is a Proxy; replacing that mixin registered later plugins onto
  the connection fiber and broke `ctx.<ownService>` reads such as Better
  Sidebar. After the official connection `apply()` returns, pin
  `isLoopback` on the handle via `ctx.get('connection', false)`.
  `__DSH_FULL_REMOTE_TRUSTED__` is set only after the `__ModuleLoader__`
  wrap succeeds; export-wrap failure now sets `BOOTSTRAP_FAILED`.
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
