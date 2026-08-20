# Compatibility and composition

`dsh-full-remote` is a bundle, not a replacement web application. It expects
the Harness `webServer` service and the published client runtime/UI-slots
packages in the supported peer range (`0.1.0-rc.5` through `<0.2`). It is not
intended for a headless profile.

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
ids again.

## Known composition constraints

| Component | Interaction | Safe approach |
|---|---|---|
| `dsh-web-mobile` or another mobile layout | CSS/layout ownership may overlap; the remote interaction overlay is independent | Install both, keep one owner for global layout, and verify the directory drawer and settings section |
| Native/adaptive `directory-picker` | Disabled by default; opt-out is explicit | Keep the in-app browse pair enabled for remote use |
| `deepseek-harness-auth` (or another bundle that inserts `directory-picker-browse`) | Both need the in-app picker; a second insert of the same row id fails boot | This plugin does not insert those ids; it pins browse at runtime only when they are absent |
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
6. the host UI still opens its own directory picker when accessed locally.

The CI real-Harness smoke installs the packed tarball and exercises the first,
second, and session-control paths. `test:composition` checks the effective
Harness Web row IDs and rejects duplicate provider IDs; pass additional patch
files through `EXTRA_PATCHES` when validating another bundle. The browser
smoke mounts the real React settings fixture in Chromium. Run both when
changing the client composition or `cordis.patch.yml`.
