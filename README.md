# dsh-reverse-proxy

An installable DeepSeek Harness bundle that creates an authenticated local
reverse-proxy endpoint for the DSh Web UI. It is intentionally independent of
Tailscale, frp, ngrok, cloudflared, WireGuard, SSH, or any other tunnel.

The plugin does not launch or manage tunnel software. Point your tunnel at the
local target shown in the DSh sidebar, for example `http://127.0.0.1:3081`.

## Security model

DSh normally trusts its loopback Web endpoint. A generic tunnel can be public,
so merely rewriting `Host` would expose that trusted API. This plugin places an
authentication gate before the proxy:

- a 192-bit access token is generated locally and stored with mode `0600`;
- remote browsers exchange the token for an HttpOnly, SameSite session cookie;
- DSh control routes are never forwarded through the proxy;
- start, stop, token reveal, and token rotation require a direct loopback
  request with a CSRF-resistant control header and loopback Origin;
- spoofable forwarding and hop-by-hop headers are removed before forwarding.

Keep the token secret. Use HTTPS on the public side of your tunnel.

## Install

From a DeepSeek Harness checkout:

```sh
pnpm dsh plugin --profile web add /absolute/path/to/dsh-remote
pnpm dsh --profile web --dump-config
pnpm dsh --profile web
```

Open `http://127.0.0.1:3080`. The **Reverse proxy** action appears at the
bottom of the sidebar. Start the endpoint, copy its local target, and configure
your tunnel:

```sh
# Examples only — the plugin does not run these commands.
cloudflared tunnel --url http://127.0.0.1:3081
ngrok http http://127.0.0.1:3081
ssh -R 8080:127.0.0.1:3081 user@example-host
```

The remote browser receives a token login page before any DSh content.

## Separate mobile and desktop profiles

DSh composes Client plugins once per process, not once per browser viewport.
Therefore a desktop-only bundle such as `@linxin666/dsh-web-ui-all` cannot be
safely unloaded only for phones on the same URL. Use two profiles when the
desktop bundle does not have a usable narrow layout:

```sh
# Desktop: keep the full third-party UI on 127.0.0.1:3080.
dsh --profile web

# Mobile: install only dsh-web-app + this bundle, then serve separately.
dsh plugin --profile mobile add /path/to/deepseek-harness/packages/bundle/web-app
dsh plugin --profile mobile add /path/to/dsh-remote
dsh --profile mobile --port 3082
```

Configure the tunnel to use the proxy target exposed by the `mobile` profile.
Desktop browsers continue using the full `web` profile. This is true code-level
isolation; a CSS media query would only hide the desktop bundle after loading
and running it.

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
```

- `backendPort: 0` follows the active `webServer.port`.
- `listenPort: 0` chooses a free port and displays it in the UI.
- `stateFile: ""` uses `$DSH_HOME/reverse-proxy.json`.
- Keep `listenHost` on loopback when the tunnel process runs locally. Binding a
  LAN address is an explicit expansion of the attack surface.

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
- HTTP/2 terminates at the tunnel or browser edge; the local proxy forwards
  HTTP/1.1, SSE, and WebSocket traffic.
