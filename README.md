# dsh-reverse-proxy

[![CI](https://github.com/JUANWANG-BUAA/dsh-remote/actions/workflows/ci.yml/badge.svg)](https://github.com/JUANWANG-BUAA/dsh-remote/actions)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](./LICENSE)
[![GitHub Repo stars](https://img.shields.io/github/stars/JUANWANG-BUAA/dsh-remote?style=flat-square)](https://github.com/JUANWANG-BUAA/dsh-remote/stargazers)
[![GitHub last commit](https://img.shields.io/github/last-commit/JUANWANG-BUAA/dsh-remote?style=flat-square)](https://github.com/JUANWANG-BUAA/dsh-remote/commits/main)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933?style=flat-square&logo=nodedotjs&logoColor=white)](./package.json)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4D6BFE?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](https://github.com/JUANWANG-BUAA/dsh-remote/pulls)

**English** | [中文](./README.zh.md)

An installable DeepSeek Harness bundle that creates an authenticated local
reverse-proxy endpoint for the DeepSeek Harness Web UI, plus a sidebar control panel to run
it. It is intentionally independent of Tailscale, frp, ngrok, cloudflared,
WireGuard, SSH, or any other tunnel.

The plugin does not launch or manage tunnel software. Point your tunnel at the
local target shown in the DeepSeek Harness sidebar, for example `http://127.0.0.1:3081`.

## Screenshots

Each feature is shown against a clean harness profile (no personal data).

| Feature | Screenshot |
|---|---|
| Sidebar entry — own row above the other footer actions | ![Sidebar entry](./docs/rp-demo-sidebar.png) |
| Control panel — status, tunnel target, one-click copy | ![Control panel](./docs/rp-demo-panel.png) |
| Runtime publish address — non-loopback warning before applying | ![Listen address](./docs/rp-demo-listen-address.png) |
| Access token — reveal and rotate | ![Access token](./docs/rp-demo-token.png) |
| Remote login gate — desktop | ![Login gate](./docs/rp-demo-login.png) |
| Remote login gate — mobile (390×844) | ![Mobile login](./docs/rp-demo-mobile-login.png) |

## Features

- Authenticated reverse proxy for HTTP, SSE, and WebSocket traffic.
- **Per-device sessions**: every device that logs in gets its own credential;
  the panel lists connected devices and can kick any one of them instantly.
- **First-visit approval mode** (optional): new devices wait on a polling
  page until you approve or reject them from the local panel.
- Sidebar panel: start/stop, status, one-click target copy, token reveal and
  rotation, device management.
- **Runtime listen address**: republish the proxy on any IP/port from the UI
  without editing `cordis.yml`; the choice persists and survives restarts.
  A running proxy restarts on the new address, and a failed bind rolls back
  to the previous working address automatically.
- Persisted state (`0600`) with atomic writes; `autoRestore` re-enables the
  proxy after a DeepSeek Harness restart.
- Mobile-ready login page and viewport injection.

## Security model

DeepSeek Harness normally trusts its loopback Web endpoint. A generic tunnel can be public,
so merely rewriting `Host` would expose that trusted API. This plugin places an
authentication gate before the proxy:

- a 192-bit access token is generated locally and stored with mode `0600`;
- remote browsers exchange the token for an HttpOnly, SameSite session cookie
  carrying a per-device secret; only its hash is stored, so a kicked device
  loses access immediately while every other device stays connected;
- failed logins cost a fixed delay, slowing token guessing;
- DeepSeek Harness control routes are never forwarded through the proxy;
- start, stop, token reveal, rotation, and listen changes require a direct
  loopback request with a CSRF-resistant control header and loopback Origin;
- spoofable forwarding and hop-by-hop headers are removed before forwarding;
- the proxy's own session cookie never reaches the backend, and upstream
  `set-cookie` is stripped (the backend cannot establish cookies with remote
  browsers anyway);
- request bodies are size-limited on the stream itself, so chunked uploads
  cannot bypass the declared limit.

Keep the token secret. Use HTTPS on the public side of your tunnel.

## Comparison with related plugins

Several community plugins solve parts of remote access. They are listed in the
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
registry; the table below is based on that registry's descriptions and each
project's own README.

| | **dsh-reverse-proxy** (this) | [dsh-web-lan-access](https://github.com/AcidGr/dsh-web-lan-access) | [dsh-mobile-gate](https://github.com/Bernardxu123/dsh-mobile-gate) |
|---|---|---|---|
| Model | Authenticated reverse proxy you point **any** tunnel at (frp/ngrok/cloudflared/SSH) | Direct LAN links: injects a `crypto.randomUUID` polyfill so the stock frontend survives plain-HTTP origins | Isolated child-process reverse proxy with a LAN mobile gateway |
| Authentication | 192-bit token → per-device HttpOnly session cookie (hash at rest) | None (trusts the LAN) | First-visit approval + per-device token binding |
| First-visit approval | Optional approval mode with polling wait page | — | Built-in first-visit approval |
| Device management | Panel lists devices, kick any one instantly | — | Per-device binding |
| Login throttling | Per-IP `429` lockout + fixed delay | — | Rate limiting |
| WebSocket / SSE | Full forwarding with session teardown | n/a | — |
| Control surface | Sidebar panel: start/stop, runtime listen address with rollback, token reveal/rotate | — | — |
| Runtime reconfiguration | Republish on a new IP/port from the UI, persisted | — | — |

Why pick this plugin:

- you already run a tunnel (Tailscale, frp, ngrok, cloudflared, SSH) and want a
  token-gated entry in front of DeepSeek Harness instead of trusting the loopback endpoint;
- you need the full Web experience remotely, including WebSocket/SSE traffic
  (streaming, tool cards, terminals) and file attachments;
- you want the auth gate to live in the same process as DeepSeek Harness, without
  installing or managing extra gateway software.

Why pick one of the others:

- **dsh-web-lan-access** — you only ever access DeepSeek Harness over a trusted LAN/Tailscale
  IP (no public exposure) and just want the frontend to work on plain HTTP.
- **dsh-mobile-gate** — you prefer a per-device binding plus a first-visit
  approval flow, and accept running a separate child-process gateway.

This plugin also injects the `crypto.randomUUID` polyfill (guarded, only when
the browser lacks it), so remote file attachments keep working on plain HTTP.

## Install

The plugin needs the `webServer` service, which the official
`@deepseek-ai/dsh-web-app` bundle provides. Its npm dependencies are not yet
fully published, so a profile that does not already carry web-app must get it
from a harness source checkout first:

```sh
# Once, if your profile lacks the official web bundle:
dsh plugin --profile web add /path/to/deepseek-harness/packages/bundle/web-app

# 1. Build the package tarball (once, in this repo)
pnpm pack

# 2. Add this plugin to the profile (the profile is created on first use)
dsh plugin --profile web add ./dsh-reverse-proxy-0.1.0.tgz

# 3. Start DeepSeek Harness
dsh --profile web
```

After the package is published to npm, step 2 becomes a one-liner:
`dsh plugin --profile web add dsh-reverse-proxy`. Git installs
(`dsh plugin add github:JUANWANG-BUAA/dsh-remote#<sha>`) work through the
self-contained `prepare` script; pnpm ≥10 users must allow the build with
`allowBuilds: { dsh-reverse-proxy: true }` in the profile workspace.

Open `http://127.0.0.1:3080`. The **反向代理** action sits at the bottom of the
sidebar, directly above Settings. Start the endpoint, copy its local target,
and configure your tunnel:

```sh
# Examples only — the plugin does not run these commands.
cloudflared tunnel --url http://127.0.0.1:3081
ngrok http http://127.0.0.1:3081
ssh -R 8080:127.0.0.1:3081 user@example-host
```

The remote browser receives a token login page before any DeepSeek Harness content.

## Publish on a different IP / port (runtime)

Open the sidebar panel and edit **LISTEN ADDRESS**: set the IP/host and port
(`0` picks a free port), then press **应用发布地址**. The override is written
to the state file, applied immediately (restarting a running proxy), and used
again after DeepSeek Harness restarts. If the new address cannot bind, the plugin rolls
back to the previous working address and reports it in the panel.

Binding a non-loopback address shows a warning in the panel: it exposes the
port directly, so firewall rules must be explicit.

## Separate mobile and desktop profiles

DeepSeek Harness composes Client plugins once per process, not once per browser viewport —
the same process cannot refuse to load a bundle (such as a desktop-only
`@linxin666/dsh-web-ui-all`) for phones while serving it to desktops. A CSS
media query only hides the bundle after loading and running it. The supported
way to give phones a lean UI is a second profile:

```sh
# Desktop: keep the full third-party UI on 127.0.0.1:3080.
dsh --profile web

# Mobile: official web bundle (its npm deps are still unpublished, so install
# it from a source checkout) + this plugin, served separately.
dsh plugin --profile mobile add /path/to/deepseek-harness/packages/bundle/web-app
dsh plugin --profile mobile add ./dsh-reverse-proxy-0.1.0.tgz
dsh --profile mobile --port 3082
```

Configure the tunnel to use the proxy target exposed by the `mobile` profile
(and set that profile's listen port in the panel if you need a fixed value).
Desktop browsers continue using the full `web` profile. This is true code-level
isolation: the desktop bundle is never part of the `mobile` process.

## Configuration

```yaml
- id: reverse-proxy
  name: dsh-reverse-proxy
  config:
    listenHost: 127.0.0.1
    listenPort: 3081
    backendHost: 127.0.0.1
    backendPort: 0
    autoRestore: true
    maxRequestBytes: 16777216
    upstreamTimeoutMs: 15000
    sessionMaxAgeSeconds: 2592000
    cookieName: dsh_reverse_proxy_session
    maxHeaderSizeBytes: 16384
    headersTimeoutMs: 15000
    keepAliveTimeoutMs: 5000
    loginDelayMs: 250
    loginMaxAttempts: 5
    loginLockoutSeconds: 300
    approvalMode: false
    maxSessions: 16
    logRequests: false
    stateFile: ""
```

- `listenHost` / `listenPort` are defaults; the panel can override them at
  runtime and the override persists.
- `backendPort: 0` follows the active `webServer.port`.
- `listenPort: 0` chooses a free port and displays it in the UI.
- `stateFile: ""` uses `$DSH_HOME/reverse-proxy.json`.
- `maxHeaderSizeBytes`, `headersTimeoutMs`, `keepAliveTimeoutMs`, and
  `loginDelayMs` are server-hardening knobs; the defaults are safe and rarely
  need changing.
- `loginMaxAttempts` / `loginLockoutSeconds` rate-limit failed logins per
  remote IP: after `loginMaxAttempts` failures within the window the IP is
  rejected with `429` (and `Retry-After`) until the lockout expires. Users
  behind a shared NAT IP share one bucket — raise the limits if that hurts.
- `approvalMode: true` holds every new device on a waiting page until it is
  approved from the panel (rejected devices never reach DeepSeek Harness).
- `maxSessions` caps concurrent devices; the stalest session is evicted past
  the cap and sessions expire after `sessionMaxAgeSeconds` without activity.
- `logRequests: true` logs every proxied request at debug level; lifecycle
  events (start, stop, token rotation, publish-address changes) are always
  logged at info level.
- Keep `listenHost` on loopback when the tunnel process runs locally. Binding a
  LAN address is an explicit expansion of the attack surface.
- This plugin injects `webServer`, so it only works in Web-serving profiles
  that include the `@deepseek-ai/dsh-web-app` bundle. Do **not** install it
  into a headless profile: the harness fails the whole boot when a row stays
  PENDING, so there is no harmless "inactive" state — the row is either
  active or the boot refuses to start.

## Compatibility

The sidebar entry and panel mount on the `sidebar.footer.action` and
`shell.overlay` slots introduced in client packages `0.1.0-rc.5`.

- Our client peer range is `>=0.1.0-rc.5 <0.2` and resolves on npm today
  (`0.1.0-rc.6` is published for the runtime/layout/sidebar/slots packages).
- The `@deepseek-ai/dsh-web-app` bundle itself is still not installable from
  npm (one of its dependencies, `@deepseek-ai/dsh-client-ui-model`, is
  unpublished), so a fresh `dsh plugin add @deepseek-ai/dsh-web-app` fails.
  Until DeepSeek publishes it, install web-app from the harness source
  checkout, or use a profile that already carries it.
- Rows that cannot activate fail the whole harness boot (strict activation
  gate) — we deliberately keep the loud peer range instead of silently
  mounting nothing on older client packages.

## Development

Dependencies install from npm; the repository is self-contained.

```sh
pnpm install           # from the frozen lockfile
pnpm run check:ci      # lint + typecheck (CI declarations) + tests + build
pnpm run check         # same, but typecheck uses real harness types when a
                       # sibling deepseek-harness checkout exists (tsconfig paths)
pnpm run bootstrap     # optional: clone + build the harness checkout for real types
pnpm pack --dry-run    # inspect the published tarball contents
```

CI runs `check:ci` plus a real-boot smoke job on every push and pull request
(`.github/workflows/ci.yml`). The smoke job installs the bundle through the
community-standard `dsh plugin add` flow and exercises the control surface,
login gate, rate limiter, and index polyfill against a live harness
composition (`scripts/smoke.mjs`).

The package has a Host entry (`lib/index.js`) and an official DeepSeek Harness Client entry
(`lib/client.js`). The browser UI registers only through the official
`sidebar.footer.action` and `shell.overlay` slots. On the standard DeepSeek Harness sidebar
layout the action is promoted to its own full-width row above the other footer
actions — detected by layout, never through private APIs — and any unknown
layout falls back to the slot's native inline button. No private DeepSeek Harness DOM is
written.

## Control API

All endpoints live under `/dsh-reverse-proxy` on the main DeepSeek Harness Web server, are
loopback-only, and are **never** forwarded through the public proxy. Mutations
require the `x-dsh-reverse-proxy-control: 1` header and a loopback `Origin`.

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/dsh-reverse-proxy/status` | — | snapshot (enabled, running, target, backend, listen) |
| `GET` | `/dsh-reverse-proxy/token` | — | `{ accessToken }` |
| `POST` | `/dsh-reverse-proxy/start` | — | snapshot |
| `POST` | `/dsh-reverse-proxy/stop` | — | snapshot |
| `POST` | `/dsh-reverse-proxy/rotate-token` | — | snapshot + new `accessToken` |
| `POST` | `/dsh-reverse-proxy/listen` | `{ "host": "127.0.0.1", "port": 3081 }` | snapshot (port `0` = pick a free port) |
| `GET` | `/dsh-reverse-proxy/sessions` | — | `{ sessions: [{ id, label, status, createdAt, lastSeenAt }] }` |
| `POST` | `/dsh-reverse-proxy/sessions/approve` | `{ "id": "…" }` | `{ "ok": true }` (pending → active) |
| `POST` | `/dsh-reverse-proxy/sessions/revoke` | `{ "id": "…" }` | `{ "ok": true }` (device loses access immediately) |

On the proxy itself, `/dsh-reverse-proxy/healthz` answers `{"ok":true}` and the
login page lives at `/_dsh_reverse_proxy/login`.

## Model Experience

This plugin adds no model-visible prompt, tool, or session content. Token and
proxy status exist only in the human Web control surface, so token and KV-cache
effects are zero.

## Known Limitations and Deferred Work

- The public URL is owned by the chosen tunnel and cannot be discovered by this
  provider-neutral plugin.
- The login cookie cannot always carry `Secure` because TLS usually terminates
  outside the local proxy; deploy the tunnel with HTTPS and protect local
  machine access.
- The proxy strips upstream `set-cookie` and its own session cookie: correct
  for today's DeepSeek Harness Web (loopback trust, no cookies), but a future DeepSeek Harness Web
  feature that depends on browser cookies would need revisiting.
- Failed logins are rate-limited per remote IP (`loginMaxAttempts` then a
  `429` lockout) on top of the fixed per-attempt delay; a 192-bit token makes
  brute force impractical regardless, and rotating the token invalidates all
  sessions. Shared-NAT users share one bucket — see `loginLockoutSeconds`.
- Stopping the proxy destroys both ends of every upgraded WebSocket session:
  remote browsers are disconnected immediately and the proxy's upstream socket
  sends FIN to the backend (verified by the WebSocket teardown test). The
  backend's own upgraded socket may linger briefly until its handler observes
  the FIN, so DeepSeek Harness-side session cleanup follows the backend's own idle policy.
- HTTP/2 terminates at the tunnel or browser edge; the local proxy forwards
  HTTP/1.1, SSE, and WebSocket traffic.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for the
development setup, checks, and conventions.

## Security

Security issues are handled privately — see [SECURITY.md](./SECURITY.md) for
the disclosure process and the supported-versions policy.

## License

[MIT](./LICENSE) © 2026 [JUANWANG-BUAA](https://github.com/JUANWANG-BUAA)
