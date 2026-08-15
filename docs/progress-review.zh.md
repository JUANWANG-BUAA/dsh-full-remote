# dsh-full-remote · 0.2.0 落地复盘与下一步

内部工作文档，不随 npm tarball 分发。对照 `docs/roadmap.zh.md`（下文称「原计划」）验收，不改代码。

> **0.2.1 已覆盖本文「客户端半边」结论。** 2026-08-15 夜间：index tap 包装 `__ModuleLoader__`，让 `connection.isLoopback` 在官方 bind 之前为 true（设置落盘）；bundle patch 禁用 `directory-picker-auto` 并钉 browse 对（手机加工作区）；控制面迁到 `settings.section`。下文 §0.4、§1.4「拒绝猴子补丁」、§2 客户端半边、验收清单里「设置不落盘」均为 0.2.0 当晚快照，不要当现行产品文档。社区队列（#76 / awesome / deprecate）仍有效。

> 调研时刻：2026-08-15 22:40（UTC+8），0.2.0 已发布到 npm（14:00 UTC）约八小时后。
> 方法：本仓库源码通读 + harness 交叉验证 + GitHub API / npm registry / Discussion #76 全文 / awesome 主列表检索。凡标「实测」均指本次直接打过接口或打开过页面，不是沿用原计划上午的数字。

---

## 0. 结论摘要

**一句话：P0 代码与叙事已经做完、做对；项目现在输在「用户卡住的地方看不到你」。**

四个决定下一步排序的结论：

