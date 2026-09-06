# v0.3.10 GitHub Release 正文

只把下面「发布说明」从 `## dsh-full-remote 0.3.10` 起到文末贴进
Release（或由 `gh release create` 使用同一段）。标题用 `v0.3.10`。
不要贴本段说明。链接一律用仓库绝对地址。

---

## dsh-full-remote 0.3.10

`/compact` and other host commands now work through the proxy on DeepSeek
Harness 0.1.0/0.1.1 (#25).

npm：[`dsh-full-remote@0.3.10`](https://www.npmjs.com/package/dsh-full-remote)

### What was wrong

On Harness 0.1.0/0.1.1 the composer has no dedicated command route: it sends
`/compact` as an ordinary `POST /api/session.prompt` whose single text part
starts with `/`, and the backend only answers after the command handler
finishes (compaction runs a model call). The proxy's first-byte window for
that path was the default 15s `upstreamTimeoutMs`, so the proxy destroyed
the upstream and answered `502 bad gateway` — while the same command on the
local `127.0.0.1` window worked. The 0.3.8 `commandTimeoutMs` fix matched
only `/api/commands/execute`, which is the Harness 0.1.2 wire form and never
appears on 0.1.0/0.1.1.

### What changed

- The proxy passively inspects the (bounded, 64 KiB) `session.prompt` /
`session/prompt` request body and applies `commandTimeoutMs` (default
5 minutes) when the body is command-shaped: exactly one text part starting
with `/`, mirroring Harness's own admission rule.
- Ordinary prompts, image uploads, and every other RPC keep the short
hung-backend window; a parse miss or an oversized body simply keeps the
normal `upstreamTimeoutMs`. Nothing is rejected based on the sniff.
- `/api/commands/execute` (Harness 0.1.2) behavior is unchanged.

### Upgrade

Already installed profiles do **not** pick up a new version when `dsh web`
starts:

```bash
dsh plugin --profile web update --latest dsh-full-remote
```

Then restart `dsh web`. A bare `update dsh-full-remote` does **not** move
an exact pin such as `0.3.9`. First install remains:

```bash
dsh plugin --profile web add dsh-full-remote
```

Full notes: [CHANGELOG](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.3.10/CHANGELOG.md) · [中文 README](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.3.10/README.zh.md) · [English README](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.3.10/README.md)
