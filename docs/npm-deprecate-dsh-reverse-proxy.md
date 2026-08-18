# Deprecate the old package name

Completed on 2026-08-18 through the repository's
`.github/workflows/deprecate-legacy.yml` workflow. The command below is the
manual fallback for a maintainer with npm publisher credentials.

```bash
npm login
npm deprecate dsh-reverse-proxy@0.1.0 "Renamed to dsh-full-remote — install with: npm i dsh-full-remote (or dsh plugin add dsh-full-remote). This package is no longer maintained."
npm view dsh-reverse-proxy deprecated
```

Expected: `deprecated` field shows the rename message. Current registry value:
`Renamed to dsh-full-remote; install dsh-full-remote instead.`
