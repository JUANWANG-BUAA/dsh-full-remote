# dsh-full-remote · 分析与改进计划

内部工作文档，不随 npm tarball 分发（`package.json` 的 `files` 逐个具名列出 `docs/rp-demo-*.png`，不是 glob，因此本文不进包）。

> 状态（2026-08-15 夜间）：0.2.1 已把「设置落盘」「手机加工作区」「控制面迁入设置页」做成产品行为。下文是当日上午的分析原文，未逐条改写成完成记录。
>
> 状态（2026-08-18）：0.3.1 已把对位 dsh-remote-web-ui 的两点落地——「一键 cloudflared 快速隧道」与「远程大厅页（设备主页）」——均为可选入口，原流程逐字节不变（登录默认仍 303 到 /，大厅页是登录表单的第二个按钮）。
>
> **0.2.0 当晚的社区对照**见 [`docs/progress-review.zh.md`](./progress-review.zh.md)（文首有 0.2.1 过时说明）。社区队列仍是：Discussion #76 现身 + awesome PR + deprecate 旧包。

汇总 2026-08-15 的代码通读、harness 源码交叉验证、生态实测与三轮实验结论。文中每条事实都标注了来源；凡是「实测」二字，均指本机跑过脚本或调过 registry API，不是推理。

---

## 0. 结论摘要

**一句话：工程质量在这条赛道里断层第一，但项目的瓶颈全部不在代码。**

四个决定成败的结论，按重要性排列：

1. **唯一的差异化已经在代码里，但没有出现在任何一句文案里。** 转发时把 Host / Origin 规范化为回环，使 harness 的浏览器信任栅栏放行 —— 远程能拿到 `settings.*` / `credentials.*` / `host.listDirectory` 这批别家必定 403 的接口。30+ 个竞品无一做到。README 只字未提。
2. **这个差异化只完成了一半。** 服务端赢了，客户端因为按 URL 推断信任而仍然降级。经过源码级可行性调研，**短期内没有干净的官方解法**（详见 §3.2），因此文案必须收敛到「服务端 API 层面」，不能宣称完整。
3. **「web-app 装不上」是社区集体误判，也包括本项目的 README。** 根因是上游 dist-tag 没搬：`latest` 停在 08-10 的 `0.0.1-rc.1`，而可用的 `0.1.0-rc.6` 挂在 `next` 上。钉版本就能装。这个发现的传播价值可能高于插件本身。
4. **项目当前 0 star / 0 fork / topics 为空**，对生态唯一的自动发现机制（GitHub topic `dsh-plugin`）完全隐形。这是全项目投产比最高的 30 秒，且已在 `docs/github-metadata.md` 里写好了值，只是没执行。

补充一条对排序很关键的事实：**§4 的四个通配地址缺陷全部只在非默认配置下触发，默认部署一个都不沾**（详见 §4(0) 与 §4(b) 的严重度校准）。它们该修，但修它们不会带来任何用户，进一步印证瓶颈不在代码。

由此确定排序原则：**先解决「能不能被人用上」，再解决「凭什么是你」，最后才是工艺打磨。** 代码质量继续加固的边际收益接近零。

---

## 1. 事实基线

### 1.1 本项目

| 项 | 值 | 来源 |
|---|---|---|
| 仓库 | 创建时为 `JUANWANG-BUAA/dsh-remote`，现已改名为 `JUANWANG-BUAA/dsh-full-remote` | GitHub API |
| 关注度 | 0 star / 0 fork / 0 watcher，`topics: []` | GitHub API |
| npm | `dsh-reverse-proxy@0.1.0`，发布 2026-08-15T11:07 | npm registry |
| Host 源码 | 1,357 行 JS（proxy 416 / index 421 / sessions 248 / http-util 85 / pages 84 / persist 65 / security 38） | `wc -l` |
| Client 源码 | 821 行 TS/TSX + 488 行 CSS | `wc -l` |
| 测试 | 1,462 行；58 个用例（44 Node + 14 vitest），`check:ci` 全绿 | 本机执行 |
| 测试/源码比 | 0.67 | 计算 |

### 1.2 生态

| 项 | 值 |
|---|---|
| harness 主仓库 | 107,568 star / 10,316 fork，**创建于 2026-08-13**（两天前） |
| Issues | 官方已关闭（`has_issues: false`），需求全部沉淀在 Discussions |
| awesome 主列表 | `awesome-dsh-plugin`，2,327 star，收录 595 条 |
| GitHub topic | `dsh-plugin` 共 3,349 个仓库 |
| npm 下载量 | 全生态尚无数据点，当前不是可用的排名维度 |

**这个生态两天大。** 它解释了后面几乎所有反常现象：竞品全部弱小、dist-tag 没搬、重复造轮子严重、质量不是稀缺资源。

---

## 2. 代码评审

### 2.1 做得好的（不需要动）

- **Cordis 契约合规**：命名导出 + Config schema，无 default export 混用；全部副作用收在一个 `ctx.effect` 里，disposer 关路由、撤 tapIndex、停代理，HMR 安全（`src/index.js:406-420`）。
- **配置纪律**：18 个可调值全部进 Schemastery schema 并带默认值与描述，无硬编码常量。完全满足「不改代码能否在 cordis.yml 里改它」的判据。
- **安全工程**：192-bit token；常量时间比较且长度不等时仍做一次 hash 比较，不泄漏长度（`src/security.js:17-25`）；逐设备 secret 只存 hash；body 限制做在流上而非只看 `content-length`（`src/proxy.js:160-175`）；限流器有内存上界与驱逐（`src/proxy.js:88-97`）；状态文件原子写 + 0600。
- **WebSocket 收尾**：`closeAllConnections()` 不覆盖已升级的 socket，代码显式跟踪并销毁两端（`src/proxy.js:243-251, 408-411`），且有对应测试。
- **文档超规格**：中英双语 README、`Model Experience` 与 `Known Limitations` 两节 —— 那是官方 workspace 包的 gate，第三方并不要求。

