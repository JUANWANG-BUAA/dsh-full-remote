# dsh-reverse-proxy

[![CI](https://github.com/JUANWANG-BUAA/dsh-remote/actions/workflows/ci.yml/badge.svg)](https://github.com/JUANWANG-BUAA/dsh-remote/actions)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](./LICENSE)
[![GitHub Repo stars](https://img.shields.io/github/stars/JUANWANG-BUAA/dsh-remote?style=flat-square)](https://github.com/JUANWANG-BUAA/dsh-remote/stargazers)
[![GitHub last commit](https://img.shields.io/github/last-commit/JUANWANG-BUAA/dsh-remote?style=flat-square)](https://github.com/JUANWANG-BUAA/dsh-remote/commits/main)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933?style=flat-square&logo=nodedotjs&logoColor=white)](./package.json)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4D6BFE?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](https://github.com/JUANWANG-BUAA/dsh-remote/pulls)

[English](./README.md) | **中文**

这是一个可安装的 DeepSeek Harness bundle，为 DeepSeek Harness Web UI 提供带认证的本地反向代理端点与侧边栏控制面板。它不特化于 Tailscale、frp、ngrok、cloudflared、WireGuard 或 SSH。

插件不会启动、停止或管理任何穿透软件。你只需把所选 tunnel 的本地目标指向 DeepSeek Harness 侧栏中显示的地址，例如 `http://127.0.0.1:3081`。

## 截图

每项功能各配一张截图，均在干净的 harness profile 上拍摄（不含个人数据）。

| 功能 | 截图 |
|---|---|
| 侧边栏入口——独占一行，位于其他底部操作正上方 | ![侧边栏入口](./docs/rp-demo-sidebar.png) |
| 控制面板——状态、tunnel 目标、一键复制 | ![控制面板](./docs/rp-demo-panel.png) |
| 运行时发布地址——应用前的非回环警告 | ![发布地址](./docs/rp-demo-listen-address.png) |
| 访问令牌——显示与轮换 | ![访问令牌](./docs/rp-demo-token.png) |
| 远程登录门——桌面端 | ![登录门](./docs/rp-demo-login.png) |
| 远程登录门——移动端（390×844） | ![移动端登录](./docs/rp-demo-mobile-login.png) |

## 功能

- 带认证的反向代理，支持 HTTP、SSE 与 WebSocket 流量。
- 侧边栏面板：启停、状态、一键复制目标地址、显示/轮换令牌。
- **运行时发布地址**：无需改 `cordis.yml`，直接在 UI 中指定代理发布的 IP 与端口；选择会持久化并在重启后生效。运行中的代理会自动重启到新地址，绑定失败则自动回滚到原地址。
- 状态持久化（`0600` 权限、原子写入）；`autoRestore` 使 DeepSeek Harness 重启后自动恢复代理。
- 移动端友好的登录页与 viewport 注入；登录页按浏览器语言显示中文或英文。
- 向 Web index 注入带保护的 `crypto.randomUUID` polyfill：远程浏览器经
  plain-HTTP（非安全上下文）访问时附件功能依然可用；剪贴板 API 缺失时
  面板回退到传统复制路径。

## 安全模型

DeepSeek Harness 默认信任 loopback Web 端点。任意 tunnel 可能把它发布到公网，因此仅改写 `Host` 会直接暴露受信任 API。本插件在反代前增加认证门：

- 本机生成 192-bit 访问令牌，以 `0600` 权限持久化；
- 远程浏览器用令牌换取 HttpOnly、SameSite 会话 Cookie（Cookie 值为令牌派生值，不额外存储第二凭据）；
- 登录失败固定延时，拖慢令牌猜测；另按远程 IP 计数限流：窗口内失败超过
  `loginMaxAttempts` 次即锁定（返回 `429` 与 `Retry-After`），锁定期满自动解除；
- 代理的监听地址与后端地址相同时拒绝启动（防自环）；
- DeepSeek Harness 的代理控制路由永远不会经远程代理转发；
- 启停、显示/轮换令牌、修改发布地址只接受直接 loopback 请求，并检查控制头和 loopback Origin；
- 转发前移除可伪造的 forwarding header 与 hop-by-hop header；
- 代理自身会话 Cookie 不会到达后端，上游 `set-cookie` 被剥离（后端本就无法向远程浏览器种 Cookie）；
- 请求体在流上实时限长，chunked 上传无法绕过声明的大小上限。

访问令牌等同密码，请勿公开。公网 tunnel 应启用 HTTPS。

## 与同类插件对比

社区已有多个解决远程访问的方案（收录于
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
registry）；下表基于该 registry 的描述与各项目 README。

| | **dsh-reverse-proxy**（本项目） | [dsh-web-lan-access](https://github.com/AcidGr/dsh-web-lan-access) | [dsh-mobile-gate](https://github.com/Bernardxu123/dsh-mobile-gate) |
|---|---|---|---|
| 模式 | 带认证的反向代理，可对接**任意** tunnel（frp/ngrok/cloudflared/SSH） | 局域网直连：注入 `crypto.randomUUID` polyfill，让官方前端在 plain-HTTP 下可用 | 子进程隔离的反向代理，LAN 移动网关 |
| 认证 | 192-bit 令牌 → 派生 HttpOnly Cookie | 无（信任局域网） | 首访审批 + 按设备绑定令牌 |
| 登录限流 | 按 IP `429` 锁定 + 固定延时 | — | 有速率限制 |
| WebSocket / SSE | 完整转发，并主动拆除会话 | 不适用 | — |
| 控制面 | 侧边栏面板：启停、运行时改发布地址（失败自动回滚）、令牌显示/轮换 | — | — |
| 运行时重配置 | UI 中改 IP/端口即时生效并持久化 | — | — |

选择本项目：你已经在用 tunnel 且希望 DeepSeek Harness 前有一道令牌门；需要完整远程体验
（流式输出、工具卡片、终端等 WebSocket/SSE 流量与文件附件）；希望认证门与
DeepSeek Harness 同进程，不额外安装网关软件。

选择其他：**dsh-web-lan-access** —— 只走受信任局域网/Tailscale IP、无需公网
暴露，仅让前端在 plain-HTTP 下可用；**dsh-mobile-gate** —— 偏好按设备绑定 +
首访审批流程，并接受独立子进程网关。

本项目同样注入 `crypto.randomUUID` polyfill（带保护，仅当浏览器缺失时），
远程 plain-HTTP 下的文件附件不受影响。

## 安装

本插件依赖 `webServer` 服务，它由官方 `@deepseek-ai/dsh-web-app` bundle 提供。
该 bundle 的 npm 依赖尚未发布完整，因此 profile 中还没有它的需要先从
harness 源码 checkout 安装：

```sh
# 若你的 profile 还没有官方 Web bundle（只需一次）：
dsh plugin --profile web add /path/to/deepseek-harness/packages/bundle/web-app

# 1. 在本仓库构建 tarball（只需一次）
pnpm pack

# 2. 加入 profile（首次使用会自动创建该 profile）
dsh plugin --profile web add ./dsh-reverse-proxy-0.1.0.tgz

# 3. 启动 DeepSeek Harness
dsh --profile web
```

发布到 npm 后，第 2 步可简化为一行：`dsh plugin --profile web add dsh-reverse-proxy`。
git 安装（`dsh plugin add github:JUANWANG-BUAA/dsh-remote#<sha>`）经自包含的
`prepare` 脚本构建；pnpm ≥10 用户需在 profile workspace 里允许构建：
`allowBuilds: { dsh-reverse-proxy: true }`。

打开 `http://127.0.0.1:3080`。**反向代理** 入口位于侧边栏底部、Settings 的正上方。启动后复制本地目标，再配置任意 tunnel：

```sh
# 仅为接入示例；插件不会执行这些命令。
cloudflared tunnel --url http://127.0.0.1:3081
ngrok http http://127.0.0.1:3081
ssh -R 8080:127.0.0.1:3081 user@example-host
```

远程浏览器在看到任何 DeepSeek Harness 内容前必须输入访问令牌。

## 手动指定发布 IP / 端口

打开侧边栏面板，编辑 **LISTEN ADDRESS**：填写 IP/主机与端口（`0` 表示自动选择空闲端口），点击 **应用发布地址**。覆盖值写入状态文件、立即生效（运行中的代理会自动重启），并在 DeepSeek Harness 重启后继续使用。若新地址绑定失败，插件自动回滚到原地址并在面板中提示。

绑定非回环地址时面板会显示警告：该端口将被直接暴露，必须自行配置防火墙规则。

## 手机与桌面使用独立 profile

DeepSeek Harness 的 Client 插件图按进程组合——同一进程无法做到"给手机拒绝加载某个 bundle（如桌面向的 `@linxin666/dsh-web-ui-all`）、给桌面照常加载"。CSS media query 只是加载后隐藏，代码仍然执行。给手机提供精简 UI 的正规做法是第二个 profile：

```sh
# 桌面：127.0.0.1:3080，保留完整第三方 UI。
dsh --profile web

# 手机：官方 Web bundle（其 npm 依赖尚未发布完整，需从源码 checkout 安装）+ 本插件，使用独立端口。
dsh plugin --profile mobile add /path/to/deepseek-harness/packages/bundle/web-app
dsh plugin --profile mobile add ./dsh-reverse-proxy-0.1.0.tgz
dsh --profile mobile --port 3082
```

把 tunnel 指向 `mobile` profile 中本插件显示的代理端点（需要固定端口时在该 profile 的面板里设置发布地址）。桌面浏览器继续打开完整的 `web` profile。这是代码层面的隔离：桌面 bundle 根本不在 `mobile` 进程的组合里。

## 配置

```yaml
- id: reverse-proxy
  name: dsh-reverse-proxy
  config:
    listenHost: 127.0.0.1
    listenPort: 3081
    backendHost: 127.0.0.1
    backendPort: 0
    autoRestore: true
    maxRequestBytes: 16777216
    upstreamTimeoutMs: 15000
    sessionMaxAgeSeconds: 2592000
    cookieName: dsh_reverse_proxy_session
    maxHeaderSizeBytes: 16384
    headersTimeoutMs: 15000
    keepAliveTimeoutMs: 5000
    loginDelayMs: 250
    loginMaxAttempts: 5
    loginLockoutSeconds: 300
    logRequests: false
    stateFile: ""
```

- `listenHost` / `listenPort` 是默认值；面板可在运行时覆盖，覆盖值持久化。
- `backendPort: 0` 自动跟随 `webServer.port`。
- `listenPort: 0` 自动选择空闲端口，实际值会显示在 UI。
- `stateFile: ""` 使用 `$DSH_HOME/reverse-proxy.json`。
- `maxHeaderSizeBytes`、`headersTimeoutMs`、`keepAliveTimeoutMs`、`loginDelayMs` 是服务器加固旋钮，默认值已安全，一般无需修改。
- `loginMaxAttempts` / `loginLockoutSeconds` 按远程 IP 限流登录失败：窗口内失败
  超过 `loginMaxAttempts` 次后返回 `429`（带 `Retry-After`），锁定期满自动解除。
  共享 NAT 出口的用户共用同一个计数桶，受影响时调高阈值。
- `logRequests: true` 以 debug 级别记录每个代理请求；生命周期事件（启动、停止、令牌轮换、发布地址变更）始终以 info 级别记录。
- tunnel 进程在本机时应保持 `listenHost: 127.0.0.1`。绑定局域网地址会主动扩大攻击面。
- 本插件依赖 `webServer` 服务，只能装进包含 `@deepseek-ai/dsh-web-app` 的
  Web profile。**不要**装进 headless profile：harness 对未激活的行有启动强校验，
  行处于 PENDING 会让整个启动失败——不存在"无害地闲置"的状态。

## 兼容性

侧边栏入口与面板挂载在 client 包 `0.1.0-rc.5` 才引入的
`sidebar.footer.action` 与 `shell.overlay` 两个 slot 上。

- 本插件 client peer 范围是 `>=0.1.0-rc.5 <0.2`，当前 npm 已可解析
  （runtime/layout/sidebar/slots 等包已发布 `0.1.0-rc.6`）。
- `@deepseek-ai/dsh-web-app` bundle 尚不能从 npm 安装（其依赖
  `@deepseek-ai/dsh-client-ui-model` 未发布），因此
  `dsh plugin add @deepseek-ai/dsh-web-app` 目前会失败。在 DeepSeek 发布之前，
  请从 harness 源码 checkout 安装 web-app，或使用已包含它的 profile。
- harness 对未激活的行会令整个启动失败（严格激活门）——我们有意保持
  peer 范围的响亮失败，而不是在旧版 client 包上静默挂载失败。

## 开发

依赖全部来自 npm，仓库自包含：

```sh
pnpm install           # 使用冻结 lockfile
pnpm run check:ci      # lint + 类型检查（CI 声明）+ 测试 + 构建，任意机器可跑
pnpm run check         # 同上，但同级存在 deepseek-harness checkout 时用真实类型检查
pnpm run bootstrap     # 可选：克隆并构建 harness checkout，为 check 提供真实类型
pnpm pack --dry-run    # 检查发布 tarball 内容
```

CI 在每次 push 与 PR 上跑 `check:ci`，外加一个真实启动冒烟任务
（`.github/workflows/ci.yml`）：通过社区标准的 `dsh plugin add` 安装本 bundle，
并在真实 harness 组合上验证控制面、登录门、限流与 index polyfill
（`scripts/smoke.mjs`）。

包同时提供 Host 入口 `lib/index.js` 与官方 DeepSeek Harness Client 入口 `lib/client.js`。
浏览器 UI 只注册到官方 `sidebar.footer.action` 与 `shell.overlay` slot。
在标准 DeepSeek Harness 侧边栏布局下，入口会被提升为其他底部操作正上方的独立整行
（按布局特征检测，不经过私有 API）；未知布局自动降级为 slot 原生行内按钮，
不写入任何 DeepSeek Harness 私有 DOM。

## 控制面 API

全部端点位于主 DeepSeek Harness Web 服务器的 `/dsh-reverse-proxy` 下，仅限 loopback，且**永不**经公共代理转发。写操作要求 `x-dsh-reverse-proxy-control: 1` 请求头与 loopback `Origin`。

| 方法 | 路径 | 请求体 | 返回 |
|---|---|---|---|
| `GET` | `/dsh-reverse-proxy/status` | — | 快照（enabled、running、target、backend、listen） |
| `GET` | `/dsh-reverse-proxy/token` | — | `{ accessToken }` |
| `POST` | `/dsh-reverse-proxy/start` | — | 快照 |
| `POST` | `/dsh-reverse-proxy/stop` | — | 快照 |
| `POST` | `/dsh-reverse-proxy/rotate-token` | — | 快照 + 新 `accessToken` |
| `POST` | `/dsh-reverse-proxy/listen` | `{ "host": "127.0.0.1", "port": 3081 }` | 快照（port 填 `0` = 自动选空闲端口） |

代理自身的 `/dsh-reverse-proxy/healthz` 返回 `{"ok":true}`，登录页位于 `/_dsh_reverse_proxy/login`。

## Model Experience

插件不会向模型添加 prompt、工具或 session 内容。令牌和代理状态只存在于人工 Web 控制面，token 与 KV cache 影响均为零。

## Known Limitations and Deferred Work

- 公网 URL 由 tunnel 软件拥有，通用插件无法自动探测。
- TLS 通常终止在 tunnel 侧，因此本地 HTTP 场景无法始终设置 Secure Cookie；公网侧必须使用 HTTPS，并保护本机访问。
- 代理剥离上游 `set-cookie` 与自身会话 Cookie：对当前 DeepSeek Harness Web（loopback 信任、无 Cookie）是正确的；若未来 DeepSeek Harness Web 出现依赖浏览器 Cookie 的能力，需要重新审视。
- 登录失败除固定延时外按远程 IP 限流（超过 `loginMaxAttempts` 次返回 `429`
  锁定）；192-bit 令牌本就使暴力猜测不现实，轮换令牌即可使全部会话失效。
  共享 NAT 用户共用计数桶，见 `loginLockoutSeconds`。
- 停止代理会销毁每个已升级 WebSocket 会话的两端：远程浏览器立即断开，
  代理的上游 socket 向后端发送 FIN（由 WebSocket 拆除测试验证）。后端自身的
  升级 socket 可能要等其处理器观察到 FIN 后才清理，DeepSeek Harness 侧会话回收遵循后端
  自身的空闲策略。
- HTTP/2 在 tunnel 或浏览器边缘终止；本地代理转发 HTTP/1.1、SSE 与 WebSocket。

## 参与贡献

欢迎贡献——开发环境搭建、检查命令与提交约定见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 安全

安全问题请通过私有渠道报告——披露流程与支持版本政策见 [SECURITY.md](./SECURITY.md)。

## 许可证

[MIT](./LICENSE) © 2026 [JUANWANG-BUAA](https://github.com/JUANWANG-BUAA)
