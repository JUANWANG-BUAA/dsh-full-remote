# v0.2.1 GitHub Release 正文

只把下面「发布说明」从 `## dsh-full-remote 0.2.1` 起到文末贴进
<https://github.com/JUANWANG-BUAA/dsh-full-remote/releases/tag/v0.2.1>
（Edit release）。Release 标题用 `v0.2.1`。不要贴本段说明。

链接一律用仓库绝对地址；相对 `README.md` 在 Release 页会解析错。

---

## dsh-full-remote 0.2.1

隧道域名下官方设置会落盘，手机可以增加工作区，控制页迁到 **设置 → 反向代理**。

npm：[`dsh-full-remote@0.2.1`](https://www.npmjs.com/package/dsh-full-remote)

### 升级

已经装过的 profile **不会**在 `dsh web` 启动时自动拉新版本：

```sh
dsh plugin --profile web update dsh-full-remote
```

然后重启 `dsh web`。第一次安装仍是：

```sh
dsh plugin --profile web add dsh-full-remote
```

插件 id `reverse-proxy`、Cookie、控制前缀、状态文件名未改，已有会话继续有效。

### 相对 0.2.0

- 官方设置（语言 / 主题 / 模型等）在隧道域名下写入宿主机，不再只停在内存。
- 「增加新工作区」走应用内目录浏览器，不再在宿主机显示器上弹出系统选目录框。
- 反向代理控制面从侧边栏 overlay 迁到设置左栏。启动、停止、发布地址、令牌、设备都在 **设置 → 反向代理**。
- 轮换令牌不再卡死控制面。端口占用、自环、从隧道域名操作控制面，都会用 toast 说明下一步。

### 请注意

- 远程页上的「在宿主机打开」会作用到这台电脑。
- 启动 / 停止 / 显示令牌 / 改发布地址请用本机 `127.0.0.1` 窗口，不要从隧道或公网域名操作。
- 设置左栏图标是 harness 默认齿轮（官方只给内置页面配了图标）。双节点桥接图标在反向代理页本身。

完整说明：[中文 README](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.2.1/README.zh.md) · [English README](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.2.1/README.md) · [CHANGELOG](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.2.1/CHANGELOG.md)

---

Settings persist on a tunnel hostname, Add workspace works on a phone, and the control page is now **Settings → Reverse proxy**.

Upgrade an existing install with `dsh plugin --profile web update dsh-full-remote`, then restart `dsh web`. Frozen identifiers are unchanged, so existing sessions keep working.

Limitations: “open on host” from a remote page acts on the host machine; start/stop/token/listen only from the local `127.0.0.1` window.
