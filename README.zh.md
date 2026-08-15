# dsh-full-remote

[![CI](https://github.com/JUANWANG-BUAA/dsh-full-remote/actions/workflows/ci.yml/badge.svg)](https://github.com/JUANWANG-BUAA/dsh-full-remote/actions)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](./LICENSE)
[![GitHub Repo stars](https://img.shields.io/github/stars/JUANWANG-BUAA/dsh-full-remote?style=flat-square)](https://github.com/JUANWANG-BUAA/dsh-full-remote/stargazers)
[![GitHub last commit](https://img.shields.io/github/last-commit/JUANWANG-BUAA/dsh-full-remote?style=flat-square)](https://github.com/JUANWANG-BUAA/dsh-full-remote/commits/main)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933?style=flat-square&logo=nodedotjs&logoColor=white)](./package.json)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4D6BFE?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](https://github.com/JUANWANG-BUAA/dsh-full-remote/pulls)

[English](./README.md) | **中文**

远程访问 DeepSeek Harness Web，并且是**服务端 API 层面的完整访问**。

经普通隧道连上 Harness 时，`settings.*`、`credentials.*`、`host.listDirectory`
这批接口会返回 403。根因不在隧道：Harness 的浏览器信任栅栏只读 HTTP 头，
公网 Host / Origin 过不了。本插件在转发时把 Host 与 Origin 规范化为
`127.0.0.1:<backendPort>`，于是这批特权方法全部放行 —— 其他远程方案
都会 403 的那一批。

栅栏对远端因此失效，所以本插件必须自己建一道更强的门：192-bit 访问令牌、
逐设备凭据（只存哈希）、失败登录限流、可选的首访审批。

**主张停在「服务端 API 完整」，并钉住手机端两条客户端行为：** 官方设置会落盘；
「增加新工作区」走应用内目录浏览器，而不是在宿主机显示器上弹出系统选目录框。
index tap 声明 `__DSH_FULL_REMOTE_TRUSTED__`，并包装 `window.__ModuleLoader__`，
让官方设置插件在 bind 之前就看到 `connection.isLoopback === true`。远程页上的
「在宿主机打开」会作用到这台 Mac。上游的长期契约仍是 `__DSH_BOOT__` 信任字段。
见 [Known Limitations](#known-limitations-and-deferred-work)。

插件不会启动或管理任何穿透软件。把 frp、ngrok、cloudflared、Tailscale、
SSH 或其他隧道指向 **设置 → 反向代理** 里显示的本地目标即可。

## 截图

控制页在干净的 harness profile 上拍摄（未装其他第三方插件）。
手机加工作区是实机截图，展示本插件钉住的应用内目录浏览器。

| 功能 | 截图 |
|---|---|
| 设置 → 反向代理——状态、tunnel 目标、一键复制 | ![控制面板](./docs/rp-demo-panel.png) |
| 运行时发布地址——应用前的非回环警告 | ![发布地址](./docs/rp-demo-listen-address.png) |
| 访问令牌——显示与轮换 | ![访问令牌](./docs/rp-demo-token.png) |
| 远程登录门——桌面端 | ![登录门](./docs/rp-demo-login.png) |
| 远程登录门——移动端（390×844） | ![移动端登录](./docs/rp-demo-mobile-login.png) |
| 手机增加工作区——应用内目录浏览器 | ![手机工作区](./docs/rp-demo-mobile-workspace.png) |

## 你得到什么

- 带认证的反向代理，支持 HTTP、SSE 与 WebSocket。
- 其他远程方案必定 403 的特权接口：
  `settings.describe` / `update` / `replace` / `mutate`、
  `credentials.describe` / `set` / `unset`、
  `host.listDirectory` / `pickDirectory` / `openPath`、
  `agentPreset.*`、`llm.discoverModels`。
- 按设备会话：面板列出已连接设备，可随时单独踢出。
- 可选首访审批：新设备先等待，直到你在本机批准。
- 运行时发布地址，持久化，绑定失败自动回滚。
- 带保护的 `crypto.randomUUID` 与 `AbortSignal.any` polyfill，远程
  plain-HTTP 下附件功能仍然可用。
- 隧道域名下官方设置会落盘；「增加新工作区」走应用内目录浏览器，手机
  不再依赖宿主机显示器上的系统选目录框。

## 安全模型

Harness 默认信任 loopback Web 端点。改写 Host / Origin 既是恢复特权 API
的做法，也是让原栅栏对远端失效的原因。替代的门：

- 本机生成 192-bit 访问令牌，以 `0600` 权限持久化；
- 远程浏览器用令牌换取 HttpOnly、SameSite 会话 Cookie，Cookie 携带每设备
  独立秘密，状态文件只存其哈希；
- 登录失败固定延时，并按远程 IP 计数限流（`429` 锁定）；
- DeepSeek Harness 的控制路由永远不会经远程代理转发；
- 启停、显示/轮换令牌、修改发布地址只接受直接 loopback 请求，并检查
  控制头和 loopback Origin；
- 转发前移除可伪造的 forwarding header 与 hop-by-hop header；
- 代理自身会话 Cookie 不会到达后端，上游 `set-cookie` 被剥离；
- 请求体在流上实时限长。

Origin 改写是**配置面**而非仅会话面：每一个被转发的请求（包括改设置、
写凭据）在 Harness 看来 Origin 都是回环。这正是本插件的工作方式。
访问令牌等同密码，请勿公开。公网隧道应启用 HTTPS。

## 安装

```sh
dsh plugin --profile web add dsh-full-remote
dsh --profile web
```

在本仓库、尚未发布到 npm 时：

```sh
pnpm pack
dsh plugin --profile web add ./dsh-full-remote-0.2.2.tgz
```

git 安装（`dsh plugin add github:JUANWANG-BUAA/dsh-full-remote#<sha>`）经自包含
的 `prepare` 脚本构建；pnpm ≥10 用户需在 profile workspace 里允许构建：
`allowBuilds: { dsh-full-remote: true }`。

打开 `http://127.0.0.1:3080`。打开 **设置**——左栏最后一项是 **反向代理**
（英文：**Reverse proxy**），排在官方页面下面。启动后复制本地目标，再
配置任意隧道：

```sh
# 仅为接入示例；插件不会执行这些命令。
cloudflared tunnel --url http://127.0.0.1:3081
ngrok http http://127.0.0.1:3081
ssh -R 8080:127.0.0.1:3081 user@example-host
```

远程浏览器在看到任何 DeepSeek Harness 内容前必须输入访问令牌。

## 升级

已经装过的 profile **不会**在 `dsh web` 启动时自动拉新版本。npm 上出现新
版本后，在本机执行：

```sh
dsh plugin --profile web update dsh-full-remote
```

然后重启 `dsh web`。`add` 只给尚未安装的人用；重复执行 `add` 不一定会把
lockfile 里钉住的旧版本升上去。

本地 `link:` 安装跟 npm 无关：在仓库里 `pnpm run build`，再重启 `dsh web`。

## 绑定地址怎么选

绑定任意 IP 今天就能用 —— `cordis.yml` 里的 `listenHost`，或设置页里的
发布地址。运行时值优先于配置，写入状态文件，重启后保留。

| 你填的 | 含义 | 什么时候用 |
|---|---|---|
| `127.0.0.1`（默认） | 只绑回环。隧道进程必须和 Harness 在同一台机器。 | 几乎总是：cloudflared / ngrok / frp / SSH 跑在本机时。 |
| 具体局域网 IP（`192.168.x.x`） | 只绑那块网卡。面板直接给出可复制的地址。 | 手机同 WiFi 直连、不用隧道。换 WiFi / DHCP 续租后要重填。 |
| `0.0.0.0` / `::` | 绑所有接口。**不是可连接的目的地址。** 面板复制一条可达地址（首个非内部 IPv4），同时显示真实绑定值。 | 你就是要所有网卡（含 VPN），并接受这一点。能填具体局域网 IP 时请填具体 IP。 |

`0.0.0.0` 的意思是「绑定所有接口」，不是「手机该打开的地址」。把它填进去再
复制给 cloudflared，在部分平台上是未定义行为。面板不会把
`http://0.0.0.0:…` 当作可复制目标。

`backendHost` 请保持 `127.0.0.1`。它是连 Harness 进程的 TCP 目标，不是
监听地址。配成通配地址会在加载期被拒绝；Host / Origin 改写无论配置如何
都使用 `127.0.0.1`。

## 手动指定发布 IP / 端口

打开 **设置 → 反向代理**，编辑 **发布地址**：填写 IP/主机与端口（`0` 表示
自动选择空闲端口），点击 **应用发布地址**。覆盖值写入状态文件、立即生效
（运行中的代理会自动重启），并在 DeepSeek Harness 重启后继续使用。若新
地址绑定失败，插件自动回滚到原地址并弹出说明。

启动失败时面板顶部会弹出 toast，而不是按钮无反应。常见原因：

- 端口已被占用：改成 `3081` 或其他空闲端口，点 **应用发布地址** 再启动。
- 发布地址与 Harness 后端相同：会形成死循环，把端口改成不同的值。
- 从隧道域名操作控制面板：请用本机 `127.0.0.1` 窗口启动/停止。

## 手机与桌面使用独立 profile

DeepSeek Harness 的 Client 插件图按进程组合。给手机提供精简 UI 的正规
做法是再开一个 Harness 进程，但那个进程仍然需要 Web UI。

复制或复用一个已经能启动 Web 的 profile（通常就是正在用的 `web`），
按 [安装](#安装) 同样的方式把本插件装进去，换一个端口启动。把隧道指向
那个进程里本插件显示的代理端点。桌面浏览器继续打开完整的 `web`
profile。

不要把本插件加进一个全新的空 profile：它依赖 `webServer`，行若一直等
不到该服务，整个启动会失败。

## 配置

```yaml
- id: reverse-proxy
  name: dsh-full-remote
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
    approvalMode: false
    maxSessions: 16
    logRequests: false
    stateFile: ""
```

- `listenHost` / `listenPort` 是默认值；面板可在运行时覆盖，覆盖值持久化。
  见 [绑定地址怎么选](#绑定地址怎么选)。
- `backendPort: 0` 自动跟随 `webServer.port`。
- `listenPort: 0` 自动选择空闲端口，实际值会显示在 UI。
- `stateFile: ""` 使用 `$DSH_HOME/reverse-proxy.json`。
- `backendHost` 必须是回环地址。通配地址（`0.0.0.0`、`::`）会让插件加载
  失败。TCP 仍连这个主机；Host / Origin 改写始终使用 `127.0.0.1`。
- `approvalMode: true` 让每个新设备停留在等待页，直到在面板批准。
- 只装进 Web profile。headless 没有可远程的 UI；行若一直等 `webServer`，
  整个启动会失败。

插件 id（`reverse-proxy`）、Cookie 名、控制前缀、状态文件名在从
`dsh-reverse-proxy` 改名为 `dsh-full-remote` 后全部冻结。已有会话与
状态文件继续有效。

安装本插件还会钉住应用内目录选择器，让手机可以增加工作区：

- 禁用 `directory-picker` 行（`directory-picker-auto` 会在宿主机显示器
  上弹出系统选目录框）；
- 插入 `directory-picker-browse` 与 `ui-directory-picker-browse`。

不要在同一个 profile 里重新启用 `directory-picker`——它会抢走
`directoryPicker`，「增加新工作区」又会弹到宿主机上。

## 兼容性

控制页挂载在 `settings.section` slot 上（order 30，排在官方的
General / Models / Plugins / Agent presets 后面）。

- 本插件 client peer 范围是 `>=0.1.0-rc.5 <0.2`，当前 npm 已可解析
  （runtime/slots 等包已发布 `0.1.0-rc.6`）。
- harness 对未激活的行会令整个启动失败（严格激活门）。

## 开发

依赖全部来自 npm，仓库自包含：

```sh
pnpm install           # 使用冻结 lockfile
pnpm run check:ci      # lint + 类型检查（CI 声明）+ 测试 + 构建
pnpm run check         # 同上，但同级存在 deepseek-harness checkout 时用真实类型
pnpm run bootstrap     # 可选：克隆并构建 harness checkout，为 check 提供真实类型
pnpm pack --dry-run    # 检查发布 tarball 内容
```

CI 在每次 push 与 PR 上跑 `check:ci`，外加一个真实启动冒烟任务
（`.github/workflows/ci.yml`）：通过社区标准的 `dsh plugin add` 安装本
bundle，并在真实 harness 组合上验证控制面、登录门、限流与 index polyfill
（`scripts/smoke.mjs`）。

包同时提供 Host 入口 `lib/index.js` 与官方 DeepSeek Harness Client 入口
`lib/client.js`。浏览器 UI 只注册到官方 `settings.section` slot
（id `reverse-proxy`，order 30）。不再猜测侧边栏 DOM 布局。

## 控制面 API

全部端点位于主 DeepSeek Harness Web 服务器的 `/dsh-reverse-proxy` 下，仅限
loopback，且**永不**经公共代理转发。写操作**以及显示令牌**要求
`x-dsh-reverse-proxy-control: 1` 请求头与 loopback `Origin`。

| 方法 | 路径 | 请求体 | 返回 |
|---|---|---|---|
| `GET` | `/dsh-reverse-proxy/status` | — | 快照（`enabled`、`running`、`target`、`backend`、`listen`、`reachables`、`wildcard`；启动失败后还会带上次的 `reason`） |
| `GET` | `/dsh-reverse-proxy/token` | — | `{ accessToken }`（需要控制头） |
| `POST` | `/dsh-reverse-proxy/start` | — | 快照 |
| `POST` | `/dsh-reverse-proxy/stop` | — | 快照 |
| `POST` | `/dsh-reverse-proxy/rotate-token` | — | 快照 + 新 `accessToken` |
| `POST` | `/dsh-reverse-proxy/listen` | `{ "host": "127.0.0.1", "port": 3081 }` | 快照（port 填 `0` = 自动选空闲端口） |
| `GET` | `/dsh-reverse-proxy/sessions` | — | `{ sessions: [{ id, label, status, createdAt, lastSeenAt }] }` |
| `POST` | `/dsh-reverse-proxy/sessions/approve` | `{ "id": "…" }` | `{ "ok": true }`（待审批 → 在线） |
| `POST` | `/dsh-reverse-proxy/sessions/revoke` | `{ "id": "…" }` | `{ "ok": true }`（该设备立即失效） |

代理自身的 `/_dsh_reverse_proxy/healthz` 无需令牌即返回 `{"ok":true}`
（给负载均衡探活用）。登录页位于 `/_dsh_reverse_proxy/login`。

## Model Experience

插件不会向模型添加 prompt、工具或 session 内容。令牌和代理状态只存在于
人工 Web 控制面，token 与 KV cache 影响均为零。

## Known Limitations and Deferred Work

- **远程设置落盘：在 connection provide 时信任该页。**
  代理已经把 Host / Origin 改写成回环，所以 `settings.*` 返回 200。index
  tap 设置 `__DSH_FULL_REMOTE_TRUSTED__`，并包装 `__ModuleLoader__`，让官方
  设置 / 模型 / 语言在 bind 时使用 host 持久化。该页上 `isLoopback` 保持
  true——手机上的「在宿主机打开」会作用到这台电脑。上游的长期契约仍是
  `__DSH_BOOT__` 信任字段。
- **增加工作区使用应用内目录浏览器。** 安装本插件会禁用
  `directory-picker-auto`（webServer 绑 `127.0.0.1` 时它会在宿主机显示器
  上弹出系统选目录框），并挂上 browse 后端 + UI。手机可以选文件夹；本机
  Mac 界面也改用同一个应用内对话框，而不再走 Finder。
- **设置左栏图标是 harness 默认齿轮。** `SettingsRoot` 只为官方 section
  id 准备了字形。双节点桥接图标画在反向代理页本身。
- 从隧道域名启动 / 停止 / 显示令牌 / 改发布地址会 403（控制路由永不转发）。
  请用本机 `127.0.0.1` 窗口操作；设置页会用 toast 说明这一点。
- **`GET /token` 是没有调用者身份的回环 HTTP。** 该端点现在与写操作一样
  要求控制头和 loopback Origin，能挡住一条裸 `curl`。本机任意能发这个头
  的进程仍可读走令牌。状态文件是 `0600`；本机就是信任边界。
- Origin 改写是配置面：Harness 看到的每一个代理请求（包括改设置、写凭据）
  Origin 都是回环。
- 公网 URL 由隧道软件拥有，通用插件无法自动探测。
- TLS 通常终止在隧道侧，因此本地 HTTP 场景无法始终设置 Secure Cookie。
- 代理剥离上游 `set-cookie` 与自身会话 Cookie。
- 停止代理会销毁每个已升级 WebSocket 会话的两端。后端自身的升级 socket
  可能要等其处理器观察到 FIN 后才清理。
- HTTP/2 在隧道或浏览器边缘终止；本地代理转发 HTTP/1.1、SSE 与 WebSocket。
- 只装进 Web profile，不要装进 headless。

## 参与贡献

欢迎贡献——开发环境搭建、检查命令与提交约定见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 安全

安全问题请通过私有渠道报告——披露流程与支持版本政策见 [SECURITY.md](./SECURITY.md)。

## 许可证

[MIT](./LICENSE) © 2026 [JUANWANG-BUAA](https://github.com/JUANWANG-BUAA)
