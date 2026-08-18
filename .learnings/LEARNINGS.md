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