1. **原计划里「先被发现、再讲差异化、最后打磨工艺」这条排序仍然正确，而且被今晚的数据加强了。** GitHub topics 已打齐（含 `dsh-plugin`）、npm `dsh-full-remote@0.2.0` 已上、Release `v0.2.0` 已发、README 第一屏已经是 §3.3 的因果叙事 —— 仍然是 0 star / 0 fork。topics 是必要的，但不是充分的。
2. **差异化手法正在被社区独立发明，产品化还没有。** Discussion [#76](https://github.com/deepseek-ai/deepseek-harness/discussions/76) 里已经出现 Caddy 改写 Host/Origin、nginx gist、源码 patch、`moxisuki/dsh-lan`、`knoka0812/deepseek-harness-deployment-guide`（5 star）。有人明确写「caddy + `--trusted-host` 已经能到 dsh-lan 的已知边界，还是卡在 `describe`」。那正是本插件存在的理由，但 **#76 全文一次都没有出现 `dsh-full-remote` / `dsh-reverse-proxy` / `JUANWANG-BUAA`**。
3. **护城河从「唯一会改写 Host/Origin」收窄成「唯一把改写做成可安装、带鉴权、诚实边界的 dsh 插件」。** 手法本身不再稀缺；缺的是一句话能装上、并且不会把无鉴权控制面裸露到网上的默认答案。官方在 #76 里推荐的默认答案仍是 SSH 本地转发 —— 它解决不了「手机同 WiFi」和「公网隧道」。
4. **客户端半边仍未打通，上游源码今晚核对无变化。** `connection.isLoopback` 仍由页面 URL 推断（`packages/client/connection/src/client/index.ts:106`），设置面板四个消费者仍在。向上游提 Discussion 仍然是正确解，但优先级排在「去用户卡住的地方现身」之后。

由此确定今晚之后的原则：**先出现在 #76 和 awesome 列表里，再谈上游提案与工艺。继续改代理代码的边际收益仍然接近零。**

---

## 1. 对照原计划：逐条验收

状态口径：`已落地` = 源码或线上元数据已核到；`已发布` = npm/GitHub 已公开可见；`未执行` = 清单里写了但今晚仍未做；`搁置（有理由）` = 原计划已决定本轮不做。

### 1.1 P0-1 发行与被发现

| 项 | 原计划 | 今晚实测 | 状态 |
|---|---|---|---|
| GitHub topics | 空，`docs/github-metadata.md` 备好命令 | `dsh-plugin` / `deepseek-harness` / `dsh` / `reverse-proxy` / `remote-access` / `tunnel` / `mobile` / `websocket` / `security` 九个全在 | **已落地** |
| About description | 待贴 | 与 `github-metadata.md` 一致，约 190 字 | **已落地** |
| 仓库改名 | `dsh-remote` → `dsh-full-remote` | `JUANWANG-BUAA/dsh-full-remote`；旧名 API 301 到同一仓库 | **已发布** |
| npm 包名 | 改名为 `dsh-full-remote` | `dsh-full-remote@0.2.0`，`latest`，创建 2026-08-15T14:00:42Z | **已发布** |
| GitHub Release | 建议 `v0.2.0` | [v0.2.0](https://github.com/JUANWANG-BUAA/dsh-full-remote/releases/tag/v0.2.0) 已发，正文与 README 主张一致 | **已发布** |
| README 安装段 | 不写官方 web-app | 主路径 `dsh plugin --profile web add dsh-full-remote` | **已落地** |
| `npm deprecate dsh-reverse-proxy` | 发新包后执行 | `dsh-reverse-proxy@0.1.0` 仍在 registry，无 `deprecated` 字段 | **未执行** |
| social preview | 上传 `docs/rp-demo-panel.png` | 仓库 `homepage` 为空；Settings 里的图无法用 API 核，按清单未勾处理 | **未执行（高概率）** |
| awesome 收录 PR | 草稿在 `docs/release-0.1.0.md` | 主列表 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 无 `dsh-full-remote` / `JUANWANG`；同分类已收 `dsh-lan-access`、`dsh-passwords` | **未执行** |
| dist-tag Discussion | 单独发一篇 | 官方 Discussions 未检索到本仓库作者的帖；问题本身仍在（见 §3.2） | **未执行** |

关注度：0 star / 0 fork / 0 watcher（与上午相同）。`open_issues_count: 6` 全部是 Dependabot PR（checkout / pnpm / setup-node / jsdom+typescript / react 19 / @types/node），没有真实用户 issue。

HEAD `d9e6c66` 的 CI / CodeQL / Publish 均已跑完（CI 约 2 分 42 秒）。本地 `git tag` 只看到 `v0.1.0`，远程 Release 已打 `v0.2.0` —— 不影响用户，clone 时记得 `--tags`。

### 1.2 P0-2 通配监听地址四缺陷

| 项 | 状态 | 源码落点 |
|---|---|---|
| (b) Host/Origin 恒定回环，与 `backendHost` 解耦 | **已落地** | `src/proxy.js:246` 用 `rewriteLoopbackAuthority`；TCP 仍走 `backendHost` |
| (b) 通配 `backendHost` 加载期拒绝 | **已落地** | `src/index.js:433-435`；`tests/lifecycle.test.js` 「rejects a wildcard backendHost」 |
| (b) 组合测试断言转发 Host 为回环 | **已落地** | `tests/plugin.test.js:283-290` 与 `:411` 「rewrites Host to loopback when backendHost is the 0.0.0.0 wildcard」 |
| (a) 绑定 vs 可达 | **已落地** | `publishHost` / `reachableHosts` / `firstReachableIPv4`（`src/http-util.js:60-88`）；snapshot 带 `target` / `reachables` / `wildcard`（`src/index.js:175-192`） |
| (c) IPv6 方括号 | **已落地** | `formatAuthority`（`src/http-util.js:32-36`）；测试 `'::' → '[::]:62475'` |
| (d) 自环识别通配 | **已落地** | `isSelfLoop`（`src/http-util.js:52-58`）；`0.0.0.0`/`::` 与后端同端口判定为自环 |
| README「绑定地址怎么选」 | **已落地** | 中英都有专节；面板 i18n `listen.wildcard` |

### 1.3 P0-3 定位与叙事

| 项 | 状态 |
|---|---|
| README 第一屏改为因果叙事 | **已落地**（中英同步） |
| 证据链：信任栅栏 + 特权方法清单 | **已落地**（`settings.*` / `credentials.*` / `host.*` / `agentPreset.*` / `llm.discoverModels`） |
| 显式写出客户端 `isLoopback` 边界 | **已落地**（Known Limitations 首条） |
| 竞品对比表压缩或删除 | **已落地**（README 已无 9 行对比表） |
| `full` 主张收窄到服务端 API | **已落地**（package description、Release 正文、中英 README 第一屏同一句话） |

### 1.4 P1 护城河与安全披露

| 项 | 状态 |
|---|---|
| 向上游提 `isLoopback` ← `__DSH_BOOT__` | **未执行** |
| 拒绝猴子补丁路径 C | **已遵守**（源码无 `Object.defineProperty(handle, 'isLoopback')`） |
| `GET /token` 进 Known Limitations | **已落地** |
| `GET /token` 要求控制头 + loopback Origin | **已落地**（`src/index.js:310, 329-337`；`tests/control.test.js:249-251` 裸请求 403、带控制头 200） |
| Origin 改写爆炸半径（配置面）写进 README | **已落地**（Security model 专段） |

### 1.5 P2 / P3

| 项 | 状态 | 今晚判断 |
|---|---|---|
| 侧边栏 DOM 推断失败打 console.warn | **已落地**（`src/client/RemoteAction.tsx:64`） | 够用 |
| `AbortSignal.any` 并进现有 polyfill | **已落地**（`src/index.js:76-79`） | 够用 |
| 拆 `randomUUID` 独立包 | 搁置 | 维持：新产品，不是这个仓库的优化 |
| 砍 Overlay / CSS | 搁置 | 维持：面板是抄地址、抄令牌、踢设备的唯一界面 |
| 读写锁旁路 | 搁置 | 维持：慢 bind 堵住轮询是正确行为 |
| `handle()` 里 `actions` Map 提到模块作用域 | **未做** | 卫生项，零用户可见收益 |
| `exports['./client']` 补 types / 统一 ESM | 搁置 | 维持：client 是 ModuleLoader CJS 闭包，补会 404 的 types 更糟；`lib/client.ts.map` 已进 `files` |
| headless 下 `disabled` + `!!js` | 搁置 | 维持：并发挂载时可能先于 `webServer` 求值，错误的 disabled 比 README 那句「别装进 headless」更危险 |
| P3 备选选题 | 未启动 | 正确：P0 发行动作还没走完，换赛道为时过早 |

---

## 2. 源码扫描：P0 是否真修了，还剩什么

### 2.1 规模（相对原计划上午基线）

| 项 | 原计划（0.1.0 量级） | 今晚（0.2.0 HEAD） |
|---|---:|---:|
| Host JS | 1,357 | 1,458（`http-util.js` 85 → 165，通配/权威/自环集中在这里） |
| Client TS/TSX | 821 | 843 |
| Client CSS | 488 | 495 |
| 测试行 | 1,462 | 1,643 |
| 用例 | 58（44 Node + 14 vitest） | **74**（54 Node + 20 vitest） |
| 测试/源码比（不含 CSS） | 0.67 | 0.71 |
| npm 名 | `dsh-reverse-proxy@0.1.0` | `dsh-full-remote@0.2.0` |
| 插件 id / cookie / 控制前缀 / 状态文件 | — | **按 §7.1 第 2–4 类冻结**，源码有注释（`src/index.js:48-50`） |

Cordis 契约、Config schema（仍 18 个可调值）、常量时间比较、流级 body 限制、限流器上界、WebSocket 双端销毁、单 `ctx.effect` 收尾 —— 原计划 §2.1「不需要动」的部分今晚仍成立，没有回退。

### 2.2 护城河代码路径（交叉验证仍成立）

harness 侧今晚核对，与原计划附录一致、无上游提交（主仓库 `pushed_at` 仍是 2026-08-13T13:00:21Z）：

- 信任栅栏只读 HTTP 头：`api-request-trust.ts:96-123`
- 特权方法以**空**信任表二次过栅栏：`connection/src/index.ts:145-148`（`trustedHosts` 救不了 `settings.describe`）
- CLI 仍拒绝 `--host 0.0.0.0`：`web-app/src/startup.ts:69-70`
- 客户端 `isLoopback` 仍由 `location.hostname` 推断：`connection/src/client/index.ts:106`
- 四个消费者未变：`settings-scope.ts:251`、`ui-settings-models/src/client/index.ts:90`、`ui-settings-general/src/client/index.ts:72`、`ui-deliverables/src/client/index.ts:48`
- `__DSH_BOOT__` 通道仍在：`client/modules/src/index.ts:245-247`（路径 E 的现成管道，上游未用它声明信任）

本仓库侧：`forwardHeaders` 把 `host`/`origin` 写成传入的 `rewriteAuthority`；`listenProxy` 把该值固定为 `127.0.0.1:<backendPort>`，与 `backendHost` 配置脱钩。这是护城河的全部实现，没有被重构冲掉。

### 2.3 新观察到的、尚未构成缺陷的点

**`sec-fetch-site`。** 栅栏在 Host 通过之后会拒绝 `sec-fetch-site: cross-site`（`api-request-trust.ts:111`）。本代理**不改写、不剥离**该头（全仓库 grep 零命中）。#76 里 starskyzheng 的 Caddy 片段额外写了 `header_up Sec-Fetch-Site "same-origin"`。

对本插件的含义：页面和 `/api` 都走同一代理源，浏览器对同源 fetch 应标 `same-origin`，**默认路径不该踩这条**。它会在「前端与 API 不同源」（例如静态站 + 反代 API）时变成 403。这不是当前产品的架构，不必先改代码；但原计划 §10「手机经隧道访问 `settings.describe` 返回 200」必须真跑一次才能把这条从「观察」降为「无关」。**不接受推理结论。**

**`firstReachableIPv4()`。** 通配绑定时取「第一个非 internal 的 IPv4」。多网卡 / VPN / Docker 网桥上可能给出用户不想要的那张网卡。原计划已建议「能填具体局域网 IP 就填」—— README 写了，面板也警告了。显示启发式，不是绑定错误。

**`GET /status` 与 `GET /sessions` 仍不要求控制头。** 只有 token 与写操作要控制头。status 不含 token，设计可接受；sessions 列表在回环上可读，与 token 泄露不是同一级。保持现状，不必扩权。

---

## 3. 生态实测：上午到今晚变了什么

### 3.1 宏观

| 项 | 原计划上午 | 今晚实测 |
|---|---:|---:|
| harness star | 107,568 | **110,382**（约 +2.8k / 十余小时） |
| harness fork | 10,316 | 10,661 |
| awesome-dsh-plugin star | 2,327 | **2,594** |
| GitHub topic `dsh-plugin` 仓库数 | 3,349 | **3,584** |
| 官方 Issues | 关 | 仍关；需求仍在 Discussions |
| 官方 CLI npm | 原 `publishing.md` 写「没有已发布的 dsh CLI 包」 | **过时**：`@deepseek-ai/dsh@0.1.0-rc.6`，`latest` 与 `next` 都指向它。官网与 README 主路径已是 `npx @deepseek-ai/dsh web` |

生态仍是「三天大」，注意力继续稀释。本仓库打上 `dsh-plugin` 之后，是 3,584 个里的一个，不是 0 个里的一个 —— 但没有评论区引用，topic 页本身带不来点击。

### 3.2 npm dist-tag：问题还在，但形状变了

| 包 | `latest` | `next` |
|---|---|---|
| `@deepseek-ai/dsh`（CLI） | **0.1.0-rc.6**（已搬） | 0.1.0-rc.6 |
| `@deepseek-ai/dsh-web-app` | 仍停在 **0.0.1-rc.1** | 0.1.0-rc.6 |
| `@deepseek-ai/dsh-base` | 仍停在 0.0.1-rc.1 | 0.1.0-rc.6 |
| `@deepseek-ai/dsh-client-runtime` / `-ui-layout` / `-ui-sidebar` / `-ui-slots` | 仍停在 0.0.1-rc.1 | 0.1.0-rc.6 |
| `@deepseek-ai/dsh-client-ui-model` | 仍 404 | — |
| `@deepseek-ai/dsh-client-ui-model-selection` | 0.0.1-rc.3 | 0.1.0-rc.6 |

对**本插件用户**的影响已经很小：README 不再让人去装 web-app；默认 `dsh --profile web` / `npx @deepseek-ai/dsh web` 走 CLI，CLI 的 `latest` 是对的。dist-tag 文章的传播价值从「教人装上 web-app」降为「解释为什么一堆社区 README 还在写 web-app 装不上」—— 仍值得发，但不再是本插件安装路径的阻塞项。本插件 peer `>=0.1.0-rc.5 <0.2` 仍然正确，保持不动。

npm downloads API 对 `dsh-full-remote` / `dsh-reverse-proxy` 均返回 `package not found`（新包常见 24h 延迟，不能解读为 0 下载）。

### 3.3 Discussion #76：真正的需求现场

[#76 还没法--host 0.0.0.0启动啊](https://github.com/deepseek-ai/deepseek-harness/discussions/76)：官方标记 **Unanswered**，22 位参与者，16 条主回复 + 17 条嵌套。原计划记 10 赞 / 32 评；形态没变 —— **赞不高、评论继续堆，卡壳在加深。**

现场已经出现的「答案」（按出现顺序，均为今晚读全文）：

| 答案 | 谁 | 缺什么 |
|---|---|---|
| 这是故意的，用 127.0.0.1；socat 不支持 | seanxuu（偏官方口径） | 没给手机 / 隧道路径 |
| SSH `-L` 转发 | 多位；ColumKam 写成完整教程 | 手机同 WiFi 用不上；公网隧道用不上 |
| `moxisuki/dsh-lan` overlay 绑 0.0.0.0 + polyfill | 作者自己在帖里两次推销 | 无鉴权；rekey 指出 `--trusted-host` 能到同一边界，**仍卡 `describe`** |
| 改 `node_modules` 里的 startup.js | wxl499 | 升级即失效；随即撞上 `randomUUID` |
| patch `cordis.patch.yml` 把 webserver 绑 `0.0.0.0` + 手改 dist/index.html | peng-yewang（今晚新长文） | 无鉴权；升级覆盖 polyfill；把 RCE 面暴露到局域网 |
| Caddy `header_up Host/Origin`（另改 Sec-Fetch-Site） | starskyzheng | **手法与本插件相同，但无令牌门** |
| nginx gist，强制 HTTPS | nullstd | 运维型；不是 `dsh plugin add` |
| 部署教程（解除 0.0.0.0、trusted-host、反代、特权 API、Landlock） | knoka0812，仓库 5 star | 教程不是插件；读者仍要自己拼 Caddy/nginx |

关键句（rekey，8 月 14 日，回 dsh-lan）：

> 你的插件的已知边界 通过 caddy + dsh web --trusted-host 已经可以达到。也是卡在 describe 那些。

`settings.describe` 属于 `PRIVILEGED_METHODS`，第二次过栅栏时信任表被清空。`--trusted-host` 救不了它。**这是本插件 README 第一屏那句话的用户原话，出现在官方需求帖里。** 本仓库没有回复。`dsh-lan` 只有 overlay + polyfill，作者却因为现身拿到了帖内引用和 6 star。

### 3.4 竞品与相邻项目（今晚抽样）

远程 / 局域网 / 鉴权赛道仍然拥挤、仍然没人领跑。与原计划表相比，有意义的变化：

| 项目 | ★ 今晚 | 变化 | 和本插件的关系 |
|---|---:|---|---|
| flymysql/dsh-remote | 12 | +1；**已进 awesome** | **不是同一赛道**（SSH 远程工作区 + `rw_*`），但占用搜索词 `dsh-remote`。改名 `dsh-full-remote` 就是为了避开它，决策仍然对 |
| hchao3335-maker/dsh-lan-gate | 6 | 持平 | 最近的功能同类：审批 + 设备令牌，单文件。无 Host 改写则特权 API 仍 403 |
| moxisuki/dsh-lan | 6 | +1；**在 #76 里被作者推销** | 无鉴权 overlay。#76 的分发效果 > 本仓库打 topics |
| Leon0555/dsh-lan-access | 4 | 持平；**已进 awesome** | 绑 0.0.0.0 + polyfill，无鉴权 |
| slywalker2006/dsh-passwords | 3 | 持平；**已进 awesome** | 登录网关（密码/TLS/审计），不宣称恢复特权 API |
| knoka0812/deepseek-harness-deployment-guide | 5 | 新进入视野 | 教程，5 star > 本仓库。证明「把远程访问讲清楚」本身能得分 |
| NIyueeE/dsh-container | 1 | 新 | 容器内 Caddy 改写 Host/Origin，可选 basic auth。手法同源，分发形态是镜像不是插件 |
| JUANWANG-BUAA/dsh-full-remote | 0 | 持平 | 功能最完整的插件形态；#76 与 awesome 均未出现 |

awesome 主列表今晚仍无本仓库。同分类已经收了更弱的 `dsh-lan-access` 和不同赛道的 `dsh-passwords`。草稿在 `docs/release-0.1.0.md` 第三节，条目已写成 `dsh-full-remote`，**缺的只是点提交。**

### 3.5 安全讨论变成了第二现场

[#853](https://github.com/deepseek-ai/deepseek-harness/discussions/853)（无鉴权控制面 / 绑非回环即远程 RCE）与 [#451](https://github.com/deepseek-ai/deepseek-harness/discussions/451) 把官方拒绝 `--host 0.0.0.0` 的理由钉死了。#76 里 denial123789 今晚补了一段：UUID polyfill 只修浏览器兼容，不是远程部署安全。

这对本插件是顺风：社区开始区分「页面能打开」和「有门」。Caddy 改写 Host 却不设鉴权，正好踩 #853 描述的洞。本插件的令牌门不是附加功能，是把改写从「漏洞利用」变成「受控部署」的那一半。去 #76 发言时必须把这半句说在改写前面，否则看起来像又一个拆栅栏的教程。

---

## 4. 护城河还在吗

**服务端特权 API：还在。** 只要请求经过本代理，Host/Origin 就是回环字面量，空信任表那一次也能过。`--trusted-host`、overlay 绑 `0.0.0.0`、普通隧道，过不了这一关。今晚 harness 源码未改。

**手法独占：正在消失。** Caddy 三行、dsh-container、knoka 教程都在做同一件事。再过几天，「改写 Host/Origin」会变成常识，不再是 README 里需要证明的秘密。

**仍然独占的组合：**

1. `dsh plugin add` 一条命令，不必写 Caddyfile / 不必改 dist / 不必 patch node_modules；
2. 改写的同时补上比原栅栏更强的门（192-bit token、逐设备哈希、限流、可选审批、可踢设备）；
3. 控制面只活在回环 + 控制头，不随隧道暴露；
4. 公开承认客户端设置面板仍是内存作用域 —— 竞品和教程几乎都不写这条，用户装完会以为设置坏了。

**客户端半边：仍未赢，且上游未动。** 文案边界今晚仍然真实。不要为了追 star 把 README 改回「完整 DSH」。

---

## 5. 下一步：优化与升级（严格顺序）

原计划的排序原则不变，只是 P0-1 里「打 topics」已经完成，**队列的新队首是去需求现场现身。**

代码质量继续加固的边际收益仍然接近零。下面 N0–N4 全部是发行动作，不改本仓库逻辑代码。N5 是上游沟通。N6 起才允许碰代码，且要有用户报告或实测失败垫底。

### N0 · 在 Discussion #76 现身（投产比最高，今晚就能做）

这是全项目现在唯一「用户正在描述本插件所修之病、且本插件尚未出现」的地方。`dsh-lan` 用更弱的产品在这里拿到引用；本插件缺的是同一条评论。

发言结构建议（不要贴功能清单，不要提 0.1.0 旧名）：

1. 直接回应 rekey 的「卡在 describe」：根因是特权方法第二次过栅栏时信任表为空，`--trusted-host` 与绑 `0.0.0.0` 都救不了；
2. 说明本插件在转发时把 Host/Origin 写成 `127.0.0.1:<port>`，所以 `settings.*` / `credentials.*` / `host.listDirectory` 返回 200；
3. **先说门再谈改写**：栅栏对远端失效，所以有 192-bit 令牌、逐设备会话、可踢、可选审批 —— 避免被看成又一份 Caddy 片段；
4. 一句边界：官方设置面板按 URL 推断 `isLoopback`，隧道域名下仍不落盘，API 本身是 200；
5. 安装：`dsh plugin --profile web add dsh-full-remote`；
6. 链接仓库，不求 star，求有人装完回来报「describe 是不是 200」。

不要在同一条评论里推销 dist-tag 文章，那是另一帖的事。

草稿（可直接贴）：

```text
@rekey 说的「caddy + --trusted-host 仍然卡在 describe」是对的，根因不在隧道。

`settings.describe` / `credentials.*` / `host.listDirectory` 属于特权方法，gateway 会用空信任表再跑一次浏览器栅栏（只认 127/8 的 Host）。所以 `--trusted-host`、把 webserver 绑到 0.0.0.0、普通反代，页面能开、这批接口照样 403。

我做了个可 `dsh plugin add` 的代理：转发时把 Host / Origin 写成 `127.0.0.1:<backendPort>`，这批接口返回 200。栅栏对远端因此失效，所以代理自己有 192-bit 令牌、逐设备会话（可踢）、登录限流、可选首访审批。控制面只在回环，不随隧道暴露。

边界要说清：官方设置面板另有一套客户端判定（`connection.isLoopback` 看页面 URL），隧道域名下那个面板仍是内存作用域、改动不落盘。API 本身是 200。

安装：`dsh plugin --profile web add dsh-full-remote`
仓库：https://github.com/JUANWANG-BUAA/dsh-full-remote

有人装完请回一下 `settings.describe` 是不是 200。SSH -L 仍然是官方推荐的最小暴露面；这条是给手机同 WiFi / cloudflared / frp 用的。
```

### N1 · 提交 awesome 收录 PR

草稿已在 `docs/release-0.1.0.md` 第三节，标题 `Add dsh-full-remote`，条目已避开虚假「完整 UI」。主列表仓库：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin 。今晚该列表 2,594 star，是 topic 页之外最大的人工发现入口。同分类已经收了更弱的 LAN 插件，本条目没有「不够格」的问题。

提交前按对方贡献指南自检：可 `dsh plugin add`、一句话描述、已读安全免责。

### N2 · `npm deprecate` 旧名

```sh
npm deprecate dsh-reverse-proxy "Package renamed to dsh-full-remote. Use: dsh plugin --profile web add dsh-full-remote"
```

旧包 0.1.0 仍可安装，安装命令、README、patch 里的包名都是旧的。0 用户状态下这是低成本纠错；一旦有人按旧 README 或 npm 搜索装上旧包，改名收益就被稀释。

### N3 · social preview + About 收尾

- Settings → General → Social preview ← `docs/rp-demo-panel.png`（清单原文）。
- Website 可填 `https://www.npmjs.com/package/dsh-full-remote`（`github-metadata.md` 已写「发布后可填」）。

链接在 Discord / #76 里被展开时，有图和没图差一个「这是成品还是 gist」的判断。

### N4 · dist-tag Discussion（降优先级后仍值得发）

问题仍在，但**不要再写成「web-app 装不上所以本插件很难装」** —— 那已经不是真的。帖子的主角是 `@deepseek-ai/dsh-web-app` / `dsh-base` / 一串 `dsh-client-*` 的 `latest` 停在 `0.0.1-rc.1`，而 CLI `@deepseek-ai/dsh` 的 `latest` 已经是 `0.1.0-rc.6`。给社区一个可复制的结论：装 CLI 用默认 latest；装 web-app 或 client 包请钉 `@0.1.0-rc.6` 或 `--tag next`。

本插件 README 保持现状（不提 web-app）。`docs/publishing.md` 里「没有已发布的 dsh CLI 包」那句已经过时，应在下一次文档提交里改掉（本次按「不改代码」只记录，不顺手改）。

### N5 · 向上游提 `isLoopback` 部署声明（P1，不阻塞发行）

Issues 已关，走 Discussion。提案形状原计划 §3.2 路径 E 仍然正确：

- `window.__DSH_BOOT__` 已由 `dsh-client-modules` 注入，宿主知道「本部署在已鉴权代理之后」，客户端不该靠 URL 猜；
- `isLoopback`（或更准确的 `trusted`）应由部署声明，`location` 推断仅作默认；
- 四个消费者（设置作用域、模型设置、通用设置 documentController、产物 `canOpenPath`）会一起恢复。

本插件继续不猴子补丁。帖子里可以链到本仓库作为「已经在代理层做对了服务端、卡在客户端」的复现，但不要把上游帖写成插件广告。

### N6 · 发行完成之后才考虑的代码（有实测才做）

仅当 N0 引来的真实用户、或自己按 §7 清单真跑之后，出现下列之一，才开代码：

| 触发 | 可能的改动 | 不要提前做 |
|---|---|---|
| 隧道下 `settings.describe` 仍 403，且抓包看到 `sec-fetch-site: cross-site` | 转发时把该头改成 `same-origin` 或剥离（与 Host/Origin 同一层） | 不要因为 Caddy gist 有这行就先改；同源代理默认不该需要 |
| 通配绑定时复制的 target 指向 VPN/Docker 网卡 | `reachableHosts` 过滤或让面板列出全部 IPv4 供点选 | 不要自动「猜对」每一张网卡 |
| 用户把插件装进 headless 导致整进程起不来，且官方出现稳定的 profile-name 信号 | 再评估 `disabled` + `!!js` | 不要在信号出现前做 |
| 上游合并了 boot 通道的 `trusted` 标志 | 本插件改为声明该标志，设置面板落盘 | 在那之前继续诚实写边界 |

P2 里剩下的卫生项（`actions` Map 提升、读写锁）即使做了也不会改变「#76 看不见你」。不要用它们填时间。

### N7 · 两个月仍无起色时的备选

原计划 §9 P3 的选题表仍然有效（中文思考、会话深链接、插件审计器、供应链守卫、遥测脱敏、终端审批、工具输出瘦身）。额外加一条今晚才清晰的判断：

**不要再做「又一个 LAN overlay」。** 这条赛道的默认答案正在收敛成「SSH -L」或「Caddy 改写」，第三种 overlay 没有位置。若远程赛道失败，下一题应换接缝，而不是换一个绑定地址插件。

---

## 6. 明确不要做的

- 不要为了「完整」去猴子补丁 `connection.isLoopback`。
- 不要把 README 主张从服务端 API 放宽到完整 UI。
- 不要在 #76 里攻击 dsh-lan / Caddy / knoka 教程；对齐「卡在 describe」即可，他们是流量来源。
- 不要把旧包名写回任何用户可见安装命令。
- 不要为了 awesome 收录去加 star 诱饵功能。
- 不要在没有隧道实测 403 之前改 `sec-fetch-site`。
- 不要合并 Dependabot 的 React 18→19、TypeScript 6→7、Node types 22→26 —— 那是独立风险，与本复盘无关；保持 peer 与 harness 客户端 18 对齐。

---

## 7. 验证清单（原计划 §10 的更新）

原计划写「不接受推理结论」。0.2.0 的单元/集成测试覆盖了通配地址与回环改写，**但清单里带「手机 / 真实隧道 / 真实用户」的项仍然全是空的。** 那才是护城河是否兑现的证据。

发行动作（对应 N0–N4）：

- [ ] #76 已回复，且帖内能搜到 `dsh-full-remote`
- [ ] awesome PR 已开
- [ ] `npm view dsh-reverse-proxy deprecated` 非空
- [ ] social preview 已上传（用浏览器打开仓库首页看 og 图）
- [ ] `npm view dsh-full-remote version` 仍为 0.2.0，且 `dsh plugin add dsh-full-remote` 在干净 web profile 上能挂上 patch 层

产品行为（必须真跑，不能用本次文档代替）：

- [ ] 干净机器：`npx @deepseek-ai/dsh web` 后 `dsh plugin --profile web add dsh-full-remote`，README 步骤逐字可复现
- [ ] 手机经隧道：`settings.describe` / `credentials.describe` / `host.listDirectory` 均 200
- [ ] 若上条失败：在失败请求里看 `sec-fetch-site` 实际值，再决定是否改转发头
- [ ] `listenHost: 0.0.0.0` 下面板复制的 target 可被 cloudflared/手机打开（不是 `http://0.0.0.0:…`）
- [ ] `listenHost` 填具体局域网 IP 时，手机同 WiFi 直连可用
- [ ] 旧状态文件 `reverse-proxy.json` 与 cookie `dsh_reverse_proxy_session` 在 0.2.0 下仍有效（第 2 类冻结）
- [ ] 找 1 个真实用户（#76 回复里求到的那个即可）装一遍，记录卡在哪一步

---

## 8. 和原计划结论的关系

原计划四条核心判断，用今晚的数据回看：

1. **「唯一的差异化已经在代码里，但没有出现在任何一句文案里」** —— 文案已经写上了（P0-3 完成）。现在的问题更硬：文案写在自己的 README 里，而用户在 #76 里。
2. **「这个差异化只完成了一半」** —— 仍然成立，上游未动。主张收窄后，这一半不再构成虚假宣传。
3. **「web-app 装不上是社区集体误判」** —— 事实仍在，但对 CLI 用户已经不是安装阻塞。本插件安装段改对了，这篇 Discussion 从「救自己」变成「救生态」，优先级下降。
4. **「0 star / topics 为空是最高投产比的 30 秒」** —— topics 已打，0 star 没变。最高投产比的 30 秒用完了；现在最高投产比的是 #76 一条评论。

原计划最后一句「代码质量继续加固的边际收益接近零」今晚仍然是对的。0.2.0 把该修的缺陷修完了，该冻的标识符冻住了，该收窄的主张收窄了。剩下的不是升级代理，是让卡在 `describe` 的人第一次看见这个包。

---

## 附录 · 本次证据索引

**本仓库（HEAD `d9e6c66`）**

| 结论 | 位置 |
|---|---|
| Host/Origin 恒定回环 | `src/proxy.js:241-246`、`src/http-util.js:42-45` |
| 通配 backendHost 加载失败 | `src/index.js:433-435` |
| 可达地址 / IPv6 / 自环 | `src/http-util.js:12-88` |
| `GET /token` 要控制头 | `src/index.js:310, 329-337` |
| 第 2–4 类标识符冻结注释 | `src/index.js:48-50` |
| 侧边栏降级可见 | `src/client/RemoteAction.tsx:62-64` |
| 回环改写测试 | `tests/plugin.test.js:283-290, 411` |
| 通配 target 测试 | `tests/control.test.js:232-237` |

**harness（`pushed_at` 2026-08-13，今晚未更新）**

与原计划附录同一组文件行号，抽查未漂移。新增确认：CLI 拒绝 `0.0.0.0` 的文案仍写「expose remote code execution to the network」。

**外部（2026-08-15 晚实测）**

| 来源 | 结论 |
|---|---|
| GitHub API `JUANWANG-BUAA/dsh-full-remote` | 0★ 0 fork；9 topics；description 已设；Release v0.2.0 |
| npm `dsh-full-remote` | 0.2.0，`latest`，2026-08-15T14:00:42Z |
| npm `dsh-reverse-proxy` | 0.1.0，未 deprecate |
| npm `@deepseek-ai/dsh` | `latest` = 0.1.0-rc.6（CLI 已可用） |
| npm `@deepseek-ai/dsh-web-app` 等 | `latest` 仍停在 0.0.1-rc.* |
| [Discussion #76](https://github.com/deepseek-ai/deepseek-harness/discussions/76) | Unanswered；22 人；无本仓库引用；rekey 原话卡在 describe |
| awesome-dsh-plugin README | 无 `dsh-full-remote`；已收 lan-access / passwords |
| GitHub API 竞品抽样 | 见 §3.4 |