### 2.2 缺陷清单

按严重度排列。分类很重要：前两条不是 bug。

| # | 问题 | 位置 | 性质 |
|---|---|---|---|
| A | 客户端 `isLoopback` 导致设置面板降级 | 见 §3.2 | **不是 bug，是护城河未完成的另一半** |
| B | 改写 Origin 的爆炸半径未披露 | `src/proxy.js:110` | **不是 bug，是必须写清的取舍** |
| C | `GET /token` 无调用者身份校验 | `src/index.js:304` | 安全边界 |
| D | 通配监听地址四缺陷 | 见 §4 | 功能缺陷（实测），**仅在非默认配置下触发** |
| E | 读写共用一把串行锁 | `src/index.js:112` | 性能 |
| F | 侧边栏 DOM 推断静默降级 | `src/client/sidebarFoot.ts:22` | 脆弱性 |
| G | 打包零碎 | `package.json:7` | 工程卫生 |
| H | headless profile 下整个 boot 失败 | `cordis.patch.yml` | 可用性 |

**C · `GET /token`**：状态文件是 0600，但同一个 token 在回环 HTTP 上裸奔 —— 本机任意进程（含其他 OS 用户）一条 `curl` 即可取走。浏览器侧靠 CORS 默认拒读兜住，非浏览器调用方没有任何屏障。回环 HTTP 本就没有调用者身份，难以真修，但必须进 Known Limitations。可选加固：token 只在轮换后的那一次响应里返回，取消常驻读取端点。

**E · 串行锁**：`status` / `sessions` / `token` 与 `start` / `stop` / `setListen` 共用同一个 `gate`。面板每 3 秒轮询设备列表（`src/client/RemoteOverlay.tsx:57`），一次慢 bind 会把轮询一起堵住。

**F · DOM 推断**：用 `getComputedStyle` 向上找 column flex 祖先来插入整行。有 fallback、不写私有 DOM，属于可接受的降级设计，但**降级是静默的** —— 官方一改布局就悄悄退回内联按钮，作者不会知道。README 称 "detected by layout, never through private APIs"，措辞比实质乐观。

**G · 打包**：`exports['./client']` 缺 `types` 字段；client 产物是 CJS 而 host 是 ESM；`lib/client.ts.map` 未列入 `files`。

**H · headless**：`inject: ['webServer']` 是硬依赖，行无法激活即拒绝启动。README 已诚实说明，但用 `disabled` + `!!js` 按 profile 条件化可以做到无害共存。

---

## 3. 核心发现：唯一的差异化及其边界

### 3.1 服务端：已经赢了

harness 的浏览器信任栅栏**只读 HTTP 头，不看 TCP 源地址**：

```96:108:/Users/juanwang/code/agent_harness/deepseek-harness/packages/client/connection/src/api-request-trust.ts
export function isTrustedApiRequest(request: ApiTrustRequest, trustedHosts: readonly string[]): boolean {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
```

本项目在 `forwardHeaders` 中把 Host 与 Origin 双双改写为 `127.0.0.1:<backendPort>`（`src/proxy.js:110-111`），于是两层栅栏全部放行：

- 第一层（所有 `/api` 请求）：Host 判定为回环 → 通过
- 第二层（特权方法，以空信任表再过一次栅栏，`packages/client/connection/src/index.ts:145-148`）：同样通过

**因此被恢复的方法**（`PRIVILEGED_METHODS`，`packages/client/connection/src/index.ts:89-118`）：

`settings.describe` / `openDocument` / `update` / `replace` / `mutate`、`credentials.describe` / `set` / `unset`、`host.pickDirectory` / `openPath`、`agentPreset.read` / `copy` / `openDocument` / `remove`、`llm.discoverModels`。

加上第一层栅栏放行的 `host.listDirectory` —— 正是社区在 #1132 / #1733 / #130 里反复抱怨的那批 403。

**这是全项目唯一的护城河，30+ 个竞品无一具备。**

### 3.2 客户端：还没赢，且短期没有干净解法

**症状**：即使 API 返回 200，设置面板仍以内存作用域运行，改动不落盘。

**根因**：客户端的信任判定完全独立于服务端，来自页面 URL：

```104:106:/Users/juanwang/code/agent_harness/deepseek-harness/packages/client/connection/src/client/index.ts
  const handle: ConnectionHandle = {
    api,
    isLoopback: pageLocation === undefined || isLoopbackHostname(pageLocation.hostname),
```

隧道域名下恒为 `false`。

**消费者共 4 处**（全仓库 grep 确认，排除测试）：

| 消费者 | 位置 | 降级后果 |
|---|---|---|
| 设置作用域 | `ui-settings/src/client/settings-scope.ts:251` | 作用域从 `host` 降为 `memory`，设置不落盘 |
| 模型设置 | `ui-settings-models/src/client/index.ts:90` | 同上 |
| 通用设置 | `ui-settings-general/src/client/index.ts:72` | `documentController` 不可用，打不开配置文件 |
| 产物文件 | `ui-deliverables/src/client/index.ts:48` | `canOpenPath` 为 false，打不开产物 |

