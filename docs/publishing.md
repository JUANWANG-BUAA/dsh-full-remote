# Publishing strategy

## Registry reality (checked 2026-08-15)

- `@deepseek-ai/dsh-client-runtime`, `-ui-slots` publish `0.1.0-rc.6` on npm.
- `@deepseek-ai/dsh-web-app@latest` still points at `0.0.1-rc.1`, whose
  dependency `@deepseek-ai/dsh-client-ui-model` was never published.
  **`@deepseek-ai/dsh-web-app@0.1.0-rc.6` (dist-tag `next`) installs
  cleanly** — all 59 of its dependencies resolve. Pin the version;
  do not tell users the bundle is unpublished.
- There is no published `dsh` CLI package.

Consequences for this plugin:

1. Our client peer range (`>=0.1.0-rc.5 <0.2`) resolves on npm today.
2. This plugin does not install or document the official web-app. Default
   `dsh --profile web` already provides `webServer`. Do not add this
   plugin to headless or to a fresh empty profile.
3. The old npm name `dsh-reverse-proxy@0.1.0` stays on the registry until
   `npm deprecate dsh-reverse-proxy "Use dsh-full-remote instead"`.

The web-app dist-tag fact above is recorded so maintainers do not put a
pin of `@deepseek-ai/dsh-web-app` back into this plugin's README. That
package is a different product.

## When to publish

- Publish every tagged release (`v*` → `npm publish --provenance`, the
  Publish workflow) so npm users can pin exact versions.
- Bump the peer range only when the harness publishes rc releases with the
  slot API this plugin uses; keep the range failing loudly rather than
  silently mounting nothing.

## What `dsh plugin add` does (verified)

- `dsh plugin add <npm-package>`: installs into the profile, appends the
  bundle to `dsh.profile.bundles`, activates the patch layer.
- `dsh plugin add <tarball>`: same, no build tooling needed on the target
  machine (`prepare` ran at pack time).
- `dsh plugin add <directory>`: links the directory as-is; **no `prepare`**
  — the directory must already contain built `lib/`.
- `dsh plugin add github:<repo>#<sha>`: installs source and runs `prepare`;
  the script must be self-contained (no monorepo sibling assumptions), and
  pnpm ≥10 users must allow the build with
  `allowBuilds: { dsh-full-remote: true }` in the profile workspace.
- The smoke job must **build the harness first** (`pnpm run build` = lib +
  web): dsh boots host packages and client bundles from `lib/` and the Web
  UI from the frontend dist — a fresh checkout has none of these.
- The harness has a **strict activation gate**: a row that stays PENDING
  (e.g. `webServer` missing in a headless profile) fails the whole boot.

## Post-publish checklist

- [x] Tag `v0.2.0` (rename); `dsh-full-remote@0.2.0` is on npm.
- [x] Tag `v0.2.1`, let CI publish, verify `npm view dsh-full-remote version`.
- [x] Tag `v0.2.2` (README screenshots for Settings → Reverse proxy), let CI publish, verify `npm view dsh-full-remote version`.
- [x] `dsh-full-remote@0.2.3` is on npm (2026-08-16); GitHub `v0.2.3` tag was skipped.
- [x] Tag `v0.2.4` (invite Origin / reachable-URL README, screenshot recapture).
- [x] Tag `v0.2.5` (fix trust-bootstrap `ctx.provide` overwrite, GitHub #9).
- [ ] `npm deprecate dsh-reverse-proxy "Package renamed to dsh-full-remote."` (blocked until `npm login`).
- [x] Apply GitHub topics from `docs/github-metadata.md` (applied 2026-08-16).
- [x] PR the plugin into `awesome-dsh-plugin` as `dsh-full-remote` ([#833](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/833), updated 2026-08-16).
- [ ] Upload social preview (`docs/rp-demo-panel.png`) — manual browser step, no API.
