# HTTP 压缩、静态缓存与会话活动 — 0.5.0

[English](./http-gzip.md) · [0.5.0 发布说明](./releases/v0.5.0.md) · [Benchmark 报告](./performance-benchmark.zh.md)

本文定义 **0.5.0 正式版**的传输约定。旧版已经有 gzip；本版新增协商 Brotli、受限的设备私有静态复用、按真实字节更新会话活动与可见性感知轮询。不承诺「95%+」产品压缩率，也不据此宣称 WebSocket 输出更快。

## 1. 配置

反向代理的现有开关保持不变：

| 选项 | 默认 | 0.5.0 行为 |
|---|---|---|
| `compressResponses` | `true` | 为符合条件的 HTTP 响应协商 Brotli quality 4 / gzip level 6 |
| `cacheHashedAssets` | `true` | 严格准入的 hashed 资产使用 private immutable 浏览器缓存及有界、设备隔离的已编码缓存 |

在 `reverse-proxy` 行将对应项设为 `false` 即可关闭。**历史区的 public 缓存策略不再是当前配置行为。**

## 2. 压缩与流式边界

认证通过后，转发的 HTTP 响应按严格的 `Accept-Encoding` q 值协商编码。Brotli 与 gzip 同权重时优先 Brotli；客户端显式更偏好 identity 时不压。Brotli Q4 不保证比 gzip L6 小。

同时遵守请求与响应的 `Cache-Control: no-transform`，保留上游已有编码。协商包含 identity 变体时也合并 `Vary: Accept-Encoding`；变换后弱化强 ETag，移除失效的长度与内容摘要元数据。

**不压缩**：

- WebSocket 升级（101，保持原始字节管道）、SSE（`text/event-stream`）及 Range 响应；
- 字体、点阵图及其他不可压缩类型；
- 已有非 identity `Content-Encoding` 的响应；
- `HEAD` / `CONNECT`，以及 204 / 206 / 304 状态；
- 已知 `Content-Length` 小于 1024 字节的响应；
- 插件栅栏页（登录 / 等待 / 主页）。

SSE 与 WebSocket 保持实时流，不注入保活消息，不自动重放写请求。代理侧压缩不能直接证明 Cloudflare 边缘、移动网络或整个页面的加速。

## 3. 静态缓存：私有、有界、先认证

### 浏览器缓存

仅对严格路径与 MIME 准入的内容 hash `/assets/*`，且上游既没有缓存策略也没有 `Expires` 时，生成 `Cache-Control: private, max-age=31536000, immutable`。不会覆盖 `no-store`、`no-cache`、`must-revalidate` 等上游约束，不会仅凭带 hash 文件名给 HTML、`Set-Cookie` 或未知 `Vary` 长期缓存。

新鲜浏览器缓存可省去整个网络请求，并非每次打开都产生 304。撤销设备不能远程擦除浏览器私有缓存中已下载的静态资产；新的网络请求仍须认证。

### 代理内已编码 variant 缓存

- 认证后的设备隔离 LRU：**总计 8 MiB / 128 项**，每项含 headers/key **不超过 1 MiB**，新鲜期**最多五分钟**。
- 上游 `max-age`、`Age`、`Date`、`Expires` 与生成耗时可缩短新鲜期；命中时 `Age` 正确递增。
- key 含设备身份、完整 URL 与 `Accept-Encoding`，不跨设备复用。
- 不准入 HTML、动态 API/聊天、请求体、Range、`Authorization`、敏感 query、`Set-Cookie` 或未知 `Vary`。最多并发八个有界捕获，不为捕获而阻塞传输。
- 每次命中前都检查设备认证与 CIDR；撤销、令牌轮换、停止代理清理相应缓存。
- 同设备/编码的新鲜命中免回源、免重复编码；ETag / Last-Modified 条件命中可返回无主体 304。主体 0 B 不等于整个 HTTP 响应 0 B，响应头仍有成本。

## 4. 连接、会话活动与轮询

代理自有上游 keep-alive 连接池上限为 **64/源、128 总连接、八个空闲连接**，停止时销毁。这不表示旧版 Node 从未复用连接。

实际 HTTP 上下行与 WebSocket 字节更新设备活动；socket 仍打开本身不续期。持久化通知限频一秒；活动不能延长绝对 TTL，也不能跨凭据 reissue/revoke/hydrate 代次。静默租约每秒检查，失效后双端关闭。不承诺断线事件无损恢复或写操作重放。

设置页 hidden 时暂停设备/隧道轮询，visible 时立即拉取一次，慢请求按方法 single-flight。控制台自动恢复至少间隔五秒合并，手动可立即刷新但共用同一 flight。控制台只读观察宿主连接；通道 connected **不等于会话业务快照已同步**。

## 5. 0.5.0 实测与限制

### 主体体积，不是通用产品压缩率

| 数据 | 原始 | gzip L6 | Brotli Q4 |
|---|---:|---:|---:|
| 高重复传输夹具 | 17,100 B | 138 B | 57 B |
| 本机真实 `vendor-CCJJTK99.js` | 740,575 B | 178,527 B | 178,714 B |

高重复夹具不代表真实前端；真实 vendor 文件使用 Brotli Q4 反而略**大**。

### 配对本地 HTTP benchmark

