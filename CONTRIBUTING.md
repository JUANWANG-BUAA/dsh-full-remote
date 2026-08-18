# Contributing

Thanks for your interest in dsh-full-remote! It is a small,
single-purpose [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
bundle, so most changes are small and self-contained.

## Getting started

Dependencies install from npm — no special layout is required.

- `pnpm install` (frozen lockfile) + `pnpm run check:ci` works anywhere and
  resolves the published Harness client declarations from `node_modules`.
- `pnpm run bootstrap` (optional) clones a pinned DeepSeek Harness checkout
  next to this repo for real-boot integration work; it is not required for
  typechecking.

## Checks

```sh
pnpm run check       # lint + typecheck + tests + build
pnpm run check:ci    # same CI-oriented gates using published client types
pnpm run audit:prod  # production dependency audit
```

Host sources are fully type-annotated and compiled with `noImplicitAny`
enabled. Keep new parameters and fields typed rather than adding `any`.

CI runs `pnpm run check:ci` on every push and pull request, plus a real-boot
smoke job (`scripts/smoke.mjs`) that installs the packed npm tarball through
`dsh plugin add` and exercises it against a live harness composition.

## Tests

- `tests/*.test.ts` — unit/integration tests via `node:test` (run as plain
  TypeScript through `node --experimental-strip-types`; proxy behavior,
  security primitives, control surface, Cordis lifecycle, WebSocket upgrade,
  index bootstrap).
- `tests/remote.client.test.tsx` — client UI tests via `vitest` +
  Testing Library (settings section, toasts, i18n, settings persistence).

Add or update tests for every behavior change.

## Commit messages

Follow the repo's existing style: short imperative summary lines in Chinese
or English describing the change, e.g. `修复 …` / `Add …`.

## Pull requests

1. Fork, branch, change, test (`pnpm run check` green locally).
2. Update `README.md` / `README.zh.md` and `CHANGELOG.md` when behavior,
   configuration, or docs change.
3. Keep the two READMEs in sync — they are translations of each other.
4. Do not commit build outputs (`lib/`), tarballs, or secrets.
5. If you touch `src/client`, compile against the published client-runtime
   declarations and add a fixture/test for any changed wire contract.

## Release notes

Unreleased changes go under an Unreleased heading of `CHANGELOG.md`
until the next version is cut. The current release is `0.3.3`.
