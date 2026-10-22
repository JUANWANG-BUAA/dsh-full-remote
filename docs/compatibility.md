# Compatibility and composition

`dsh-full-remote` is a bundle, not a replacement web application. It expects
the Harness `webServer` and Host `connection` services plus the 0.2 client
packages it declares in `dsh.client.inject` (`dsh-api-session-controller`,
`dsh-client-ui-session`, `dsh-client-ui-workspace`, `dsh-client-ui-approval`,
`dsh-client-ui-user-questions`, `dsh-client-ui-settings`). Its only peer
dependency is `@deepseek-ai/cordis ~4.0.5` — the official 0.2 convention for
client plugins. It is verified against DeepSeek Harness **0.2.1-rc.2** (npm
`next`, the version shipped by DeepSeek Harness Desktop 0.2.1); 0.1.x is no
longer supported (0.2 removed `@deepseek-ai/dsh-client-runtime` and moved
pending interactions into the `uiSession` registry). It is not intended for a
headless profile.

## 0.5.0 scope

The 0.5.0 release adds the selectable cross-session task cockpit and transport
optimizations without changing the Harness **0.2.1-rc.2** target or introducing
a second host connection. The cockpit reuses official pending forms and session
navigation; connected is not proof of synchronization, drafts/locks are page-local,
and reconnect does not replay writes. See [validation and retained host evidence](./cockpit-validation.md).

Eligible HTTP responses negotiate Brotli/gzip; SSE/WebSocket remain streaming and
uncompressed. The bounded server static cache is device-isolated and only admits
eligible hashed assets after authentication/CIDR checks; HTML/API, Set-Cookie, range
and unknown Vary responses are excluded from that cache. Browser caching follows
upstream policy. Revocation/stop clear retained variants, and active bytes update
idle activity without extending absolute TTL. An owned upstream keep-alive pool
does not change session ownership or grant remote management access.
[Benchmark (English)](./performance-benchmark.md) · [中文报告](./performance-benchmark.zh.md).

## DeepSeek Harness 0.2.1