前两项就是「残血设置面板」的全部来源。

**可行性逐条排查**：

| 路径 | 结论 | 理由 |
|---|---|---|
| A. 重新 provide `connection` 服务 | **不通** | 根 realm 服务名冲突；且需重写整个 wire client（api 客户端 + RPC + 流循环） |
| B. 让浏览器 URL 变成回环 | **不通** | 隧道域名无法伪装成 `localhost` / `127.x` |
| C. 运行时 monkey-patch `handle.isLoopback` | **技术可行但不可取** | `handle` 是普通对象字面量、未 freeze，`readonly` 只是编译期约束，`Object.defineProperty` 能改。但 `settings-scope.ts:251` 在 `bind()` 调用时就把它固化成字符串常量传进 controller，**必须抢在每个消费者 bind 之前执行** —— 依赖插件加载顺序，且是在篡改别人的服务实例，违背接缝纪律，上游任何重构都会静默失效 |
| D. `tapIndex` 注入早期脚本改写 `location` | **不通** | `window.location` 在现代浏览器是 [Unforgeable]，无法重定义或遮蔽 |
| E. **向上游提议：信任由部署声明** | **正确解，但需等上游** | 见下 |

**路径 E 是唯一正确的形状，而且上游已经有现成的传输通道。** `dsh-client-modules` 已经在通过 `tapIndex` 向页面注入 `window.__DSH_BOOT__`（`packages/client/modules/src/index.ts:245-247`）—— 这正是「本部署位于一个已鉴权的代理之后」这条事实应该走的路。宿主进程知道这件事，客户端不该靠 URL 猜。

提案要点：`isLoopback`（或一个新的、语义更准确的 `trusted` 标志）应可由部署经 boot 通道声明，`location` 推断仅作为默认值。

### 3.3 由此得出的文案边界

**「完整 DSH」这个主张目前只能限定在服务端 API 层面。** 越过这条线就是虚假宣传。

可以写的（全部可验证）：

> 远程访问时，`settings.*`、`credentials.*`、`host.listDirectory` 这批在其他方案下必定返回 403 的 harness 接口全部正常工作 —— 做法是在转发时把 Host 与 Origin 规范化为回环，让 harness 的浏览器信任栅栏正常放行。
>
> 代价是这道栅栏对远端不再生效，所以本插件必须自己建一道更强的门：192-bit 访问令牌、逐设备凭据（只存哈希）、失败登录限流、可选的首访审批。
>
> **已知边界**：harness 官方设置面板另有一套客户端判定，按页面 URL 推断信任（`connection.isLoopback`），隧道域名下仍以内存作用域运行，改动不落盘。已向上游提议由部署声明该标志 —— 见 issue #xxx。

这段写法比原来的功能罗列更有说服力，而且诚实交代边界反而增加可信度。

---

## 4. 通配监听地址：四个缺陷（实测）

实测方法：起一个假后端，用三种监听/后端配置各跑一次代理请求，记录报告地址与转发头。脚本已删除，结论如下。

| 配置 | 绑定 | 代理 | 面板报告的 target | 转发的 Host |
|---|---|---|---|---|
| listen `0.0.0.0` | 成功 | 200 | `http://0.0.0.0:62469` | `127.0.0.1:62468` |
| backend `0.0.0.0` | 成功 | 200 | `http://127.0.0.1:62472` | `0.0.0.0:62468` |
| listen `::` | 成功 | 200 | `http://:::62475` | `127.0.0.1:62468` |

### (0) 前提：自定义绑定地址本来就支持，且今天就有可用解法

下面四条都是**在既有能力之上的缺陷**，不是「做不到」。绑定任意 IP 早已实现，两条路：

- 配置文件：`cordis.yml` 里的 `listenHost` / `listenPort`（`src/index.js:25-26`）
- 面板：LISTEN ADDRESS 两个输入框（`src/client/RemoteOverlay.tsx:241-274`）

运行时值优先于配置默认值（`src/index.js:162-165`），写入状态文件，重启后保留。

补充实测（绑 `0.0.0.0`，随后从四个地址访问同一个端口）：

| 访问地址 | 结果 |
|---|---|
| `http://127.0.0.1:63425` | 200 |
| `http://localhost:63425` | 200 |
| `http://192.168.3.23:63425`（本机 LAN IP） | 200 |
| `http://0.0.0.0:63425` | 200（macOS/Linux 内核兜底，Windows 与其他设备上必然失败） |

**结论：绑定和转发全程正常，坏的只是面板回显的那串地址。** 因此：

1. 缺陷 (a) 的严重度封顶在「显示错误」，不是「能力缺失」。
2. **用户今天的正解是填一个具体局域网 IP** 而非 `0.0.0.0` —— 它只在指定网卡上监听（多网卡时不会顺带暴露到 VPN 虚拟网卡），面板直接给出可用地址，天然绕开 (a)。代价是换 WiFi / DHCP 续租后要重填。
3. 这三点必须进 README，属于文档缺口而不只是代码缺口 —— 用户会把「面板给的地址用不了」理解成「代理不支持 0.0.0.0」。

### (a) 面板给出的隧道目标不可用

`0.0.0.0` 是「绑定所有接口」的通配地址，不是可连接的目的地址。**不是绑不上，是绑上之后给出的地址没法用** —— 用户一键复制去配 cloudflared 得到未定义行为。

