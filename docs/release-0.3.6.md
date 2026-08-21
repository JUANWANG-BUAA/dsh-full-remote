# v0.3.6 GitHub Release 正文

只把下面「发布说明」从 `## dsh-full-remote 0.3.6` 起到文末贴进
Release（或由 `gh release create` 使用同一段）。标题用 `v0.3.6`。
不要贴本段说明。链接一律用仓库绝对地址。

---

## dsh-full-remote 0.3.6

Remote Settings → Models works again on DeepSeek Harness 0.1.0-rc.8.

npm：[`dsh-full-remote@0.3.6`](https://www.npmjs.com/package/dsh-full-remote)

### Upgrade

Already installed profiles do **not** pick up a new version when `dsh web`
starts:

```bash
dsh plugin --profile web update --latest dsh-full-remote
```

Then restart `dsh web`. A bare `update dsh-full-remote` does **not** move
an exact pin such as `0.3.5`. First install remains:

```bash
dsh plugin --profile web add dsh-full-remote
```

### Relative to 0.3.5

- **Fix #13**: on Harness `0.1.0-rc.8`, remote Settings → Models no longer
  fails with `加载提供方目录失败: settings are unavailable in this browser`.
  That release's HTML queue facade `create()` replaces
  `__ModuleLoader__.load`; the page bootstrap now traps that assignment
  (and re-traps after `create()`) so `connection.isLoopback` is still
  pinned before official settings bind.
- CI real-boot smoke and contributor bootstrap pin Harness `0.1.0-rc.8`.
  Client peer range remains `>=0.1.0-rc.5 <0.2`.

Full notes: [CHANGELOG](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.3.6/CHANGELOG.md) · [中文 README](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.3.6/README.zh.md) · [English README](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.3.6/README.md)