[完整报告](./performance-benchmark.zh.md)比较未经改写的 Git 基线 `0d4b48c8837ac4b11f3c477b1c04bde46c75f5d6`（**已有 gzip L6**）与随 0.5.0 发布的实现。使用真实 frontend 资源，**15 个计入统计的配对轮次，另有两轮排除的预热**；loopback HTTP/1.1，不含浏览器渲染、TLS、隧道或移动网络。下表时间是每轮串行请求「发出至完整读完」耗时之和的中位数，不是页面加载时间。

| 场景 | 旧基线 | 0.5.0 | 如何理解 |
|---|---:|---:|---|
| 冷设备 HTML + 四个入口资源，主体 | 415,637 B | 415,534 B | 仅少 103 B / 0.025% |
| 40 次热静态请求，回源次数 | 40 | 0 | 同设备/编码；下游仍收到约 4.15 MB |
| 40 次热静态请求，累计 HTTP 时间 | 424.68 ms | 28.15 ms | 本地代理场景 −93.4%，不是整个产品快这么多 |
| 40 次条件响应，完整下行 HTTP 字节 | 6,360 B | 9,800 B | 额外响应头使其 **+54.1%**；两版主体本来均为 0 B |
| 十次合成 JSON API，累计 HTTP 时间 | 8.82 ms | 10.25 ms | **+16.2%**，不是实际聊天 API 样本 |
| 冷设备 gzip-only 对照，累计 HTTP 时间 | 42.08 ms | 44.20 ms | **约 +5.0%**；本版协商 Brotli 为 25.61 ms |

真实 React 组件的模拟时钟测试中，隐藏 60 秒的轮询由 50 RPC 降至零，普通可见仍为 50。这是应用层行为，不是实测省电 100%。报告另行区分确定性会话行为与真实墙钟耐久，并列明尚未测量的 CPU/RSS、生产并发及手机 LCP/INP。

## 6. 可复现覆盖

- `tests/encoding.test.ts`：协商与变换边界。
- `tests/static-cache.test.ts`：准入、隔离、受限新鲜期与条件请求。
- `tests/transport.test.ts` / `tests/stream-activity.test.ts`：传输与活动/过期行为。
- 客户端 visibility-polling / cockpit-connection 测试：后台暂停与恢复行为。
- `tests/compress.test.ts` / `tests/compress-matrix.test.ts`：压缩判定与真实前端资源（缺少 dist 时 matrix 跳过）。

复现命令和精确来源见 benchmark 报告。固定的 [0.5.0 汇总](./benchmarks/v0.5.0/summary.json)与原始 JSON 归档于 `docs/benchmarks/v0.5.0`；复现仍写入忽略目录 `output/benchmarks`。发布 0.5.0 不表示重新运行了 benchmark。

## 7. 历史归档 — 0.3.5 gzip 基线（非 0.5.0 策略）

以下保留早期 [issue #11](https://github.com/JUANWANG-BUAA/dsh-full-remote/issues/11) 测量。**0.3.5 已有 gzip L6**，曾对没有上游 `Cache-Control` 的 hashed asset 200 生成 `Cache-Control: public, max-age=31536000, immutable`。这一历史 public 策略已由第 1–3 节严格 private 策略替代。历史资源集合与 0.5.0 benchmark 不同，不可用绝对大小直接推导版本收益。

### 历史实测（2026-08-20）

夹具：`@deepseek-ai/dsh-web-frontend@0.1.0-rc.6` 的 `dist`，gzip level 6，
经本代理。复测：

```sh
node --experimental-strip-types --test tests/compress-matrix.test.ts
```

若没有 Homebrew 全局路径，设置 `DSH_WEB_FRONTEND_DIST`。

#### 首屏（`index.html` + 带 hash 的 index/vendor JS 与 CSS）

**1,285,699 → 350,802 字节（−72.7%）。** 这是 0.3.5 壳层的历史主体大小，不是 0.5.0 新增收益，也不是浏览器首屏时间。

| 文件 | 原始 | 线上 | 节省 |
|---|---:|---:|---:|
| `vendor-*.js` | 744,872 | 180,729 | −75.7% |
| `index-*.js` | 442,711 | 149,984 | −66.1% |
| `index-*.css` | 67,798 | 11,357 | −83.2% |
| `vendor-*.css` | 29,642 | 8,056 | −72.8% |
| `index.html` | 676 | 676 | 跳过（&lt; 1 KB） |

#### 全部 89 个 dist 文件

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

#### 为什么不用「95%+」当产品数字

`tests/compress-matrix.test.ts` 里有一段重复填充的 JSON。1024 字节及以上
可以压到 −96% 甚至更高。12 字节的小 JSON **会变大**（12 → 32）。
issue #11 的「95%+」对应的是这种高冗余填充，不是 Harness UI 载荷，
因此不是验收标准。

#### 历史栅栏页测量（未压缩）

实际发出的登录 HTML：2413 字节，无 `Content-Encoding`。
`gzipSync` 潜在 −47.7%（约 1.2 KB）。等待页 / 主页类似。
故意不压：首屏 JS/CSS 能省几百 KB；栅栏页大约 1 KB。

#### Cloudflare 快速隧道

Cloudflare 边缘通常已经压缩 HTML/JS/CSS/JSON。代理侧 gzip 主要惠及
局域网、SSH、frp 这些本身不压缩的路径。对话流式输出走 WebSocket，不变。
