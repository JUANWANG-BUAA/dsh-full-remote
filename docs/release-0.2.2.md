# v0.2.2 GitHub Release 正文

只把下面「发布说明」从 `## dsh-full-remote 0.2.2` 起到文末贴进
Release（或由 `gh release create` 使用同一段）。标题用 `v0.2.2`。
不要贴本段说明。链接一律用仓库绝对地址。

---

## dsh-full-remote 0.2.2

README 截图换成现行 **设置 → 反向代理** UI，并增加手机端应用内目录浏览器。
产品行为与 0.2.1 相同；这次把 npm `latest` 上的 README 图换对。

npm：[`dsh-full-remote@0.2.2`](https://www.npmjs.com/package/dsh-full-remote)

### 升级

已经装过的 profile **不会**在 `dsh web` 启动时自动拉新版本：

    dsh plugin --profile web update dsh-full-remote

然后重启 `dsh web`。第一次安装仍是：

    dsh plugin --profile web add dsh-full-remote

### 相对 0.2.1

- 控制页三张图改为设置对话框（左栏「反向代理」），不再是侧栏 overlay。
- 增加手机「选择工作区目录」实机截图（应用内浏览器，不是系统选目录框）。
- 登录门桌面 / 390×844 各重拍一张。

完整说明：[中文 README](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.2.2/README.zh.md) · [English README](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.2.2/README.md) · [CHANGELOG](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.2.2/CHANGELOG.md)

---

README screenshots now match **Settings → Reverse proxy**, plus a phone shot of the in-app workspace directory browser. Product behavior is unchanged from 0.2.1; this release updates `latest` so the npm README matches the Settings page.

Upgrade an existing install with `dsh plugin --profile web update dsh-full-remote`, then restart `dsh web`.
