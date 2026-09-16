# Learnings

Corrections, insights, and knowledge gaps captured during development.

**Categories**: correction | insight | knowledge_gap | best_practice

---

## [LRN-20260818-001] best_practice

**Logged**: 2026-08-18T18:50:00+08:00
**Priority**: medium
**Status**: pending
**Area**: infra

### Summary

GitHub Discussions comments require the Discussions GraphQL API rather than the ordinary REST issue-style endpoint.

### Details

`gh api -X POST repos/deepseek-ai/deepseek-harness/discussions/76/comments` returned 404 even though the discussion is visible and the repository is public. Do not retry this endpoint blindly; use GraphQL only when an explicitly controlled announcement is needed.

### Suggested Action

Keep promotion limited to the repository About metadata, release notes, and existing community listing unless GraphQL permissions and mutation shape are verified first.

### Metadata

- Source: error
- Related Files: docs/github-metadata.md
- Tags: github, discussions, promotion

---

## [LRN-20260821-001] correction

**Logged**: 2026-08-21T06:45:00Z
**Priority**: high
**Status**: pending
**Area**: config

### Summary
Harness 适配与 issue 修复只改本插件；不要改官方 deepseek-harness 源码。

### Details
用户明确要求不要改动官方源码。CI 通过 pin 上游 commit / 使用已发布 npm 包验证即可。本地 sibling checkout 上已有无关脏文件，不得在适配任务中编辑、提交或还原它们。

### Suggested Action
验证与复现一律用隔离 `$DSH_HOME` + `@deepseek-ai/dsh@0.1.0-rc.8` npm CLI；不要 `git checkout` / patch 官方仓库。

### Metadata
- Source: user_feedback
- Related Files: .github/workflows/ci.yml, scripts/bootstrap.mjs
- Tags: harness, official-source

---

## [LRN-20260916-001] correction

**Logged**: 2026-09-16T19:20:00+08:00
**Priority**: high
**Status**: resolved
**Area**: docs

### Summary

A GitHub-only release is not documented correctly if README badges and primary
install commands still resolve to the older npm registry version.

### Details

The README contained some `0.3.12` examples, but its prominent version badge,
quick start, installation, and upgrade paths still used npm. Because npm
remained at `0.3.7`, the repository landing page appeared stale and its primary
commands installed the wrong version.

### Suggested Action

Before publishing a GitHub-only release, audit both READMEs end to end: visible
version badge, current-version text, quick start, installation, upgrade, and
distribution wording must all point to the GitHub tarball. Verify the rendered
tagged README, not just a search hit for the new version.

### Metadata

- Source: user_feedback
- Related Files: README.md, README.zh.md, docs/release-0.3.12.md
- Tags: release, readme, version, github, npm

---