修法：区分「绑定地址」与「可达地址」两个概念。`bound.host` 保留真实绑定值用于日志与回滚；`snapshot().target` 在绑定为 `0.0.0.0` / `::` / `''` 时改用可达地址（建议取 `os.networkInterfaces()` 的首个非内部 IPv4），面板同时列出「绑定 0.0.0.0:3081」与「可达 192.168.x.x:3081 / 127.0.0.1:3081」。涉及 `src/index.js:167`、`src/client/RemoteOverlay.tsx:209`。

### (b) backendHost 配成 0.0.0.0 会让远程全线 403（后果高 / 概率低的埋雷）

转发头变成 `Host: 0.0.0.0:<port>`。harness 的 `isLoopbackHostname` 要求四段 IPv4 首段为 `127`，`0.0.0.0` 判定为非回环 → **整条 `/api` 全部 403**，报错完全不指向根因。本地假后端不检查 Host 所以测出 200，真实 harness 会挂。

**这个配置项能静默拆掉 §3.1 的整条护城河。**

**严重度校准**：后果确实是全线 403，但触发要求用户主动修改 `backendHost`，而该字段默认 `127.0.0.1` 且不存在改它的正当理由 —— 所以这是**埋着的雷，不是正在漏的水**，现有部署不受影响。它留在 P0 的理由是修复成本极低（解耦一行 + 一个断言测试），不是紧急。这条与 (a)(c)(d) 一样，都只在非默认配置下触发；文档早期把它写成「隐性致命」会误导读者以为当前部署有问题。

修法：Host / Origin 改写必须**恒定使用回环字面量**，与 `backendHost` 配置解耦 —— TCP 连接目标照旧用 `backendHost`（连 `0.0.0.0` 在多数平台等价于连回环），只有头部改写需要规范化。同时给 Config schema 加校验。必须补一个组合测试断言这一点。

### (c) IPv6 未加方括号

`::` 拼出 `http://:::62475`，非法 URL。建议抽一个 `formatAuthority(host, port)` 放进 `src/http-util.js`，host 与 proxy 两侧共用。涉及 `src/index.js:173-177, 190, 243, 281`。

### (d) 自环检测对通配地址失效

`src/index.js:210` 的 `host === config.backendHost && port === backendPort` 是字符串比较，而通配地址包含回环，比不出来。端口相同时，只要监听地址是通配地址或与后端同属一个接口，就应判定自环并拒绝启动。

---

## 5. npm 安装链路：社区集体误判（实测）

README 当前写着「`@deepseek-ai/dsh-web-app` 的依赖未发布，无法从 npm 安装」。**这个结论是错的。**

根因是上游忘了搬 dist-tag：

| 版本 | 发布 | dist-tag | 依赖那个 404 的 `dsh-client-ui-model` |
|---|---|---|---|
| `0.0.1-rc.1` | 08-10 | **latest** | 是 → 装它必然失败 |
| `0.1.0-rc.6` | 08-13 | next | 否（已拆分为 `dsh-client-ui-model-selection`） |

`dsh plugin add @deepseek-ai/dsh-web-app` 解析 `latest`，拿到三天前的 `0.0.1-rc.1`，撞上那个从未发布的依赖。**钉版本就能装。**

已逐个探测 `0.1.0-rc.6` 的全部 59 个依赖，**全部可解析**（首轮并发请求有两个误报 404，串行复测均为 200）。

**同一问题横扫整个 `@deepseek-ai` 组织**：`dsh-client-runtime`、`dsh-client-ui-layout`、`dsh-client-ui-sidebar`、`dsh-client-ui-slots`、`dsh-message-feedback` 的 `latest` 全都停在 `0.0.1-rc.x`。这解释了为什么多个社区插件的 README 都写着「官方 web bundle 尚未发布到 npm」。

**本项目的 peer 范围 `>=0.1.0-rc.5 <0.2` 恰好把 `0.0.1-rc.1` 排除在外，是对的，保持不动。**

这正是「别人都在绕过、没人去修」的典型：社区的绕过方式是让用户从源码 checkout 装 web-app，真相是钉一个版本号。**单独发一篇 Discussion 说明这件事，传播力可能高于插件本身**，同时向上游报 dist-tag 问题。

---

## 6. 生态与竞品

### 6.1 竞品全景：拥挤，但无人领跑

远程访问 / 移动端赛道实测到 30+ 个项目，**全部创建于 8 月 13–15 三天内**，绝大多数最后一次推送就是创建当天，fork 数几乎全为 0。

| 项目 | ★ | 技术路线 | 鉴权 |
|---|---:|---|---|
| flymysql/dsh-remote | 11 | SSH + `rw_*` 工具 + SFTP 镜像 | SSH 密钥 |
| hchao3335-maker/dsh-lan-gate | 6 | 进程内反代，单文件零依赖 | 审批 + 设备令牌 |
| moxisuki/dsh-lan | 5 | overlay 绑 0.0.0.0 + polyfill | 无 |
| lbwnb666-ai/…RemoteGateway | 5 | 轻量远程网关 | 未细查 |
| Leon0555/dsh-lan-access | 4 | 绑 0.0.0.0 直连 | 无 |
| oitsukiii/deepseek-harness-lan | 4 | 4 个补丁 + 一键回滚 | 无 |
| AcidGr/dsh-web-lan-access | 3 | 仅 tapIndex 注入 polyfill | 无 |
| slywalker2006/dsh-passwords | 3 | 登录网关 | 密码 + 锁定 + 审计 |
| Asaiuta/dsh-session-hub | 3 | 多机会话聚合 | hub 网关 |
| sorsama/deepseek-harness-mobile | 2 | 原生 Android App | 局域网 |
| Bernardxu123/dsh-mobile-gate | 1 | 独立子进程反代 | 审批 + 一次性令牌 |
| BotonJ/dsh-remote-link | 1 | 零依赖网关 + mDNS | QR/HMAC 配对 |
| ai-eks/dsh-auth-tunnel | 0 | Cloudflare Tunnel 两模式 | 密码门 |

