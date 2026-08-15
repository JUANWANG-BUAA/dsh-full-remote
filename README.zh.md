# dsh-reverse-proxy

[![CI](https://github.com/JUANWANG-BUAA/dsh-remote/actions/workflows/ci.yml/badge.svg)](https://github.com/JUANWANG-BUAA/dsh-remote/actions)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](./LICENSE)
[![GitHub Repo stars](https://img.shields.io/github/stars/JUANWANG-BUAA/dsh-remote?style=flat-square)](https://github.com/JUANWANG-BUAA/dsh-remote/stargazers)
[![GitHub last commit](https://img.shields.io/github/last-commit/JUANWANG-BUAA/dsh-remote?style=flat-square)](https://github.com/JUANWANG-BUAA/dsh-remote/commits/main)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933?style=flat-square&logo=nodedotjs&logoColor=white)](./package.json)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4D6BFE?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](https://github.com/JUANWANG-BUAA/dsh-remote/pulls)

[English](./README.md) | **中文**

这是一个可安装的 DeepSeek Harness bundle，为 DSh Web UI 提供带认证的本地反向代理端点与侧边栏控制面板。它不特化于 Tailscale、frp、ngrok、cloudflared、WireGuard 或 SSH。

插件不会启动、停止或管理任何穿透软件。你只需把所选 tunnel 的本地目标指向 DSh 侧栏中显示的地址，例如 `http://127.0.0.1:3081`。

## 截图

| 侧边栏控制面板 | 远程登录门 |
|---|---|
| ![控制面板](./docs/rp-demo-panel.png) | ![远程登录](./docs/rp-demo-login.png) |

## 功能

- 带认证的反向代理，支持 HTTP、SSE 与 WebSocket 流量。
- 侧边栏面板：启停、状态、一键复制目标地址、显示/轮换令牌。
- **运行时发布地址**：无需改 `cordis.yml`，直接在 UI 中指定代理发布的 IP 与端口；选择会持久化并在重启后生效。运行中的代理会自动重启到新地址，绑定失败则自动回滚到原地址。
- 状态持久化（`0600` 权限、原子写入）；`autoRestore` 使 DSh 重启后自动恢复代理。
- 移动端友好的登录页与 viewport 注入。

## 安全模型

DSh 默认信任 loopback Web 端点。任意 tunnel 可能把它发布到公网，因此仅改写 `Host` 会直接暴露受信任 API。本插件在反代前增加认证门：

- 本机生成 192-bit 访问令牌，以 `0600` 权限持久化；
- 远程浏览器用令牌换取 HttpOnly、SameSite 会话 Cookie（Cookie 值为令牌派生值，不额外存储第二凭据）；
- 登录失败固定延时，拖慢令牌猜测；
- DSh 的代理控制路由永远不会经远程代理转发；
- 启停、显示/轮换令牌、修改发布地址只接受直接 loopback 请求，并检查控制头和 loopback Origin；
- 转发前移除可伪造的 forwarding header 与 hop-by-hop header；
- 代理自身会话 Cookie 不会到达后端，上游 `set-cookie` 被剥离（后端本就无法向远程浏览器种 Cookie）；
- 请求体在流上实时限长，chunked 上传无法绕过声明的大小上限。

访问令牌等同密码，请勿公开。公网 tunnel 应启用 HTTPS。

## 安装

**npm**（发布后推荐）：

```sh
dsh plugin --profile web add dsh-reverse-proxy
```

**tarball**（目标机器无需构建工具）：

```sh
pnpm pack
dsh plugin --profile web add ./dsh-reverse-proxy-0.1.0.tgz
```

**目录 / git 安装**：本仓库把 DSh 类型包以 `link:` devDependencies 指向同级 `../deepseek-harness` checkout，因此目录与 git 安装必须在具备该目录结构的机器上进行。跨机器分发请发布 npm 或安装 tarball。

```sh
pnpm dsh plugin --profile web add /absolute/path/to/dsh-remote
pnpm dsh --profile web --dump-config
pnpm dsh --profile web
```

打开 `http://127.0.0.1:3080`。**反向代理** 入口位于侧边栏底部、Settings 的正上方。启动后复制本地目标，再配置任意 tunnel：

```sh
# 仅为接入示例；插件不会执行这些命令。
cloudflared tunnel --url http://127.0.0.1:3081
ngrok http http://127.0.0.1:3081
ssh -R 8080:127.0.0.1:3081 user@example-host
```

远程浏览器在看到任何 DSh 内容前必须输入访问令牌。

## 手动指定发布 IP / 端口

打开侧边栏面板，编辑 **LISTEN ADDRESS**：填写 IP/主机与端口（`0` 表示自动选择空闲端口），点击 **应用发布地址**。覆盖值写入状态文件、立即生效（运行中的代理会自动重启），并在 DSh 重启后继续使用。若新地址绑定失败，插件自动回滚到原地址并在面板中提示。

绑定非回环地址时面板会显示警告：该端口将被直接暴露，必须自行配置防火墙规则。

## 手机与桌面使用独立 profile

DSh 的 Client 插件图按进程组合——同一进程无法做到"给手机拒绝加载某个 bundle（如桌面向的 `@linxin666/dsh-web-ui-all`）、给桌面照常加载"。CSS media query 只是加载后隐藏，代码仍然执行。给手机提供精简 UI 的正规做法是第二个 profile：

```sh
# 桌面：127.0.0.1:3080，保留完整第三方 UI。
dsh --profile web

# 手机：只安装官方 Web bundle 与本插件，使用独立端口。
dsh plugin --profile mobile add /path/to/deepseek-harness/packages/bundle/web-app
dsh plugin --profile mobile add /path/to/dsh-remote
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
    logRequests: false
    stateFile: ""
```

- `listenHost` / `listenPort` 是默认值；面板可在运行时覆盖，覆盖值持久化。
- `backendPort: 0` 自动跟随 `webServer.port`。
- `listenPort: 0` 自动选择空闲端口，实际值会显示在 UI。
- `stateFile: ""` 使用 `$DSH_HOME/reverse-proxy.json`。
- `maxHeaderSizeBytes`、`headersTimeoutMs`、`keepAliveTimeoutMs`、`loginDelayMs` 是服务器加固旋钮，默认值已安全，一般无需修改。
- `logRequests: true` 以 debug 级别记录每个代理请求；生命周期事件（启动、停止、令牌轮换、发布地址变更）始终以 info 级别记录。
- tunnel 进程在本机时应保持 `listenHost: 127.0.0.1`。绑定局域网地址会主动扩大攻击面。
- 本插件依赖 `webServer` 服务，请只安装进提供 Web 服务的 profile；装进 headless profile 时该行会一直处于 PENDING。

## 兼容性

侧边栏入口与面板挂载在 client 包 `0.1.0-rc.5`（当前 run-from-source checkout）才引入的 `sidebar.footer.action` 与 `shell.overlay` 两个 slot 上。npm registry 目前只有 `0.0.1-rc.1`，早于这两个 slot——在它上面 peer 范围会**响亮失败**，而不是静默装不上 UI。在 DeepSeek 发布更新版 client 包之前，请从源码 checkout 安装（devDependencies 有意使用 `link:` 指向该 checkout）。

## 开发

首次贡献者请用 bootstrap（devDependencies 把 DSh 类型包固定到同级 `../deepseek-harness` checkout）：

```sh
pnpm run bootstrap   # 缺失时自动克隆 deepseek-harness 到固定 commit，然后安装依赖
pnpm run check
pnpm run build
pnpm pack --dry-run
```

CI 在每次 push 与 PR 上跑同样的 `check` 流水线（`.github/workflows/ci.yml`）。

包同时提供 Host 入口 `lib/index.js` 与官方 DSh Client 入口 `lib/client.js`。浏览器 UI 只注册到 `sidebar.footer.action` 和 `shell.overlay`，不再修改 DSh 私有 DOM。

## 控制面 API

全部端点位于主 DSh Web 服务器的 `/dsh-reverse-proxy` 下，仅限 loopback，且**永不**经公共代理转发。写操作要求 `x-dsh-reverse-proxy-control: 1` 请求头与 loopback `Origin`。

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
- 代理剥离上游 `set-cookie` 与自身会话 Cookie：对当前 DSh Web（loopback 信任、无 Cookie）是正确的；若未来 DSh Web 出现依赖浏览器 Cookie 的能力，需要重新审视。
- 登录端除固定失败延时外无频率限制；192-bit 令牌使暴力猜测不现实，轮换令牌即可使全部会话失效。
- 停止代理不会拆除后端已升级的 WebSocket 会话：Node 在 upgrade 后不会把客户端侧 socket 销毁传播到服务端，这些会话按后端自身的空闲策略回收。
- HTTP/2 在 tunnel 或浏览器边缘终止；本地代理转发 HTTP/1.1、SSE 与 WebSocket。

## 参与贡献

欢迎贡献——开发环境搭建、检查命令与提交约定见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 安全

安全问题请通过私有渠道报告——披露流程与支持版本政策见 [SECURITY.md](./SECURITY.md)。

## 许可证

[MIT](./LICENSE) © 2026 [JUANWANG-BUAA](https://github.com/JUANWANG-BUAA)
