# v0.2.4 GitHub Release 正文

只把下面「发布说明」从 `## dsh-full-remote 0.2.4` 起到文末贴进
Release（或由 `gh release create` 使用同一段）。标题用 `v0.2.4`。
不要贴本段说明。链接一律用仓库绝对地址。

---

## dsh-full-remote 0.2.4

npm `0.2.3` 已在仓库无 GitHub tag 的情况下发布。本版把 README 与登录页
对齐现行面板，并说明手机邀请 Origin 必须是扫码设备可达的地址。

npm：[`dsh-full-remote@0.2.4`](https://www.npmjs.com/package/dsh-full-remote)

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

### Relative to 0.2.3

- README: copy the **tunnel target** / reachable URL; binding `0.0.0.0` is
  not a URL to open.
- Phone invite Origin is the host the **scanning device** requests (tunnel
  `https://…` or the panel LAN URL). Do not encode `127.0.0.1` — a phone
  would hit its own loopback.
- Screenshot gallery recaptured; login/wait pages add a `dsh-full-remote`
  kicker.

Full notes: [CHANGELOG](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.2.4/CHANGELOG.md) · [中文 README](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.2.4/README.zh.md) · [English README](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.2.4/README.md)