**赛道判断**：痛点真实（Discussion #76 有 32 条评论，#237 / #229 / #1132 / #1733 / #1919 反复出现），但进入门槛极低导致注意力极度分散 —— 最高只有 11 star，说明用户根本不在这里找答案。

**最强的信号藏在重复里**：至少 9 个插件各自独立实现了同一段 20 行的 `crypto.randomUUID` polyfill。当同一个修复被重复发明九次，说明社区还没找到那个「默认答案」—— 既是机会，也是警告。

### 6.2 社区痛点

官方已关闭 Issues，需求全部在 Discussions。按 upvote：

| 诉求 | 赞 | 评论 |
|---|---:|---:|
| #172 独立客户端 + CLI + VSCode | 159 | 45 |
| #1115 官方插件市场与安全规范 | 34 | 14 |
| #45 来个 TUI | 30 | 2 |
| #61 回滚 pricing | 28 | 12 |
| #32 涨价，能否出 coding plan | 24 | 7 |
| #320 系统提示词支持中文思考 | 21 | 6 |
| #601 是 web 不是桌面端 | 13 | 50 |
| #723 官方插件商店 | 11 | 3 |
| #76 还没法 `--host 0.0.0.0` 启动 | 10 | 32 |
| #341 开放 Issues 和 PR | 10 | 9 |

**注意 #601 与 #76 的形态**：赞数不高但评论极多。**赞衡量共鸣，评论衡量卡壳程度 —— 插件机会藏在后者里。**

生态治理焦虑是第二大主题：#1770「扫了 1309 个插件，15 个严重风险」、#1728「插件库 1805 款已整理，咱们不要重复开发相同的插件」、#1351「给 DSH 做了一次全身检查：76 条缺陷」。awesome 主列表顶部挂着警告：「安装插件等于以你的权限运行第三方代码，被收录不等于通过安全审查。」

---

## 7. 命名决策

**已定：`dsh-full-remote`**（npm 与 GitHub 均可用，已核实）。仓库名同步改，彻底避开与 `flymysql/dsh-remote`（赛道最高 11 star）的混淆。

理由：在一个 3,349 个仓库、发现完全靠搜索的生态里，名字里没有 `remote` 或 `mobile` 就等于隐形，所以搜索词必须保留；`full` 在同一口气里完成差异化 —— 它不是修饰语而是**主张**。名字本身就是 pitch。

否掉的候选与理由：`dsh-parity`（概念最准确，但无搜索词且中文开发者不会第一眼 parse）、`dsh-teleport`（最好记，但没说清「完整」）、`dsh-anywhere`（品牌感最好，同样缺搜索词）。

**改名成本在当前 0 用户状态下几乎为零，之后迅速上升。**

⚠️ 与 §3.3 的联动：`full` 的主张必须与文案边界一致 —— 说的是「完整的服务端 API」，不是「完整的 UI 体验」。README 第一段必须自己划清这条线。

### 7.1 改名的爆炸半径（实测：27 个文件、约 160 处）

`dsh-reverse-proxy` / `reverse-proxy` / `dsh_reverse_proxy` 三个变体遍布全仓库。**这些标识符语义完全不同，绝不能一次性 sed 替换。** 按处理方式分五类：

| 类 | 标识符 | 位置 | 处理 |
|---|---|---|---|
| **1 · 必须改** | npm 包名 | `package.json:2` | 改，否则名字没换 |
| | bundle patch 里的包名引用 | `cordis.patch.yml:5` | **改，否则装不上** |
| | 安装命令与 tarball 文件名 | `README.md`（24 处）/ `README.zh.md`（23 处） | 改 |
| | 仓库 URL 三处 | `package.json:60,62,64` | 改（GitHub 自动重定向旧名，但元数据应准确） |
| **2 · 建议冻结** | 状态文件名 `reverse-proxy.json` | `src/persist.js:13` | 冻结，改则丢 token + 全部设备会话 |
| | cookie 名 `dsh_reverse_proxy_session` | `src/index.js:34` | 冻结，改则所有已登录设备掉线 |
| | 会话密钥哈希盐 `…/session-secret/v1` | `src/sessions.js:39` | 冻结，改则已存哈希全失效 |
| | 插件 id / `export const name` | `src/index.js:21`、`cordis.patch.yml:4` | 冻结，改则用户已有的 cordis.yml 行失配 |
| **3 · 改必成对** | 转发标记 `x-dsh-reverse-proxy` | `src/proxy.js:36`（剥离表）+ `:115`（写入） | **只改一处 = 剥离表失配 = 该头可被外部伪造** |
| | 控制头 `x-dsh-reverse-proxy-control` | `src/index.js:311` + `src/client/index.ts:26` | 只改一处 = 控制面全 403 |
| | polyfill 幂等标记 `data-plugin=…` | `src/index.js:64,79` | 改名后页面若残留旧标记 → 重复注入 |
| **4 · 用户可见 URL** | 控制前缀 `/dsh-reverse-proxy` | `src/index.js:46` + `src/client/index.ts:21` | 随第 2 类冻结 |
| | 登录/等待/健康检查 `/_dsh_reverse_proxy/*` | `src/pages.js:14`、`src/proxy.js:218,273,282,292` | 随第 2 类冻结 |
| **5 · 无所谓** | i18n NS、日志前缀、DOM 属性、注释、测试、smoke 脚本 | `i18n.ts:17`、`sidebarFoot.ts:14`、`tests/*`、`scripts/smoke.mjs` | 顺手改，改错也只是不好看 |

