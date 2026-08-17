# v0.3.0 GitHub Release 正文

只把下面「发布说明」从 `## dsh-full-remote 0.3.0` 起到文末贴进
Release（或由 `gh release create` 使用同一段）。标题用 `v0.3.0`。
不要贴本段说明。链接一律用仓库绝对地址。

---

## dsh-full-remote 0.3.0

Security fix release: with `trustForwardedFor` enabled behind a
non-Cloudflare tunnel (ngrok/frp/SSH), a remote client could inject
`CF-Connecting-IP: 127.0.0.1` and impersonate loopback — bypassing the
CIDR allowlist and per-IP rate limiting. Forwarded values are now only
trusted when they are literal, non-loopback IPs. Also ships device source
IPs in the panel, audit-log rotation, and run-state invite gating.

npm：[`dsh-full-remote@0.3.0`](https://www.npmjs.com/package/dsh-full-remote)

### Upgrade

Already installed profiles do **not** pick up a new version when `dsh web`
starts:

```bash
dsh plugin --profile web update --latest dsh-full-remote
```

Then restart `dsh web`. A bare `update dsh-full-remote` does **not** move
an exact pin such as `0.2.5`. First install remains:

```bash
dsh plugin --profile web add dsh-full-remote
```

### Relative to 0.2.5

- **Security:** forwarded client-IP headers (`CF-Connecting-IP` /
  rightmost `X-Forwarded-For`) are only trusted when they are literal,
  non-loopback IPs — a client-injected loopback value can no longer bypass
  `allowedCidrs` or evade login/upgrade rate limiting.
- Device sessions record the source IP at login and at the most recent
  request; the panel shows it per device ("Source IP").
- The audit log rotates past 8 MB, keeping one previous generation.
- Invites can only be generated while the proxy is running (`409
  not-running`; the panel disables the button with a hint). A QR for a
  stopped proxy could only fail to connect.
- Fixes: audit viewer limit now applies after the event filter; control
  actions answer `500` instead of hanging when an operation rejects;
  login cookie no longer emits `Max-Age=undefined` when
  `sessionMaxAgeSeconds` is omitted; control routes accept every 127/8
  loopback alias; non-http(s) invite bases are rejected; upstream connect
  timer disarmed on the body-overflow path; concurrent first state loads
  share one read; audit export download is no longer cancelled in Firefox;
  empty audit limit input falls back to the default.

Full notes: [CHANGELOG](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.3.0/CHANGELOG.md) · [中文 README](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.3.0/README.zh.md) · [English README](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.3.0/README.md)
