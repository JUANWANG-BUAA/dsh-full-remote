# v0.2.5 GitHub Release 正文

只把下面「发布说明」从 `## dsh-full-remote 0.2.5` 起到文末贴进
Release（或由 `gh release create` 使用同一段）。标题用 `v0.2.5`。
不要贴本段说明。链接一律用仓库绝对地址。

---

## dsh-full-remote 0.2.5

Fixes a Cordis Context corruption in the index-tap bootstrap that broke
third-party client plugins such as Better Sidebar (GitHub
[#9](https://github.com/JUANWANG-BUAA/dsh-full-remote/issues/9)). Also
ships tunnel client-IP trust, the in-panel audit viewer, and WebSocket
upgrade audit / rate limiting.

npm：[`dsh-full-remote@0.2.5`](https://www.npmjs.com/package/dsh-full-remote)

### Upgrade

Already installed profiles do **not** pick up a new version when `dsh web`
starts:

```bash
dsh plugin --profile web update dsh-full-remote
```

Then restart `dsh web`. First install remains:

```bash
dsh plugin --profile web add dsh-full-remote
```

### Relative to 0.2.4

- **Fix (GitHub #9):** do not assign `ctx.provide` in the trust bootstrap.
  Pin `connection.isLoopback` on the handle after the official connection
  plugin `apply()` returns (`ctx.get('connection', false)`). Later plugins
  can `provide` and read their own services again.
- Config `trustForwardedFor`: when the direct peer is loopback, use
  `CF-Connecting-IP` or the rightmost `X-Forwarded-For` as the client IP.
- In-panel audit log viewer (filter, limit, JSON export).
- WebSocket upgrade audit events and upgrade rate limiting.
- Configurable `requestTimeoutMs`; audit log reads use a bounded tail
  window.

Full notes: [CHANGELOG](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.2.5/CHANGELOG.md) · [中文 README](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.2.5/README.zh.md) · [English README](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.2.5/README.md)
