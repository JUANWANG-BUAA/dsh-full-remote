# Errors

Command failures and integration errors.

---

## [ERR-20260904-001] pnpm-lockfile-dsh-client-rc1

**Logged**: 2026-09-04T00:00:00+08:00
**Priority**: high
**Status**: resolved
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

Run the audit through `scripts/audit-prod.mjs`, which preserves vulnerability
failures but bounds registry retries and continues with an explicit warning
when npm's advisory service is unavailable.

### Metadata

- Reproducible: yes (local and GitHub Actions)
- Related Files: package.json, scripts/audit-prod.mjs, pnpm-lock.yaml

---

## [ERR-20260904-005] ci-windows-cache-name

**Logged**: 2026-09-04T00:00:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary

The Windows Node 24 CI job failed because the tunnel download test expected
the POSIX cache filename `cloudflared`, while the implementation correctly
uses `cloudflared.exe` on Windows.

### Error

```text
ENOENT: no such file or directory, open ...\\bin\\cloudflared
```

### Suggested Fix

Derive the expected cache filename from `process.platform` in the test and
reuse it for failure and successful-install assertions.

### Metadata

- Reproducible: yes
- Related Files: tests/tunnel.test.ts

---

## [ERR-20260904-006] ci-browser-copy-drift

**Logged**: 2026-09-04T00:00:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary

The browser smoke scripts asserted an older Chinese self-check message after
the client copy was clarified.

### Error

```text
locator.waitFor: Timeout 30000ms exceeded
waiting for getByText('特权栅栏已打通') to be visible
```

### Suggested Fix

Keep browser and screenshot smoke assertions aligned with the localized UI
copy (`本机特权通道已打开`).

### Metadata

- Reproducible: yes
- Related Files: scripts/browser-smoke.mjs, scripts/capture-screenshots.ts

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

## [ERR-20260909-001] release-auth-and-canary

**Logged**: 2026-09-09
**Priority**: medium
**Status**: pending
**Area**: infra

### Summary
The previous npm publish failed with HTTP 404; the local npm identity check returns 401. GitHub authentication alone does not authorize npm publication. GitHub Release can carry the verified tarball independently.

The weekly canary also failed because it hard-coded upstream `main` while the actual default branch is `master`. Fixed by allowing checkout to resolve the upstream default branch.

### Suggested Action
Restore npm publishing credentials or trusted-publisher configuration before claiming npm availability. Verify the registry after publishing. Discover workflow filenames before reading them (`publish.yml`, not `release.yml`).

---

## [ERR-20260916-001] apply-patch-context-drift

**Logged**: 2026-09-16T10:30:00+08:00
**Priority**: low
**Status**: resolved
**Area**: docs

### Summary

A multi-file patch was rejected because a README sentence was wrapped
differently from the assumed context. No files were changed.

### Error

```text
apply_patch verification failed: Failed to find expected lines in README.md
```

### Suggested Fix

Inspect the exact nearby text before patching prose, and split broad patches
into smaller groups so a documentation context mismatch does not block code
changes.

### Metadata

- Reproducible: yes
- Related Files: README.md

---

## [ERR-20260916-002] node26-localstorage-shadow

**Logged**: 2026-09-16T18:30:00+08:00
**Priority**: medium
**Status**: pending
**Area**: tests

### Summary

The client suite fails under local Node 26 because Node's experimental global
`localStorage` is unavailable without `--localstorage-file` and shadows the
jsdom storage object expected by the tests. The release workflow uses Node 22.

### Error

```text
ExperimentalWarning: localStorage is not available because --localstorage-file was not provided
TypeError: Cannot read properties of undefined (reading 'clear')
```

### Suggested Fix

Run release verification with the workflow's Node 22 runtime. Separately,
harden the Vitest setup so jsdom's storage globals win on Node 26, or narrow
the supported engine range until that compatibility is covered.

### Metadata

- Reproducible: yes
- Related Files: tests/remote.client.test.tsx, tests/interaction.client.test.tsx, vitest.config.ts

---

## [ERR-20260916-003] ignored-tracked-add-exit

**Logged**: 2026-09-16T18:35:00+08:00
**Priority**: low
**Status**: resolved
**Area**: config