0.2.1 adds method-level Remote access control
([`dsh-api-remote-access`](https://www.npmjs.com/package/@deepseek-ai/dsh-api-remote-access)).
The Host Gateway now asks a per-Peer policy before it dispatches a non-owner
Remote call or forwards an event, and the Client publishes the answers as
`useRemoteAccess` / `useSessionAccess` / `useWorkspaceAccess` hooks. Three
consequences for this plugin:

1. **No policy to register.** A `Principal` is fixed when the Peer is created,
   and the only principal kind the base composition declares is `owner`. A
   browser that reaches Harness through this proxy is created as an owner Peer
   — the same reason the index tap pins `connection.isLoopback` — so the
   deny-by-default path never applies to remote devices. Bundles that register
   a policy for a non-owner kind keep working beside this plugin.
2. **Slots stay compatible.** `settings.section` and `shell.overlay` are
   unchanged. 0.2.1 adds the optional `inline` slot flag and the
   `(key, member)` form of keyed sources; neither changes a registration that
   omits them.
3. **`ui-workspace` moved its toast contract.** `RowToastProps` now renders
   `workspace.toast` instead of taking the archived-filter store, and the
   session menu gained a `session-id` row at `order: 450`. This plugin owns its
   own toast (`PanelToast`) and registers no workspace row, so it is unaffected
   — but a plugin that extended the shipped toast must port to the keyed
   dispatcher.

## Installation order

Install the normal Harness web bundle first, then this plugin. The shipped
`cordis.patch.yml` is applied as a later layer and:

- inserts the `reverse-proxy` host row;
- conditionally disables the adaptive `directory-picker` row;
- pins Harness's in-app directory browser at runtime when the official
  `directory-picker-browse` / `ui-directory-picker-browse` rows are not
  already present, so remote “Add workspace” does not open a desktop dialog.

The default is remote-safe browse mode. Set
`DSH_FULL_REMOTE_USE_NATIVE_PICKER=1` before boot to skip that pin and keep
the Harness adaptive/native picker for a host-only deployment. Do not
combine that opt-out with a remote directory-browsing requirement.

If another plugin also inserts `reverse-proxy`, inspect the final profile
composition. Do not add a second row with that id. Bundles that already
insert `directory-picker-browse` (for example `deepseek-harness-auth`) can
be installed together with this plugin; this layer will not insert those
ids again. The runtime pin looks at `loader.entries()` across nested
Include trees, not only the loader root store.

## Known composition constraints

| Component | Interaction | Safe approach |
|---|---|---|
| `dsh-web-mobile` or another mobile layout | CSS/layout ownership may overlap; the remote interaction overlay is independent | Install both, keep one owner for global layout, and verify the directory drawer and settings section |
| Native/adaptive `directory-picker` | Disabled by default; opt-out is explicit | Keep the in-app browse pair enabled for remote use |
| `deepseek-harness-auth` (or another bundle that inserts `directory-picker-browse`) | Both need the in-app picker; a second insert of the same row id fails boot | This plugin does not insert those ids; it pins browse at runtime only when they are absent from the whole loader tree |
| Another reverse proxy/auth gateway | A second gateway can rewrite `Host`/`Origin` or cookies twice | Put this plugin directly in front of Harness Web, or disable the duplicate rewrite/auth layer |
| TLS terminator / tunnel | Forwarded headers are trusted only when explicitly configured | Set `trustForwardedFor` only behind a loopback edge that strips/rebuilds those headers; set `trustCloudflareConnectingIp` only for a real Cloudflare edge |
| Cloudflare (or other) edge compression | The edge may already gzip/brotli HTML/JS/CSS/JSON | Proxy-side Brotli/gzip can help LAN/SSH/frp; do not expect a second large byte saving at a compressing edge. Proxy cache hits still avoid upstream work. See [HTTP transport](./http-gzip.md) and [benchmark](./performance-benchmark.md) |
| Plugin that changes Harness trust/bootstrap globals | The browser bootstrap is a compatibility seam | Test `settings.describe`, `credentials.describe`, directory browsing, SSE, and WebSocket after installing both |

## Runtime acceptance checks

After composing plugins, verify all of the following through the proxy:

1. unauthenticated `GET /` redirects to the login gate;
2. authenticated `settings.describe` returns a non-fence response (not the
   Harness loopback 403);
3. authenticated credentials and directory operations work;
4. a long-running SSE response and WebSocket upgrade survive normally
   (the proxy does not compress SSE or WebSocket; a delayed second SSE event
   must still arrive);
5. revoking the device closes its active streams;
6. the host UI still opens its own directory picker when accessed locally;
7. on a non-loopback hostname, Settings → Models shows the provider catalog
   rather than `settings are unavailable in this browser` (0.2 resolves the
   form persistence mode as `ctx.remote.$host.isLoopback ? 'host' : 'memory'`
   during `ui-settings` apply; the index-tap pin of `connection.isLoopback` is
   what keeps it `host` behind this proxy);
8. on a non-loopback hostname, Settings → Models lists
   `DeepSeek-V4-Flash-Vision-Exp`, and a paste/drop of a JPEG/PNG/WebP/GIF
   under the Harness image limits is not 413'd by this proxy.

Harness 0.2 (since 0.1.2) protects the Web index and `/api` with a browser-session cookie.
When the Host Connection service exposes `authenticatedUrl()`, this plugin
performs the local process-token exchange at proxy start and keeps that cookie
internal; the remote device cookie is never forwarded upstream.

Harness Desktop may start its embedded backend with `--skip-auth` and
`DSH_SKIP_AUTH=1`. In that explicit mode the launch URL returns the index with
a successful 2xx response and does not mint a browser-session cookie. The
plugin accepts that cookie-free upstream only while the flag is exactly `1`;
its own access-token and per-device session gate remains active.

## Multimodal / vision

Harness 0.1.1-rc.1 adds `deepseek-v4-flash-vision-exp` to the official
DeepSeek catalog. This plugin does not implement that adapter. It only
forwards the Web `/api` the composer already uses:

| Layer | Limit | Notes |
|---|---|---|
| DeepSeek API | 48 MiB request body; 32 MiB per inline image | Enforced by `api.deepseek.com`, not this proxy |
| DeepSeek adapter | 20 MiB accumulated image bytes per model request | `maxRequestImageBytes` on `llm-deepseek` |
| Harness attachments | 3.5 MiB per image; 100 MiB aggregate per message | Composer pre-check; oversize is an attachment error, not a proxy 413 |
| Harness `/api` bridge | 160 MiB buffered JSON | 100 MiB images after base64 + envelope |
| This proxy | `maxRequestBytes` default **160 MiB** | Must not be tighter than the bridge or remote paste 413s |

`upstreamTimeoutMs` is a TCP-connect timeout to loopback, and for POST (vision
`session.prompt`) also the wait for the first upstream byte after the client
finishes sending. A slow tunnel upload after connect is bounded by
`requestTimeoutMs` (default 5 minutes), not by 15 seconds. GET/HEAD including
SSE never use that post-body wait. Host command POSTs use `commandTimeoutMs`
(default 5 minutes) instead of `upstreamTimeoutMs` for that first-byte wait
because Harness command handlers may legitimately run long before responding
(for example `/compact`). That covers both wire generations: Harness 0.1.2
calls commands on `POST /api/commands/execute`, while Harness 0.1.0/0.1.1
carry the command line as an ordinary `POST /api/session.prompt` whose single
text part starts with `/` — the proxy sniffs that bounded prompt body and
applies the command window only to command-shaped prompts, so ordinary
prompts keep the short hung-backend window.

Raster image responses (`image/png`, `image/jpeg`, `image/webp`,
`image/gif`) are never Brotli/gzip transformed. JSON RPC envelopes may be compressed, but
are not admitted to the server static cache.

The CI real-Harness smoke installs the packed tarball and exercises the first,
second, and session-control paths. `test:composition` checks the effective
Harness Web row IDs and rejects duplicate provider IDs; pass additional patch
files through `EXTRA_PATCHES` when validating another bundle. The browser
smoke mounts the real React settings fixture in Chromium. Run both when
changing the client composition or `cordis.patch.yml`.
