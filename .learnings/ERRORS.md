# Errors

Command failures and integration errors.

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
