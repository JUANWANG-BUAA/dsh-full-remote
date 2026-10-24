# Publishing strategy

## 0.5.0 release procedure (2026-10-22)

- Release 0.5.0 combines the mobile Task cockpit, authenticated static-variant
  cache, Brotli/gzip negotiation, idle-activity fixes and repeatable benchmark.
  [Release notes](./releases/v0.5.0.md) and [benchmark](./performance-benchmark.md)
  cover positive results, negative controls and measurement limits.
- Run lint, both typechecks, 303 unit/server and 127 client tests, build,
  coverage, composition and production audit before packaging. A passing audit
  wrapper may report a registry timeout; inspect its output rather than calling
  a skipped registry result a vulnerability-free audit.
- Build and pack dsh-full-remote-0.5.0.tgz. Verify its manifest version, bundled
  lib files, named documentation and absence of output, credentials and fixtures.
- Commit to main, push main, create immutable v0.5.0 at that commit and push the
  tag. Tag push triggers Publish npm; GitHub Release publication is a separate
  step and must not be described as proof of registry publication.
- Attach the built tarball, SHA256SUMS, and versioned benchmark JSON evidence
  (also retained in docs/benchmarks/v0.5.0/) to the GitHub Release. Published
  source does not need a user's local ignored output directory to audit results.
- Verify release asset digest and tag SHA, GitHub workflow conclusion, and
  npm view dsh-full-remote@0.5.0 version independently. If registry publication
  fails, the verified GitHub tarball remains the supported install path; do not
  move tags or silently claim npm success. Credential repair requires the owner.

## Registry reality (checked 2026-10-24)

- `@deepseek-ai/dsh` publishes `0.2.1-rc.3` on dist-tag `next` and
  `0.2.1-rc.2` on `latest`; DeepSeek Harness Desktop 0.2.1 bundles the
  `next` build. This plugin is verified against `0.2.1-rc.3`.
- npm `latest` for `dsh-full-remote` is still `0.3.7`. Every publish since
  `v0.3.8` failed at the final `npm publish` step with
  `404 Not Found - PUT https://registry.npmjs.org/dsh-full-remote` — npm's
  observed registry response to the configured publishing identity. This is
  consistent with a missing/expired/insufficient credential or package access;
  the error alone does not prove the exact token defect. The repository secret
  metadata is still dated 2026-08-15. A local npm credential is separate and
  must not be assumed to repair GitHub Actions. Fix/verify publishing permission
  before retrying a failed immutable release tag.

## Older notes (2026-09-16)

- `@deepseek-ai/dsh` publishes `0.1.1-rc.1` on dist-tags `latest` and
  `next`.
- `@deepseek-ai/dsh-client-runtime` and `-ui-slots` publish matching
  `0.1.1-rc.1` builds (`next`; npm `latest` on those packages may still
  lag). This plugin's peer range (`>=0.1.0-rc.5 <0.2`) accepts them.
- `@deepseek-ai/dsh-web-app@latest` historically lagged; do not tell
  users to install that package. Default `dsh --profile web` already
  provides `webServer`.
- The npm `latest` tag still points to `dsh-full-remote@0.3.7`; releases
  `0.3.8` through `0.3.11` were tagged on GitHub but their npm publish jobs
  failed because the configured npm credential no longer had publish access.
- The legacy `dsh-reverse-proxy@0.1.0` package is deprecated and points users
  to `dsh-full-remote`.

Consequences for this plugin:

1. Our client peer range (`>=0.1.0-rc.5 <0.2`) resolves on npm today.
2. This plugin does not install or document the official web-app. Default
   `dsh --profile web` already provides `webServer`. Do not add this
   plugin to headless or to a fresh empty profile.
3. The old npm name remains on the registry for install-time guidance, but its
   deprecation notice directs users to `dsh-full-remote`.

The web-app dist-tag fact above is recorded so maintainers do not put a
pin of `@deepseek-ai/dsh-web-app` back into this plugin's README. That
package is a different product.

## When to publish

- Pushing a `v*` tag publishes to npm: `.github/workflows/publish.yml` runs on
  the tag and refuses any ref whose name is not exactly
  `v$(package.json version)` or whose commit is not reachable from `main`.
  Creating a GitHub Release and uploading its tarball is separate from npm
  publication; verify both explicitly.
- If a tag's publish fails, fix the cause and re-run the workflow manually on
  that tag (`gh workflow run publish.yml --ref v0.5.0`) — the tag is never
  moved and the provenance statement still names it.
- Since 2026-08-24 every publish has failed on a stale credential: `NPM_TOKEN`
  was last refreshed 2026-08-15, and the registry answers
  `404 Not Found - PUT https://registry.npmjs.org/dsh-full-remote`. npm returns
  404 (not 403) when the token cannot publish the package, so a 404 here means
  "replace the secret", not "the package is gone". Use a Granular Access Token
  for the `juanwang` account with read-and-write access and 2FA bypass, then
  `gh secret set NPM_TOKEN`.
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
- [x] Tag `v0.3.0` (forwarded-IP spoofing fix, device source IPs, audit rotation).
- [x] Tag `v0.3.1` (one-click Cloudflare quick tunnel, device home, invite retry reuse).
- [x] Tag `v0.3.2` (security hardening, production audit command, and real Harness smoke coverage).
- [x] Tag `v0.3.3` (durable-state rollback, real client contracts, tarball smoke, and compatibility hardening); published 2026-08-18.
- [x] Tag `v0.3.4` (CI/security hardening follow-up); published 2026-08-18.
- [x] Tag `v0.3.5` (HTTP gzip + hashed-asset cache, coexist with `deepseek-harness-auth` browse rows).
- [x] Tag `v0.3.6` (Harness 0.1.0-rc.8 ModuleLoader wrap + remote Models settings #13); published 2026-08-21.
- [x] Tag `v0.3.7` (Harness 0.1.1-rc.1 vision body cap, timeouts, multiline overlay); published 2026-08-21.
- [ ] Verify the v0.5.0 tag-triggered npm publish separately from the GitHub
  Release: confirm the workflow conclusion and npm view dsh-full-remote@0.5.0
  version. If a credential repair is needed, rerun the same tag without moving it.
- [x] Deprecate `dsh-reverse-proxy@0.1.0`; verified with `npm view dsh-reverse-proxy deprecated` on 2026-08-18.
- [x] Apply GitHub topics from `docs/github-metadata.md` (applied 2026-08-16).
- [x] PR the plugin into `awesome-dsh-plugin` as `dsh-full-remote` ([#833](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/833), updated 2026-08-16).
- [ ] Upload social preview (`docs/rp-demo-panel.png`) — manual browser step, no API.
