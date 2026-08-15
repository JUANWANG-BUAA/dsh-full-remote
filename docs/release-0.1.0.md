# v0.1.0 发布资料（粘贴即用）

两份草稿：GitHub Release 发布说明（中英）与 awesome-dsh-plugin 收录 PR。
使用前把 `docs/rp-demo-panel.png` 的链接替换为发布后的 GitHub raw URL
（Release 页面拖入图片即可）。

---

## 一、GitHub Release 发布说明（英文）

```
## dsh-reverse-proxy v0.1.0 — authenticated remote access for DeepSeek Harness Web

An installable [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
bundle that puts a token-gated reverse proxy in front of the DSh Web UI, so any
tunnel (frp / ngrok / cloudflared / Tailscale / SSH) can expose it safely.

### Highlights

- **Token gate**: 192-bit access token → per-device HttpOnly session cookie
  (only the hash is stored); failed logins are rate-limited per IP (`429` lockout).
- **Per-device sessions**: the sidebar panel lists every connected device and
  can kick any one instantly — revoking one device never affects the others.
- **First-visit approval mode** (optional): new devices wait on a polling page
  until you approve or reject them from the local panel.
- **Runtime listen address**: republish the proxy on any IP/port from the panel,
  persisted across restarts, with automatic rollback when a bind fails.
- **Full protocol coverage**: HTTP, SSE and WebSocket forwarding with both-end
  teardown; mobile-ready bilingual login gate.
- **Hardening**: spoofable/hop-by-hop headers stripped, stream-level body
  limits, self-loop guard, control surface restricted to loopback with a
  control header + Origin check.

### Install

```sh
# If your profile lacks the official web bundle (its npm deps are not fully
# published yet — install it from a harness source checkout once):
dsh plugin --profile web add /path/to/deepseek-harness/packages/bundle/web-app

# This bundle (tarball, no build tooling needed):
pnpm pack
dsh plugin --profile web add ./dsh-reverse-proxy-0.1.0.tgz
dsh --profile web
```

npm install (`dsh plugin add dsh-reverse-proxy`) works once published; until
`@deepseek-ai/dsh-web-app` itself is npm-installable, profiles need the
checkout path above. See the [README](README.md#compatibility) for details.

### Quality

58 tests (unit + integration + client UI), a real-boot smoke job that installs
the bundle via `dsh plugin add` and exercises the control surface end to end,
CodeQL + dependabot + provenance publish workflow, bilingual docs,
[SECTION.md](SECURITY.md) security policy.

### Limitations

See [Known Limitations](README.md#known-limitations-and-deferred-work) — in
short: the public URL is owned by your tunnel, and HTTP/2 terminates at the
tunnel edge.
```

---

## 二、GitHub Release 发布说明（中文）

```
## dsh-reverse-proxy v0.1.0 — DeepSeek Harness Web 的带认证远程访问

一个可安装的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
bundle：在 DSh Web UI 前放置令牌门反代，任意 tunnel（frp / ngrok /
cloudflared / Tailscale / SSH）都能安全地把它发布出去。

### 亮点

- 令牌门：192-bit 访问令牌 → 每设备独立 HttpOnly 会话 Cookie（只存哈希）；
  登录失败按 IP 限流（429 锁定）。
- 按设备会话：侧边栏面板列出所有已连接设备，可单独踢出——吊销一台不影响其余。
- 首访审批模式（可选）：新设备停留在轮询等待页，直到你在本机面板批准或拒绝。
- 运行时发布地址：面板中改 IP/端口即时生效并持久化，绑定失败自动回滚。
- 完整协议覆盖：HTTP、SSE、WebSocket 转发与双端拆除；移动端友好的双语登录门。
- 加固：可伪造/hop-by-hop 头消毒、流级请求限长、自环保护、控制面仅限
  loopback + 控制头 + Origin 校验。

### 安装

```sh
# profile 还没有官方 web bundle 时（其 npm 依赖尚未发布完整，从源码
# checkout 装一次即可）：
dsh plugin --profile web add /path/to/deepseek-harness/packages/bundle/web-app

# 本 bundle（tarball，目标机无需构建工具）：
pnpm pack
dsh plugin --profile web add ./dsh-reverse-proxy-0.1.0.tgz
dsh --profile web
```

发布到 npm 后可直接 `dsh plugin add dsh-reverse-proxy`；在
`@deepseek-ai/dsh-web-app` 自身可 npm 安装之前，profile 仍需上面的
checkout 路径。详见 [README](README.md#compatibility)。

### 质量

58 项测试（单元 + 集成 + 客户端 UI）、通过 `dsh plugin add` 安装并端到端
验证控制面的真实启动冒烟 CI、CodeQL + dependabot + provenance 发布流水线、
双语文档、[SECURITY.md](SECURITY.md) 安全政策。

### 已知局限

见 [Known Limitations](README.md#known-limitations-and-deferred-work)——
要点：公网 URL 归 tunnel 所有；HTTP/2 在 tunnel 边缘终止。
```

---

## 三、awesome-dsh-plugin 收录 PR

**目标**：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>

**PR 标题**：`Add dsh-reverse-proxy`

**PR 描述**：

```
Installable via `dsh plugin add` (declares a `dsh.bundle` manifest).

Authenticated reverse-proxy bundle for remote & mobile access to the
DeepSeek Harness Web UI: 192-bit token gate, per-device sessions with
one-click kick, optional first-visit approval mode, per-IP login rate
limiting, full HTTP/SSE/WebSocket forwarding, and a sidebar control panel
with runtime listen-address switching and automatic rollback.

58 tests + a real-boot smoke CI job (installs via `dsh plugin add` and
exercises the control surface end to end), CodeQL + dependabot, bilingual
docs, SECURITY.md.

中文：带认证的 DeepSeek Harness Web 反向代理 bundle——令牌门、按设备会话
与单独踢出、可选首访审批、按 IP 登录限流、HTTP/SSE/WebSocket 完整转发、
侧边栏控制面板支持运行时改发布地址并自动回滚。
```

**README 列表条目（英文，插入 `UI Enhancements` 分类，按字母序）**：

```markdown
- [JUANWANG-BUAA/dsh-remote](https://github.com/JUANWANG-BUAA/dsh-remote) - Authenticated reverse-proxy bundle for remote & mobile access to the DeepSeek Harness Web UI: token gate, per-device sessions with kick, first-visit approval mode, rate limiting, WebSocket/SSE forwarding, and a sidebar panel with runtime listen-address switching.
```

**README.zh 列表条目（如有中文列表，同样插入）**：

```markdown
- [JUANWANG-BUAA/dsh-remote](https://github.com/JUANWANG-BUAA/dsh-remote) - 带认证的 DeepSeek Harness Web 反向代理 bundle：令牌门、按设备会话与单独踢出、首访审批模式、登录限流、WebSocket/SSE 转发，以及支持运行时改发布地址的侧边栏控制面板。
```

**提交前自检（对应其贡献指南）**：
- [ ] 可 `dsh plugin add` 安装（bundle manifest 已声明）
- [ ] 条目描述一句话、无夸张宣传
- [ ] 已读其安全免责声明（收录 ≠ 安全审查）
