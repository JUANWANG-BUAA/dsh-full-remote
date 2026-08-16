# Deprecate the old package name (requires a valid npm login as maintainer)

```bash
npm login
npm deprecate dsh-reverse-proxy@0.1.0 "Renamed to dsh-full-remote — install with: npm i dsh-full-remote (or dsh plugin add dsh-full-remote). This package is no longer maintained."
npm view dsh-reverse-proxy deprecated
```

Expected: `deprecated` field shows the rename message.
