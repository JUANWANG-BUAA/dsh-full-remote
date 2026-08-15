# dsh-reverse-proxy

这是一个可安装的 DeepSeek Harness bundle，为 DSh Web UI 提供带认证的本地反向代理端点与侧边栏控制面板。它不特化于 Tailscale、frp、ngrok、cloudflared、WireGuard 或 SSH。

插件不会启动、停止或管理任何穿透软件。你只需把所选 tunnel 的本地目标指向 DSh 侧栏中显示的地址，例如 `http://127.0.0.1:3081`。

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
    stateFile: ""
```

- `listenHost` / `listenPort` 是默认值；面板可在运行时覆盖，覆盖值持久化。
- `backendPort: 0` 自动跟随 `webServer.port`。
- `listenPort: 0` 自动选择空闲端口，实际值会显示在 UI。
- `stateFile: ""` 使用 `$DSH_HOME/reverse-proxy.json`。
- tunnel 进程在本机时应保持 `listenHost: 127.0.0.1`。绑定局域网地址会主动扩大攻击面。
- 本插件依赖 `webServer` 服务，请只安装进提供 Web 服务的 profile；装进 headless profile 时该行会一直处于 PENDING。

## 开发

```sh
pnpm install
pnpm run check
pnpm run build
pnpm pack --dry-run
```

包同时提供 Host 入口 `lib/index.js` 与官方 DSh Client 入口 `lib/client.js`。浏览器 UI 只注册到 `sidebar.footer.action` 和 `shell.overlay`，不再修改 DSh 私有 DOM。

## Model Experience

插件不会向模型添加 prompt、工具或 session 内容。令牌和代理状态只存在于人工 Web 控制面，token 与 KV cache 影响均为零。

## Known Limitations and Deferred Work

- 公网 URL 由 tunnel 软件拥有，通用插件无法自动探测。
- TLS 通常终止在 tunnel 侧，因此本地 HTTP 场景无法始终设置 Secure Cookie；公网侧必须使用 HTTPS，并保护本机访问。
- 代理剥离上游 `set-cookie` 与自身会话 Cookie：对当前 DSh Web（loopback 信任、无 Cookie）是正确的；若未来 DSh Web 出现依赖浏览器 Cookie 的能力，需要重新审视。
- 登录端除固定失败延时外无频率限制；192-bit 令牌使暴力猜测不现实，轮换令牌即可使全部会话失效。
- HTTP/2 在 tunnel 或浏览器边缘终止；本地代理转发 HTTP/1.1、SSE 与 WebSocket。
