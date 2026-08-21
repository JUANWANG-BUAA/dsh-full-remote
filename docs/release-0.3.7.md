# v0.3.7 GitHub Release 正文

只把下面「发布说明」从 `## dsh-full-remote 0.3.7` 起到文末贴进
Release（或由 `gh release create` 使用同一段）。标题用 `v0.3.7`。
不要贴本段说明。链接一律用仓库绝对地址。

---

## dsh-full-remote 0.3.7

Remote vision paste/drop and multiline `ask_user_question` answers work
through the proxy on DeepSeek Harness 0.1.1-rc.1.

npm：[`dsh-full-remote@0.3.7`](https://www.npmjs.com/package/dsh-full-remote)

### Upgrade

Already installed profiles do **not** pick up a new version when `dsh web`
starts:

```bash
dsh plugin --profile web update --latest dsh-full-remote
```

Then restart `dsh web`. A bare `update dsh-full-remote` does **not** move
an exact pin such as `0.3.6`. First install remains:

```bash
dsh plugin --profile web add dsh-full-remote
```

If `cordis.yml` pins `maxRequestBytes` to 16 MiB, raise or remove that
override so remote image RPCs are not 413'd before Harness.

### Relative to 0.3.6

- Verified against Harness **0.1.1-rc.1**. Client typecheck pins
  `@deepseek-ai/dsh-client-runtime` / `-ui-slots` `0.1.1-rc.1`; the peer
  range remains `>=0.1.0-rc.5 <0.2`.
- Default `maxRequestBytes` is **160 MiB**, matching the Harness `/api`
  bridge (100 MiB aggregate images after base64). The previous 16 MiB
  default 413'd remote `session.prompt` bodies used by
  `deepseek-v4-flash-vision-exp`.
- Default `requestTimeoutMs` is **5 minutes**. `upstreamTimeoutMs` is a
  TCP-connect deadline and, for POST, a first-byte wait after the client
  finishes sending — slow tunnel uploads are not killed; hung backends
  still 502. GET/HEAD (SSE) do not use that post-body wait.
- Remote `ask_user_question` custom answers use a wrapping textarea;
  `Shift+Enter` inserts a newline.
- Per-image 3.5 MiB / 100 MiB per message remain Harness attachment
  limits, not this proxy.

Full notes: [CHANGELOG](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.3.7/CHANGELOG.md) · [中文 README](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.3.7/README.zh.md) · [English README](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.3.7/README.md)
