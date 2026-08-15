# Publishing strategy

## Registry reality (checked 2026-08)

- `@deepseek-ai/dsh-client-runtime`, `-ui-layout`, `-ui-sidebar`,
  `-ui-slots`, `-typert-registry`, `-scope` publish `0.1.0-rc.6` on npm.
- The `@deepseek-ai/dsh-web-app` bundle itself is NOT installable from npm
  yet: one of its dependencies (`@deepseek-ai/dsh-client-ui-model`) is missing
  from the registry, so `dsh plugin add @deepseek-ai/dsh-web-app` fails.
- There is no published `dsh` CLI package.

Consequences for this plugin:

1. Our client peer range (`>=0.1.0-rc.5 <0.2`) resolves on npm today.
2. Our bundle is installable from npm **only** into profiles that already get
   `webServer` from somewhere — i.e. a `@deepseek-ai/dsh-web-app` installed
   from the harness source checkout (see the README install section).
3. Until web-app is npm-installable, publishing to npm still makes sense
   (versioned distribution + tarball consumers + `dsh plugin add` from npm for
   users with a checkout-based web profile), but the README must keep the
   checkout-path instructions front and center.

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
- `dsh plugin add <directory>`: links the directory as-is; **no `prepare`** —
  the directory must already contain built `lib/`.
- `dsh plugin add github:<repo>#<sha>`: installs source and runs `prepare`;
  the script must be self-contained (no monorepo sibling assumptions), and
  pnpm ≥10 users must allow the build with
  `allowBuilds: { dsh-reverse-proxy: true }` in the profile workspace.
- The harness has a **strict activation gate**: a row that stays PENDING
  (e.g. `webServer` missing in a headless profile) fails the whole boot.
  Installing into a headless profile is therefore not supported — the plugin
  requires a Web-serving profile.

## Post-publish checklist

- [ ] Tag `v0.1.0`, let CI publish, verify `npm view dsh-reverse-proxy`.
- [ ] PR the plugin into `awesome-dsh-plugin` and the dsh-market index.
- [ ] Apply the GitHub metadata from `docs/github-metadata.md`.
