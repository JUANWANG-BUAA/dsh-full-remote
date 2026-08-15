# dsh-reverse-proxy

[![CI](https://github.com/JUANWANG-BUAA/dsh-remote/actions/workflows/ci.yml/badge.svg)](https://github.com/JUANWANG-BUAA/dsh-remote/actions)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

An installable DeepSeek Harness bundle that creates an authenticated local
reverse-proxy endpoint for the DSh Web UI, plus a sidebar control panel to run
it. It is intentionally independent of Tailscale, frp, ngrok, cloudflared,
WireGuard, SSH, or any other tunnel.

The plugin does not launch or manage tunnel software. Point your tunnel at the
local target shown in the DSh sidebar, for example `http://127.0.0.1:3081`.

## Screenshots

| Sidebar control panel | Remote login gate |
|---|---|
| ![Control panel](./docs/rp-demo-panel.png) | ![Remote login](./docs/rp-demo-login.png) |

## Features

- Authenticated reverse proxy for HTTP, SSE, and WebSocket traffic.
- Sidebar panel: start/stop, status, one-click target copy, token reveal and
  rotation.
- **Runtime listen address**: republish the proxy on any IP/port from the UI
  without editing `cordis.yml`; the choice persists and survives restarts.
  A running proxy restarts on the new address, and a failed bind rolls back
  to the previous working address automatically.
- Persisted state (`0600`) with atomic writes; `autoRestore` re-enables the
  proxy after a DSh restart.
- Mobile-ready login page and viewport injection.

## Security model

DSh normally trusts its loopback Web endpoint. A generic tunnel can be public,
so merely rewriting `Host` would expose that trusted API. This plugin places an
authentication gate before the proxy:

- a 192-bit access token is generated locally and stored with mode `0600`;
- remote browsers exchange the token for an HttpOnly, SameSite session cookie
  derived from the token (no second credential is stored);
- failed logins cost a fixed delay, slowing token guessing;
- DSh control routes are never forwarded through the proxy;
- start, stop, token reveal, rotation, and listen changes require a direct
  loopback request with a CSRF-resistant control header and loopback Origin;
- spoofable forwarding and hop-by-hop headers are removed before forwarding;
- the proxy's own session cookie never reaches the backend, and upstream
  `set-cookie` is stripped (the backend cannot establish cookies with remote
  browsers anyway);
- request bodies are size-limited on the stream itself, so chunked uploads
  cannot bypass the declared limit.

Keep the token secret. Use HTTPS on the public side of your tunnel.

## Install

**npm** (recommended once published):

```sh
dsh plugin --profile web add dsh-reverse-proxy
```

**Tarball** (no build tooling needed on the target machine):

```sh
pnpm pack
dsh plugin --profile web add ./dsh-reverse-proxy-0.1.0.tgz
```

**From a checkout directory / git URL**: this repo keeps the DSh type packages
as `link:` devDependencies pointing at a sibling
`../deepseek-harness` checkout, so directory and git installs must run on a
machine with that layout. Publish to npm or install the tarball for portable
distribution.

```sh
pnpm dsh plugin --profile web add /absolute/path/to/dsh-remote
pnpm dsh --profile web --dump-config
pnpm dsh --profile web
```

Open `http://127.0.0.1:3080`. The **反向代理** action sits at the bottom of the
sidebar, directly above Settings. Start the endpoint, copy its local target,
and configure your tunnel:

```sh
# Examples only — the plugin does not run these commands.
cloudflared tunnel --url http://127.0.0.1:3081
ngrok http http://127.0.0.1:3081
ssh -R 8080:127.0.0.1:3081 user@example-host
```

The remote browser receives a token login page before any DSh content.

## Publish on a different IP / port (runtime)

Open the sidebar panel and edit **LISTEN ADDRESS**: set the IP/host and port
(`0` picks a free port), then press **应用发布地址**. The override is written
to the state file, applied immediately (restarting a running proxy), and used
again after DSh restarts. If the new address cannot bind, the plugin rolls
back to the previous working address and reports it in the panel.

Binding a non-loopback address shows a warning in the panel: it exposes the
port directly, so firewall rules must be explicit.

## Separate mobile and desktop profiles

DSh composes Client plugins once per process, not once per browser viewport —
the same process cannot refuse to load a bundle (such as a desktop-only
`@linxin666/dsh-web-ui-all`) for phones while serving it to desktops. A CSS
media query only hides the bundle after loading and running it. The supported
way to give phones a lean UI is a second profile:

```sh
# Desktop: keep the full third-party UI on 127.0.0.1:3080.
dsh --profile web

# Mobile: install only the official web bundle + this plugin, serve separately.
dsh plugin --profile mobile add /path/to/deepseek-harness/packages/bundle/web-app
dsh plugin --profile mobile add /path/to/dsh-remote
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
- `logRequests: true` logs every proxied request at debug level; lifecycle
  events (start, stop, token rotation, publish-address changes) are always
  logged at info level.
- Keep `listenHost` on loopback when the tunnel process runs locally. Binding a
  LAN address is an explicit expansion of the attack surface.
- This plugin injects `webServer`, so install it into Web-serving profiles
  only; in a headless profile the row stays PENDING.

## Compatibility

The sidebar entry and panel mount on the `sidebar.footer.action` and
`shell.overlay` slots introduced in client packages `0.1.0-rc.5` (the current
run-from-source checkout). The npm registry still only carries `0.0.1-rc.1`,
which predates both slots — on it the peer range fails loudly instead of
silently mounting nothing. Until DeepSeek publishes newer client packages,
install from a source checkout (the `link:` devDependencies intentionally pin
development to that checkout).

## Development

First-time contributors: the devDependencies pin the DSh type packages to a
sibling `../deepseek-harness` checkout, so clone and build like this:

```sh
pnpm run bootstrap   # clones deepseek-harness at the pinned commit if missing, then installs
pnpm run check
pnpm run build
pnpm pack --dry-run
```

CI runs the same `check` pipeline on every push and pull request
(`.github/workflows/ci.yml`).

The package has a Host entry (`lib/index.js`) and an official DSh Client entry
(`lib/client.js`). The browser UI registers only through
`sidebar.footer.action` and `shell.overlay`; it does not patch private DSh DOM.

## Control API

All endpoints live under `/dsh-reverse-proxy` on the main DSh Web server, are
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
  for today's DSh Web (loopback trust, no cookies), but a future DSh Web
  feature that depends on browser cookies would need revisiting.
- Login is not rate-limited beyond a fixed per-attempt delay; a 192-bit token
  makes brute force impractical, and rotating the token invalidates sessions.
- Stopping the proxy does not tear down already-upgraded WebSocket sessions on
  the backend: Node does not propagate a client-side socket destroy after
  upgrade, so those sessions follow the backend's own idle policy.
- HTTP/2 terminates at the tunnel or browser edge; the local proxy forwards
  HTTP/1.1, SSE, and WebSocket traffic.