**决策：只改第 1 类，其余全部冻结。**

理由是收益与风险不对称。0 用户状态下改第 2 类确实免费，但这些标识符**用户根本看不见**（cookie 名、状态文件名、内部头），改它们零收益；而第 3 类一旦漏改一侧，失配是静默的 —— 尤其 `x-dsh-reverse-proxy` 的剥离表，漏改会直接把一个防伪造措施变成摆设，且没有任何报错。

配套动作：

- npm 上对旧包 `dsh-reverse-proxy` 执行 `npm deprecate`，消息指向新名。
- 仓库改名后 GitHub 自动重定向旧路径，但 `package.json` 的 `repository` / `homepage` / `bugs` 三处 URL 要手动改。
- 改完跑一次 `pnpm run check:ci` + `scripts/smoke.mjs`（后者走真实 `dsh plugin add` 流程，能抓到第 1 类漏改）。
- 用 `rg 'dsh[-_]reverse[-_]proxy|reverse-proxy'` 复查，逐处对照上表分类，不要全局替换。

---

## 8. 方法论：什么是好的 dsh 插件

### 8.1 硬性合规（及格线，本项目全部满分）

- 形态不混用：函数插件只用命名导出，服务类才 default export。混用会让 Loader 丢掉 `inject`，插件永远 PENDING。
- 副作用全可逆：注册、监听、定时器一律经 `ctx.effect` / `ctx.on` 收回 disposer；顺序敏感的清理合并进同一个 effect。
- 可调值进 Config：判据是「不改代码能否在 cordis.yml 里改它」。默认值写在 schema 字段上，非法配置响亮失败。
- 不改 agent-loop：新行为挂在文档化扩展点上。
- 模型可见 ⟺ 已入日志：新的模型可见输入必须有对应 session event。
- 硬依赖走 `inject`，可选服务用 `ctx.get(name)` 并处理 `undefined`。

### 8.2 决定成败的软性判据

生态实测显示 **star 效率与工程质量几乎不相关**：14 KB 的 `dsh-gitbash-preset` 拿到 71 star，601 KB 的 `dsh-science` 只有 10 star。相关的是这四条：

1. **修硬故障，不做锦上添花。** 冠军插件解决的都是「不修就完全没法用」：Windows 跑不起来、会话删不掉、手机上白屏。愉悦感来自解除阻塞，不是增加选项。
2. **打平台缺陷，不打产品需求。** 官方的疏漏与刻意限制形成的硬伤，寿命长、指向明确、无需教育用户；产品需求会被官方下一个版本吃掉。
3. **零依赖、单文件、可逆。** 在一个每天漂移的生态里这是决定性的 —— 它让插件不会因为上游升级而失效。「不改产品源码、完全可逆、版本无关」是高 star 项目 README 里的共同措辞。
4. **一句话能说清。** 名字即功能，README 第一行即全部价值。需要一张对比表才能说清优势的插件，通常已经输了。

参照组：

| 项目 | ★ | 体积 | 解决的那一个卡点 |
|---|---:|---:|---|
| dsh-gitbash-preset | 71 | 14 KB | Windows 装完根本跑不起来 |
| dsh-minimal-turbo | 18 | 24 KB | 极简模式的 Windows 适配 |
| dsh-plugin-session-delete | 15 | 28 KB | 官方 UI 删不掉会话 |
| dsh-skin | 11 | 15 KB | 皮肤切换 + 自定义壁纸 |

### 8.3 对本项目的含义：表面积 = 腐烂速度

当前维护表面积：2,178 行源码 + 488 行 CSS + 4 个 rc 级 peer 依赖 + 一段靠 `getComputedStyle` 推断官方侧边栏 DOM 的代码。上游两天大、每天在变（`latest` 标签都还没理顺）。

**维护负担是竞品的十倍，意味着腐烂速度也是十倍，而收益一分钱还没兑现。** 继续做没问题，但要清楚这笔账。

---

## 9. 改进计划

**P0 内部有严格顺序**，不是三件可并行的事：

1. **topics 最先** —— 30 秒、无依赖、立即生效，且与后续任何改动都不冲突。
2. **改名次之** —— 成本随用户数上升，必须趁 0 用户；但要先出 §7.1 的分类清单再动手，不能边改边想。
3. **叙事最后** —— README 第一屏依赖新名字和新安装命令定稿，提前写等于返工。

P0-2（通配地址）与上面三条无依赖，可随时插入。

### P0-1 · 发行与被发现

- [x] **给仓库打 topics**（30 秒，全项目投产比最高）—— 2026-08-16 已通过 `gh api` 应用：`dsh-plugin deepseek-harness dsh reverse-proxy remote-access tunnel mobile websocket security`。
  值：`dsh-plugin deepseek-harness dsh reverse-proxy remote-access tunnel mobile websocket security`。`dsh-plugin` 必须在第一位。
