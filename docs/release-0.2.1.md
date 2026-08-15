# v0.2.1 发布资料（粘贴即用）

GitHub Release 正文（中英）与升级命令。产品行为以 `CHANGELOG.md` 与当前 README 为准。

---

## 一、GitHub Release 发布说明（英文）

```
## dsh-full-remote v0.2.1 — settings persist, phone workspaces, Settings page

Patch release on top of the 0.2.0 rename. Install or upgrade with:

```sh
dsh plugin --profile web add dsh-full-remote
# already installed:
dsh plugin --profile web update dsh-full-remote
```

Then restart `dsh web`. Profiles do not auto-update on boot.

### Highlights

- **Official settings persist on a tunnel hostname.** The index tap declares `__DSH_FULL_REMOTE_TRUSTED__` and wraps `__ModuleLoader__` so `connection.isLoopback` is true before official plugins bind.
- **Add workspace works on a phone.** The bundle disables `directory-picker-auto` (native chooser on the host display) and pins the in-app browse picker.
- **Control page moved to Settings → Reverse proxy** (`settings.section`, order 30). Overlay dialog and sidebar-foot DOM guessing are gone.
- **Rotate token no longer deadlocks** the serial gate; `proxy.close()` has a 2s grace so SSE cannot freeze stop/rotate.
- Start/stop/listen failures surface as toasts with the next step, including a tunnel-hostname 403 that tells you to use the local `127.0.0.1` window.

### Limitations

See [Known Limitations](README.md#known-limitations-and-deferred-work). In short: "open on host" from a remote page acts on the host machine; the Settings left-nav icon is the harness default gear; operate start/stop from loopback.

### Upgrade from 0.2.0

`dsh plugin --profile web update dsh-full-remote`, then restart. Frozen identifiers (plugin id `reverse-proxy`, cookie, control prefix, state file) are unchanged — existing sessions keep working.
```

---

## 二、GitHub Release 发布说明（中文）

```
## dsh-full-remote v0.2.1 — 设置落盘、手机加工作区、控制面迁入设置页

在 0.2.0 改名之上的补丁版。安装或升级：

```sh
dsh plugin --profile web add dsh-full-remote
# 已经装过：
dsh plugin --profile web update dsh-full-remote
```

然后重启 `dsh web`。profile 不会在启动时自动拉新版本。

### 亮点

- **隧道域名下官方设置会落盘。** index tap 声明 `__DSH_FULL_REMOTE_TRUSTED__`，并包装 `__ModuleLoader__`，让官方插件在 bind 之前看到 `connection.isLoopback === true`。
- **手机可以增加工作区。** 禁用 `directory-picker-auto`（系统选目录框弹在宿主机上），钉住应用内 browse 选择器。
- **控制页迁到 设置 → 反向代理**（`settings.section`，order 30）。去掉 overlay 对话框和侧边栏 DOM 猜测。
- **轮换令牌不再卡死**串行锁；`proxy.close()` 有 2 秒宽限，SSE 钉不死停止/轮换。
- 启停/改地址失败用 toast 给出下一步；从隧道域名操作控制面的 403 会提示改用本机 `127.0.0.1` 窗口。

### 已知局限

见 [Known Limitations](README.md#known-limitations-and-deferred-work)。要点：远程页上的「在宿主机打开」会作用到这台电脑；设置左栏图标是 harness 默认齿轮；启停请在回环窗口操作。

### 从 0.2.0 升级

`dsh plugin --profile web update dsh-full-remote`，然后重启。冻结标识符（插件 id `reverse-proxy`、Cookie、控制前缀、状态文件）未改，已有会话继续有效。
```
