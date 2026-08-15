# dsh-reverse-proxy

An installable DeepSeek Harness bundle that creates an authenticated local
reverse-proxy endpoint for the DSh Web UI, plus a sidebar control panel to run
it. It is intentionally independent of Tailscale, frp, ngrok, cloudflared,
WireGuard, SSH, or any other tunnel.

The plugin does not launch or manage tunnel software. Point your tunnel at the
local target shown in the DSh sidebar, for example `http://127.0.0.1:3081`.

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
    stateFile: ""
```

- `listenHost` / `listenPort` are defaults; the panel can override them at
  runtime and the override persists.
- `backendPort: 0` follows the active `webServer.port`.
- `listenPort: 0` chooses a free port and displays it in the UI.
- `stateFile: ""` uses `$DSH_HOME/reverse-proxy.json`.
- Keep `listenHost` on loopback when the tunnel process runs locally. Binding a
  LAN address is an explicit expansion of the attack surface.
- This plugin injects `webServer`, so install it into Web-serving profiles
  only; in a headless profile the row stays PENDING.

## Development

```sh
pnpm install
pnpm run check
pnpm run build
pnpm pack --dry-run
```

The package has a Host entry (`lib/index.js`) and an official DSh Client entry
(`lib/client.js`). The browser UI registers only through
`sidebar.footer.action` and `shell.overlay`; it does not patch private DSh DOM.

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
- HTTP/2 terminates at the tunnel or browser edge; the local proxy forwards
  HTTP/1.1, SSE, and WebSocket traffic.
