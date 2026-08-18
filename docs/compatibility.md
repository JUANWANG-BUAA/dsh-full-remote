# Compatibility and composition

`dsh-full-remote` is a bundle, not a replacement web application. It expects
the Harness `webServer` service and the published client runtime/UI-slots
packages in the supported peer range (`0.1.0-rc.5` through `<0.2`). It is not
intended for a headless profile.

## Installation order

Install the normal Harness web bundle first, then this plugin. The shipped
`cordis.patch.yml` is applied as a later layer and:

- inserts the `reverse-proxy` host row;
- disables the native `directory-picker` row;
- inserts the in-app directory browser pair so remote “Add workspace” does
  not open a desktop dialog.

If another plugin also patches any of those rows, inspect the final profile
composition. Do not add a second row with id `reverse-proxy`,
`directory-picker-browse`, or `ui-directory-picker-browse`.

## Known composition constraints

| Component | Interaction | Safe approach |
|---|---|---|
| `dsh-web-mobile` or another mobile layout | CSS/layout ownership may overlap; the remote interaction overlay is independent | Install both, keep one owner for global layout, and verify the directory drawer and settings section |
| Native `directory-picker` | The patch disables it intentionally | Keep the in-app browse pair enabled for remote use |
| Another reverse proxy/auth gateway | A second gateway can rewrite `Host`/`Origin` or cookies twice | Put this plugin directly in front of Harness Web, or disable the duplicate rewrite/auth layer |
| TLS terminator / tunnel | Forwarded headers are trusted only when explicitly configured | Set `trustForwardedFor` only behind a loopback edge that strips/rebuilds those headers; set `trustCloudflareConnectingIp` only for a real Cloudflare edge |
| Plugin that changes Harness trust/bootstrap globals | The browser bootstrap is a compatibility seam | Test `settings.describe`, `credentials.describe`, directory browsing, SSE, and WebSocket after installing both |

## Runtime acceptance checks

After composing plugins, verify all of the following through the proxy:

1. unauthenticated `GET /` redirects to the login gate;
2. authenticated `settings.describe` returns a non-fence response (not the
   Harness loopback 403);
3. authenticated credentials and directory operations work;
4. a long-running SSE response and WebSocket upgrade survive normally;
5. revoking the device closes its active streams;
6. the host UI still opens its own directory picker when accessed locally.

The CI real-Harness smoke installs the packed tarball and exercises the first,
second, and session-control paths. Run the browser fixture when changing the
client composition or `cordis.patch.yml`.
