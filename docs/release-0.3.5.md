# v0.3.5 GitHub Release 正文

只把下面「发布说明」从 `## dsh-full-remote 0.3.5` 起到文末贴进
Release（或由 `gh release create` 使用同一段）。标题用 `v0.3.5`。
不要贴本段说明。链接一律用仓库绝对地址。

---

## dsh-full-remote 0.3.5

HTTP gzip and hashed-asset cache on the authenticated reverse proxy, plus a
boot fix when this plugin is installed next to `deepseek-harness-auth`.

npm：[`dsh-full-remote@0.3.5`](https://www.npmjs.com/package/dsh-full-remote)

### Upgrade

Already installed profiles do **not** pick up a new version when `dsh web`
starts:

```bash
dsh plugin --profile web update --latest dsh-full-remote
```

Then restart `dsh web`. A bare `update dsh-full-remote` does **not** move
an exact pin such as `0.3.4`. First install remains:

```bash
dsh plugin --profile web add dsh-full-remote
```

### Relative to 0.3.4

- **HTTP gzip** on compressible proxied responses (`Accept-Encoding: gzip`).
  SSE, WebSocket, fonts, already-encoded bodies, plugin gate pages, and
  responses under 1 KB are skipped. Measured first-load shell
  (`index.html` + hashed index/vendor JS/CSS, gzip 6,
  `@deepseek-ai/dsh-web-frontend@0.1.0-rc.6`): **1 285 699 → 350 802 bytes
  (−72.7%)**. Issue #11's “95%+” is not a general result. Disable with
  `compressResponses: false`. Contract:
  [HTTP gzip](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.3.5/docs/http-gzip.md).
- **Hashed `/assets/*` cache header**
  (`Cache-Control: public, max-age=31536000, immutable`) on 200s that have
  no upstream cache header. `index.html` and `/api` are never cached.
  Disable with `cacheHashedAssets: false`.
- **Coexist with `deepseek-harness-auth`**: this layer no longer inserts
  `directory-picker-browse` / `ui-directory-picker-browse`. It pins those
  official packages at runtime only when the ids are absent from the whole
  loader tree, including nested Include subtrees (#12).

Full notes: [CHANGELOG](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.3.5/CHANGELOG.md) · [中文 README](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.3.5/README.zh.md) · [English README](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.3.5/README.md)
