# Errors

Command failures and integration errors.

---

## [ERR-20260904-001] pnpm-lockfile-dsh-client-rc1

**Logged**: 2026-09-04T00:00:00+08:00
**Priority**: high
**Status**: pending
**Area**: infra

### Summary

The latest Harness CLI release candidate is published before matching client
runtime/UI package artifacts.

### Error

```text
[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for
@deepseek-ai/dsh-client-runtime@0.1.2-rc.1
```

### Context

`pnpm install --lockfile-only --no-frozen-lockfile` was run while updating the
plugin to Harness `0.1.2-rc.1`. npm exposes the CLI on the `next` channel, but
`@deepseek-ai/dsh-client-runtime` has no `0.1.2-rc.1` artifact and its `next`
dist-tag remains on `0.1.1-rc.2`.

### Suggested Fix

Use the published `0.1.1-rc.2` client runtime/UI artifacts for the plugin's
client build while pinning the real-boot Harness smoke to the `0.1.2-rc.1`
source tag. Re-check package dist-tags before each release.

### Metadata

- Reproducible: yes
- Related Files: package.json, pnpm-lock.yaml, .github/workflows/ci.yml
- See Also: ERR-20260818-001

---

## [ERR-20260904-002] pnpm-peer-dsh-invariants-rc1

**Logged**: 2026-09-04T00:00:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: infra

### Summary

The 0.1.2 client connection package requires a prerelease invariant peer that
pnpm cannot infer from the peer range alone.

### Error

```text
[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for
@deepseek-ai/dsh-invariants@>=0.1.2 <0.2.0-0
```

### Context

Adding `@deepseek-ai/dsh-client-connection@0.1.2-rc.1` to the development
tree caused pnpm to resolve the peer range without considering the published
`0.1.2-rc.1` prerelease.

### Suggested Fix

Pin `@deepseek-ai/dsh-invariants@0.1.2-rc.1` as a development dependency so
the package graph is explicit and the lockfile can be generated.

### Metadata

- Reproducible: yes
- Related Files: package.json, pnpm-lock.yaml

---

## [ERR-20260904-003] pnpm-peer-cordis-402-subplugins

**Logged**: 2026-09-04T00:00:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: infra

### Summary

Upgrading Cordis to the version required by the Harness 0.1.2 connection
package left two transitive Cordis peers one patch release behind.

### Error

```text
@deepseek-ai/cordis-plugin-include@1.0.6 is unmet; required ^1.0.7
@deepseek-ai/cordis-plugin-loader@1.0.2 is unmet; required ^1.0.3
```

### Suggested Fix

Pin the matching published peer packages as development dependencies and
regenerate the pnpm lockfile.

### Metadata

- Reproducible: yes
- Related Files: package.json, pnpm-lock.yaml

---

## [ERR-20260904-004] npm-audit-advisory-timeout

**Logged**: 2026-09-04T00:00:00+08:00
**Priority**: low
**Status**: pending
**Area**: infra

### Summary

The production dependency audit could not reach npm's bulk advisory endpoint
after repeated retries.

### Error

```text
POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk error (23)
```

### Context

All package metadata and install operations succeeded; only the advisory API
timed out during `pnpm audit --prod --audit-level moderate`.

### Suggested Fix

Retry the audit from CI or a network path that can reach the npm advisory API.

### Metadata

- Reproducible: unknown
- Related Files: package.json, pnpm-lock.yaml

---

## [ERR-20260818-001] github-discussion-rest-comment

**Logged**: 2026-08-18T18:50:00+08:00
**Priority**: low
**Status**: resolved (intentionally not retried)
**Area**: infra

### Summary

REST comment creation for a GitHub Discussion returned 404.

### Error

```text
gh: Not Found (HTTP 404)
```

### Context

Attempted one controlled release announcement on DeepSeek Harness Discussion #76. Existing issue/release operations through `gh` worked; only the Discussions REST subresource was unavailable.

### Suggested Fix

Use a verified GraphQL `addDiscussionComment` mutation in a future run, or omit the extra announcement. No repository or release state was changed by the failed request.

### Metadata

- Reproducible: unknown
- Related Files: docs/github-metadata.md

---
