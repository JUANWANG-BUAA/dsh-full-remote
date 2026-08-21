# HTTP gzip 与带 hash 静态资源缓存

对应 GitHub issue
[#11](https://github.com/JUANWANG-BUAA/dsh-full-remote/issues/11)。
本文是代理「压什么、不压什么、允许引用哪些体积数字」的约定。
**不是**「95%+」压缩率承诺，也不覆盖 WebSocket 流畅度。

英文版：[HTTP gzip](./http-gzip.md)。

## 范围

鉴权通过后，反向代理可以对从 Harness Web **转发的 HTTP 响应**做 gzip，
并给 **带内容 hash** 的 `/assets/*` 加上长期缓存头。

**不压缩**：

- WebSocket 升级（101；代理是原始字节管道）
- `text/event-stream`（SSE 必须保持实时事件流）
- 字体（Harness 把 `.ttf` / `.woff` / `.woff2` 标成
  `application/octet-stream`）
- 点阵图（`image/png` / `image/jpeg` / `image/webp` / `image/gif`，视觉附件下载）
- 已经带非 identity `Content-Encoding` 的响应
- `HEAD` / `CONNECT`，以及状态 `204` / `206` / `304`
- `Content-Length` 存在且小于 1024 字节的响应
- 插件栅栏页（`sendHtml`：登录 / 等待 / 主页）

`index.html` 与 `/api` **永远不会**拿到那条 hashed-asset 缓存头。

## 配置

| 选项 | 默认 | 作用 |
|---|---|---|
| `compressResponses` | `true` | 客户端声明 `Accept-Encoding: gzip`（q > 0）时压缩可压缩类型 |
| `cacheHashedAssets` | `true` | 对无上游 `Cache-Control` 的 hashed `/assets/*` 200 响应设置 `Cache-Control: public, max-age=31536000, immutable` |

在 `reverse-proxy` 行里把对应项设为 `false` 即可关闭。

## 实测（2026-08-20）

夹具：`@deepseek-ai/dsh-web-frontend@0.1.0-rc.6` 的 `dist`，gzip level 6，
经本代理。复测：

```sh
node --experimental-strip-types --test tests/compress-matrix.test.ts
```

若没有 Homebrew 全局路径，设置 `DSH_WEB_FRONTEND_DIST`。

### 首屏（`index.html` + 带 hash 的 index/vendor JS 与 CSS）

**1,285,699 → 350,802 字节（−72.7%）。** 远程打开 Harness 壳层时，引用这个数字。

| 文件 | 原始 | 线上 | 节省 |
|---|---:|---:|---:|
| `vendor-*.js` | 744,872 | 180,729 | −75.7% |
| `index-*.js` | 442,711 | 149,984 | −66.1% |
| `index-*.css` | 67,798 | 11,357 | −83.2% |
| `vendor-*.css` | 29,642 | 8,056 | −72.8% |
| `index.html` | 676 | 676 | 跳过（&lt; 1 KB） |

### 全部 89 个 dist 文件

**4,621,051 → 1,707,217（−63.1%）。** 低于首屏，是因为 59 个字体文件
（约 1.07 MB）线上不压。

| 种类 | 文件数 | 已 gzip | 线上节省 |
|---|---:|---:|---:|
| `.js` | 25 | 25 | −82.2% |
| `.css` | 2 | 2 | −80.1% |
| `.svg`（`/favicon.svg`） | 1 | 1 | −51.9% |
| 字体（ttf/woff/woff2） | 59 | 0 | 0% |
| `index.html` / `manifest.webmanifest` | 2 | 0 | 不足 1 KB |

86 个 hashed `/assets/*` 响应带了 `immutable`。没有加上的三个：
`/index.html`、`/favicon.svg`、`/manifest.webmanifest`。

语言包例如 `langs/cpp-*.js` 可以压到约 −92%。这是真的，但不是首屏路径，
不能当产品宣传数字。

### 为什么不用「95%+」当产品数字

`tests/compress-matrix.test.ts` 里有一段重复填充的 JSON。1024 字节及以上
可以压到 −96% 甚至更高。12 字节的小 JSON **会变大**（12 → 32）。
issue #11 的「95%+」对应的是这种高冗余填充，不是 Harness UI 载荷，
因此不是验收标准。

### 栅栏页（当前不压）

实际发出的登录 HTML：2413 字节，无 `Content-Encoding`。
`gzipSync` 潜在 −47.7%（约 1.2 KB）。等待页 / 主页类似。
故意不压：首屏 JS/CSS 能省几百 KB；栅栏页大约 1 KB。

### Cloudflare 快速隧道

Cloudflare 边缘通常已经压缩 HTML/JS/CSS/JSON。代理侧 gzip 主要惠及
局域网、SSH、frp 这些本身不压缩的路径。对话流式输出走 WebSocket，不变。

## 测试

- `tests/compress.test.ts` — 判定函数、SSE 延迟第二条事件、跳过字体 /
  过小 JSON / 已编码响应、真实 `vendor-*.js`
- `tests/compress-matrix.test.ts` — 每个 dist 文件走一遍代理；找不到
  frontend dist 时跳过

## 发布状态

随 `dsh-full-remote@0.3.5` 发布。该版本上 npm 后再关闭 issue #11。
