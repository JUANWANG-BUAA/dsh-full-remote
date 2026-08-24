# Compatibility and composition

`dsh-full-remote` is a bundle, not a replacement web application. It expects
the Harness `webServer` service and the published client runtime/UI-slots
packages in the supported peer range (`0.1.0-rc.5` through `<0.2`). It is
verified against DeepSeek Harness **0.1.1-rc.1** and **0.1.1-rc.2** (these
are the npm dist-tags `latest` and `next`). It is not intended for a headless
profile.

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
| Cloudflare (or other) edge compression | The edge may already gzip/brotli HTML/JS/CSS/JSON | Proxy-side gzip still helps LAN/SSH/frp; do not expect a second large saving on a Cloudflare quick tunnel. See [HTTP gzip](./http-gzip.md) |
| Plugin that changes Harness trust/bootstrap globals | The browser bootstrap is a compatibility seam | Test `settings.describe`, `credentials.describe`, directory browsing, SSE, and WebSocket after installing both |

## Runtime acceptance checks

After composing plugins, verify all of the following through the proxy:

1. unauthenticated `GET /` redirects to the login gate;
2. authenticated `settings.describe` returns a non-fence response (not the
   Harness loopback 403);
3. authenticated credentials and directory operations work;
4. a long-running SSE response and WebSocket upgrade survive normally
   (the proxy does not gzip SSE or WebSocket; a delayed second SSE event
   must still arrive);
5. revoking the device closes its active streams;
6. the host UI still opens its own directory picker when accessed locally;
7. on a non-loopback hostname, Settings → Models shows the provider catalog
   rather than `settings are unavailable in this browser` (Harness 0.1.0-rc.8
   describe-mirror, still required on 0.1.1-rc.1/0.1.1-rc.2);
8. on a non-loopback hostname, Settings → Models lists
   `DeepSeek-V4-Flash-Vision-Exp`, and a paste/drop of a JPEG/PNG/WebP/GIF
   under the Harness image limits is not 413'd by this proxy.

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
SSE never use that post-body wait. Host command POSTs such as
`/api/commands/execute` use `commandTimeoutMs` (default 5 minutes) instead of
`upstreamTimeoutMs` for that first-byte wait because Harness command handlers
may legitimately run long before responding (for example `/compact`).

Raster image responses (`image/png`, `image/jpeg`, `image/webp`,
`image/gif`) are never gzipped. JSON RPC envelopes still may be.

The CI real-Harness smoke installs the packed tarball and exercises the first,
second, and session-control paths. `test:composition` checks the effective
Harness Web row IDs and rejects duplicate provider IDs; pass additional patch
files through `EXTRA_PATCHES` when validating another bundle. The browser
smoke mounts the real React settings fixture in Chromium. Run both when
changing the client composition or `cordis.patch.yml`.
