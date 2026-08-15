# dsh-reverse-proxy

这是一个可安装的 DeepSeek Harness bundle，为 DSh Web UI 提供带认证的本地反向代理端点。它不特化于 Tailscale、frp、ngrok、cloudflared、WireGuard 或 SSH。

插件不会启动、停止或管理任何穿透软件。你只需把所选 tunnel 的本地目标指向 DSh 侧栏中显示的地址，例如 `http://127.0.0.1:3081`。

## 安全模型

DSh 默认信任 loopback Web 端点。任意 tunnel 可能把它发布到公网，因此仅改写 `Host` 会直接暴露受信任 API。本插件在反代前增加认证门：

- 本机生成 192-bit 访问令牌，以 `0600` 权限持久化；
- 远程浏览器用令牌换取 HttpOnly、SameSite 会话 Cookie；
- DSh 的代理控制路由永远不会经远程代理转发；
- 启停、显示/轮换令牌只接受直接 loopback 请求，并检查控制头和 loopback Origin；
- 转发前移除可伪造的 forwarding header 与 hop-by-hop header。

访问令牌等同密码，请勿公开。公网 tunnel 应启用 HTTPS。

## 安装

从 DeepSeek Harness checkout 执行：

```sh
pnpm dsh plugin --profile web add /absolute/path/to/dsh-remote
pnpm dsh --profile web --dump-config
pnpm dsh --profile web
```

打开 `http://127.0.0.1:3080`，侧栏底部会出现 **反向代理**。启动后复制本地目标，再配置任意 tunnel：

```sh
# 仅为接入示例；插件不会执行这些命令。
cloudflared tunnel --url http://127.0.0.1:3081
ngrok http http://127.0.0.1:3081
ssh -R 8080:127.0.0.1:3081 user@example-host
```

远程浏览器在看到任何 DSh 内容前必须输入访问令牌。

## 手机与桌面使用独立 profile

DSh 的 Client 插件图按进程组合，不能在同一 URL 上按浏览器宽度真正卸载某个插件。如果 `@linxin666/dsh-web-ui-all` 等桌面 bundle 没有可用的窄屏布局，应使用两个 profile：

```sh
# 桌面：127.0.0.1:3080，保留完整第三方 UI。
dsh --profile web

# 手机：只安装官方 Web bundle 与本插件，使用独立端口。
dsh plugin --profile mobile add /path/to/deepseek-harness/packages/bundle/web-app
dsh plugin --profile mobile add /path/to/dsh-remote
dsh --profile mobile --port 3082
```

把 tunnel 指向 `mobile` profile 中本插件显示的代理端点；桌面浏览器继续打开完整的 `web` profile。这样手机端从代码层面不加载桌面插件，而不仅是通过 CSS 隐藏。

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
```

- `backendPort: 0` 自动跟随 `webServer.port`。
- `listenPort: 0` 自动选择空闲端口，实际值会显示在 UI。
- `stateFile: ""` 使用 `$DSH_HOME/reverse-proxy.json`。
- tunnel 进程在本机时应保持 `listenHost: 127.0.0.1`。绑定局域网地址会主动扩大攻击面。

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
- HTTP/2 在 tunnel 或浏览器边缘终止；本地代理转发 HTTP/1.1、SSE 与 WebSocket。