### Summary

`git add` staged the tracked `.learnings/ERRORS.md` file but returned a
non-zero status because the directory now matches an ignore rule, preventing
the chained commit from running.

### Suggested Fix

Verify the index after this warning, then use `git add -f` for the tracked
learning file before committing.

### Metadata

- Reproducible: yes
- Related Files: .gitignore, .learnings/ERRORS.md

---

## [ERR-20260916-004] npm-login-interrupt-exit-handler

**Logged**: 2026-09-16T18:35:00+08:00
**Priority**: low
**Status**: resolved
**Area**: infra

### Summary

Interrupting a waiting `npm login --auth-type=web` session exited without
publishing, but npm also reported that its exit handler was never called.

### Error

```text
npm error Exit handler never called!
```

### Context

The user chose a GitHub-only release while the CLI was waiting for browser
authentication, so the login process was cancelled. No publish command ran.

### Suggested Fix

Start npm authentication only when registry publication is explicitly in
scope. After cancellation, verify that no publish command ran and treat the
message as an upstream npm CLI shutdown bug.

### Metadata

- Reproducible: unknown
- Related Files: .github/workflows/publish.yml, docs/publishing.md

---

## [ERR-20260916-005] release-doc-patch-context-drift

**Logged**: 2026-09-16T18:36:00+08:00
**Priority**: low
**Status**: resolved
**Area**: docs

### Summary

A multi-file release patch failed because a release-note paragraph was stored
on one line instead of the assumed wrapped form. No files were changed.

### Suggested Fix

Inspect exact prose context and patch release documents independently.

### Metadata

- Reproducible: yes
- Related Files: docs/release-0.3.12.md
- See Also: ERR-20260916-001

---

## [ERR-20260916-006] shell-backticks-in-search-pattern

**Logged**: 2026-09-16T18:36:00+08:00
**Priority**: low
**Status**: resolved
**Area**: infra

### Summary

Backticks inside a double-quoted search expression were evaluated by the
shell as command substitution before `rg` ran.

### Error

```text
zsh: command not found: v0.3.12
```

### Suggested Fix

Use single-quoted search patterns whenever Markdown code spans are included.

### Metadata

- Reproducible: yes
- Related Files: docs/publishing.md

---

## [ERR-20260916-007] workflow-linter-unavailable

**Logged**: 2026-09-16T18:37:00+08:00
**Priority**: low
**Status**: resolved
**Area**: infra

### Summary

Neither `actionlint` nor a project-local `prettier` executable was available
for validating the release workflow.

### Error

```text
[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command "prettier" not found
```

### Suggested Fix

Use an installed YAML parser for syntax validation and rely on GitHub's own
workflow parsing after push. Add `actionlint` only if workflow linting becomes
a recurring maintenance need.

### Metadata

- Reproducible: yes
- Related Files: .github/workflows/publish.yml

---

## [ERR-20260916-008] gh-release-json-field-variance

**Logged**: 2026-09-16T19:08:00+08:00
**Priority**: low
**Status**: resolved
**Area**: infra

### Summary

The installed `gh` version rejected `url` for `gh release list` and
`isLatest` for `gh release view`, even though related release commands expose
other URL and status fields.

### Error

```text
Unknown JSON field: "url"
Unknown JSON field: "isLatest"
```

### Suggested Fix

Use `gh release view --json url` for a release URL and omit `isLatest`; inspect
the command's reported field list before composing cross-command JSON queries.

### Metadata

- Reproducible: yes
- Related Files: docs/release-0.3.12.md

---

## [ERR-20260916-009] gh-api-form-field-switches-method

**Logged**: 2026-09-16T19:24:00+08:00
**Priority**: low
**Status**: resolved
**Area**: infra

### Summary

Using `gh api -f ref=main` without an explicit method changed a repository
content read into a POST request and returned 404.

### Error

```text
gh: Not Found (HTTP 404)
```

### Suggested Fix

Use `gh api -X GET ... -f ref=main` when passing query parameters to a
read-only GitHub API request.

### Metadata

- Reproducible: yes
- Related Files: README.md, README.zh.md

---