- [x] **改名为 `dsh-full-remote`**（npm / patch / README 安装命令）。第 2–4 类标识符全部冻结。GitHub 仓库已改名为 `dsh-full-remote`。`npm deprecate` 待发布新包后执行。
- [x] **修正 README 的安装段**：主路径改为钉版本的 `dsh plugin --profile web add @deepseek-ai/dsh-web-app@0.1.0-rc.6`。
- [ ] **上传 social preview**（`Settings → General → Social preview`，用 `docs/rp-demo-panel.png`）。
- [x] **提交 awesome 列表收录 PR**：PR [#833](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/833)（收录条目原为 #554），2026-08-16 已把 EN/ZH 条目更新为 0.3.x 口径（invite QR、栅栏自检、CIDR/空闲/TLS）并合并上游 main，待维护者合入。
- [x] **发一篇 dist-tag 的 Discussion** + 向上游报问题（见 §5）—— 已发 [#2233](https://github.com/deepseek-ai/deepseek-harness/discussions/2233)（实测最新：rc.1 有 9 个不可解析依赖，`latest` 各包均停在 0.0.1-rc.x）。

### P0-2 · 通配监听地址四缺陷

- [x] (b) 优先：Host / Origin 改写恒定用回环字面量，与 `backendHost` 解耦 + 组合测试断言
- [x] (a) 区分「绑定地址」与「可达地址」，面板同时展示两者 + 通配地址专门文案
- [x] (c) 抽 `formatAuthority(host, port)`，IPv6 加方括号
- [x] (d) 自环检测识别通配地址
- [x] **README 补「绑定地址怎么选」一节**（§4(0)）

### P0-3 · 定位与叙事

> **与 P1-1 的依赖已解除。** 曾经的顾虑是：README 宣称「完整的 DSH」而客户端 `isLoopback` 未修，等于虚假宣传，所以两者要么同做、要么先做 P1-1。§3.3 用第三种方式化解了 —— **把主张收窄到「服务端 API 层面完整」并显式写出客户端边界**，主张即刻为真，不必等上游。因此 P0-3 可以独立推进，P1-1 转为长期项。前提是下面第三条必须做，它是这个解法成立的全部依据。

- [x] README 第一屏改为 §3.3 的因果叙事，替换现有 Features 罗列
- [x] 补 harness 侧证据链（`api-request-trust.ts:96-108` + `PRIVILEGED_METHODS` 清单），让主张可核验
- [x] **明确写出客户端边界**（§3.2），不越线
- [x] 竞品对比表从 9 行压到 3 行，或整段删掉

### P1 · 护城河与安全披露

- [x] **向上游提 Discussion**（Issues 已关）：`isLoopback` 应可由部署经 `__DSH_BOOT__` 通道声明，`location` 推断仅作默认值（§3.2 路径 E）—— 已发 [#2234](https://github.com/deepseek-ai/deepseek-harness/discussions/2234)。
- [x] 视上游反馈决定是否接受路径 C 的猴子补丁作为过渡 —— **默认不接受**
- [x] `GET /token` 写进 Known Limitations；加固为与写操作同样要求控制头（未取消常驻读取端点：面板「显示令牌」是主路径，取消会伤 UX；回环 HTTP 没有调用者身份，取消端点也挡不住本机进程）
- [x] 披露 Origin 改写的爆炸半径（配置面而非仅会话面），与 §3.3 的因果叙事写在一起

### P2 · 降低腐烂速度 + 工程零碎

- [ ] **把 `randomUUID` polyfill 拆成独立极小包** —— 本轮只把 `AbortSignal.any` 并进现有注入，不新开一个包。拆包是新产品，不是这个仓库的优化。
- [x] 侧边栏 DOM 推断失败时打 console 警告，让降级可见
- [ ] 评估砍掉部分 UI（488 行 CSS + 334 行 Overlay 是腐烂最快的部分，且与核心价值无关）—— 本轮不动：面板是用户抄地址、抄令牌、踢设备的唯一界面，砍掉等于砍掉被发现之后的可用性。
- [x] 只读路径旁路串行锁 / 改读写锁 —— 0.3.0 已实现读写门拆分（`exclusive` / `shared`，见 `src/index.ts` 与 CHANGELOG 0.3.0 Changed）：读等待当前写完成后并发执行，慢 bind 期间轮询仍会短暂等待，但不再与所有读串行。
- [x] `handle()` 里的 `actions` Map 提到模块作用域 —— 已提升到 `createRuntime` 作用域（`src/index.ts`，随 runtime 创建一次），因条目值是 start/stop/rotateToken 的运行时闭包，无法提到真正的模块作用域；行为不变。
- [ ] `exports['./client']` 补 `types`；统一 ESM；`files` 补齐产物清单 —— client 产物是 ModuleLoader CJS 闭包，补一个会 404 的 `types` 字段比缺字段更糟。
- [ ] `disabled` + `!!js` 让插件在 headless profile 下无害跳过 —— 本轮不做：`disabled: !!js ctx.get('webServer') === undefined` 在并发挂载时可能先于 webServer 求值，会在 web profile 里把自己关掉。没有稳定的 profile-name 信号之前，错误的 disabled 比 README 里那句「别装进 headless」更危险。

### P3 · 备选选题

**继续做这条赛道的前提是完成 P0-3 与 P1。** 若两个月后仍无起色，下面是按「接缝空白 × 社区痛点」筛出的备选，代码量 20–300 行：

| 方向 | 挂载点 | 依据 |
|---|---|---|
| 中文思考强制 | `ctx.systemPrompt.section()` | #320，21 赞，约 20 行 |
| 会话深链接与跨设备恢复 | webServer 路由 + `conversation.session.header.actions` | #1039 明确提出、无人实现，与远程赛道天然互补 |
| 插件能力审计器 | `ctx.cordisInspect` + `ctx.tools` | #1770 / #1728 / #1351；生态最缺的东西 |
| 供应链安装守卫 | `tools/pre-execute` (waterfall) | agent 自主装包是最大的未设防面 |
| 遥测脱敏规则包 | `session-telemetry/record` (waterfall) | 官方承认零内置规则（`session-telemetry/README.md:45`） |
| 终端审批应答器 | `approval/request` (waterfall) | `ctx.approval` 零内置 provider；#45 / #172 说明 TUI 是第二大诉求 |
| 工具输出瘦身 | `tools/post-execute` + `ctx.tokenMeter` | 可量化省 token，在 #61 / #32 抱怨涨价的社区里是最好的传播素材 |

接缝空白全景：57 个 `ctx` 服务中，9 个只有单一官方 provider（compaction / terminals / spill / workflow / lsp / codeRuntime / sessionTelemetry / jobs / attachments），2 个无内置 provider（userQuestions / approval answerer），13 个 waterfall 拦截点向所有人开放。完整清单见 Canvas「dsh 插件评审与机会地图」。

---

## 10. 验证清单

改完之后每一条都必须真跑，**不接受推理结论** —— 本次 §4(b) 与 §5 两个关键发现都是实测才浮出来的，光读代码看不见。

- [ ] 干净容器里从 npm 零安装成功，README 步骤逐字可复现
- [ ] 手机经隧道访问：`settings.describe` / `credentials.describe` / `host.listDirectory` 均返回 200
- [ ] `listenHost: 0.0.0.0` 下面板给出的 target 复制即可用
- [ ] `backendHost: 0.0.0.0` 下 `/api` 不再 403（回归测试断言转发 Host 为回环）
- [ ] `listenHost: '::'` 下 target 是合法 URL
- [ ] `listenHost` 填具体局域网 IP 时，手机同 WiFi 直连可用，面板给出的地址复制即可用
- [ ] **改名后 `scripts/smoke.mjs` 通过** —— 它走真实 `dsh plugin add`，是第 1 类漏改（尤其 `cordis.patch.yml`）唯一的自动拦截点
- [ ] **改名后旧 cookie 与旧状态文件仍然有效**，确认第 2 类标识符确实被冻结
- [ ] 改名后 `rg 'x-dsh-reverse-proxy'` 的写入处与剥离表仍然同名（第 3 类失配是静默的，必须人工核）
- [ ] 找 3 个真实用户装一遍，记录他们卡在哪一步
- [ ] `pnpm run check:ci` 全绿，新增缺陷全部有回归测试

---

## 附录 · 证据索引

**harness 源码**（`/Users/juanwang/code/agent_harness/deepseek-harness`）

| 结论 | 位置 |
|---|---|
| 信任栅栏只读 HTTP 头 | `packages/client/connection/src/api-request-trust.ts:96-123` |
| 回环判定（127.0.0.0/8、localhost、[::1]） | `packages/client/connection/src/loopback-hostname.ts:12-18` |
| 特权方法集 | `packages/client/connection/src/index.ts:89-118` |
| 特权方法以空信任表二次过栅栏 | `packages/client/connection/src/index.ts:145-148` |
| 客户端 isLoopback 由 location 推断 | `packages/client/connection/src/client/index.ts:106` |
| connection 服务的 provide 点 | `packages/client/connection/src/client/index.ts:143` |
| 设置作用域降级 | `packages/client/ui-settings/src/client/settings-scope.ts:251` |
| 模型设置降级 | `packages/client/ui-settings-models/src/client/index.ts:90` |
| 通用设置 documentController | `packages/client/ui-settings-general/src/client/index.ts:72` |
| 产物文件 canOpenPath | `packages/client/ui-deliverables/src/client/index.ts:48` |
| `__DSH_BOOT__` 注入（路径 E 的现成通道） | `packages/client/modules/src/index.ts:245-247` |
| CLI 拒绝 `--host 0.0.0.0` | `packages/bundle/web-app/src/startup.ts:69-70` |

**本项目源码**

| 结论 | 位置 |
|---|---|
| Host / Origin 改写（护城河来源） | `src/proxy.js:110-111` |
| 全部副作用收在一个 effect | `src/index.js:406-420` |
| `GET /token` 无控制头 | `src/index.js:304` |
| 串行锁 | `src/index.js:112-116` |
| 自环检测字符串比较 | `src/index.js:210` |
| target 拼装（IPv6 / 通配地址问题） | `src/index.js:167-183` |
| 常量时间比较 | `src/security.js:17-25` |
| 流级 body 限制 | `src/proxy.js:160-175` |
| 限流器内存上界 | `src/proxy.js:88-97` |
| WebSocket 两端销毁 | `src/proxy.js:243-251, 408-411` |
| 侧边栏 DOM 推断 | `src/client/sidebarFoot.ts:22-33` |
| 面板 3 秒轮询 | `src/client/RemoteOverlay.tsx:57` |
| 监听地址两条配置路径（运行时优先） | `src/index.js:25-26, 162-165`、`src/client/RemoteOverlay.tsx:241-274` |
| 转发标记的写入与剥离必须同名 | `src/proxy.js:36` + `:115` |
| 控制头两侧必须同名 | `src/index.js:311` + `src/client/index.ts:26` |
| 改名涉及的存储/线缆标识符 | `src/persist.js:13`、`src/index.js:34`、`src/sessions.js:39`、`cordis.patch.yml:4-5` |

**外部数据**（2026-08-15 实测，GitHub API / npm registry API）

生态与竞品数据见 §1.2、§6；npm dist-tag 数据见 §5。
