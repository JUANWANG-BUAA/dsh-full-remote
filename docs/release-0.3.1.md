# v0.3.1 GitHub Release 正文

只把下面「发布说明」从 `## dsh-full-remote 0.3.1` 起到文末贴进
Release（或由 `gh release create` 使用同一段）。标题用 `v0.3.1`。
不要贴本段说明。链接一律用仓库绝对地址。

---

## dsh-full-remote 0.3.1

Optional remote-entry release: a one-click Cloudflare quick tunnel and an
opt-in device home page, without changing the default login landing. Same-IP
invite retries now reuse the original device session instead of minting a
duplicate. Settings page layout and screenshots match the current panel.

npm：[`dsh-full-remote@0.3.1`](https://www.npmjs.com/package/dsh-full-remote)

### Upgrade

Already installed profiles do **not** pick up a new version when `dsh web`
starts:

```bash
dsh plugin --profile web update --latest dsh-full-remote
```

Then restart `dsh web`. A bare `update dsh-full-remote` does **not** move
an exact pin such as `0.3.0`. First install remains:

```bash
dsh plugin --profile web add dsh-full-remote
```

### Relative to 0.3.0

- **One-click Cloudflare quick tunnel** from Settings → Reverse proxy:
  resolves `cloudflared` via `cloudflaredPath` → PATH → a pinned,
  SHA256-verified download, then `cloudflared tunnel --url` in front of
  the proxy listener. The token gate, approval, CIDR and audit still
  apply. Quick-tunnel URLs are random per start and are never persisted.
  Local TLS and the quick tunnel are mutually exclusive.
- **Device home** at `/_dsh_reverse_proxy/home`: session facts, self-rename
  and self-logout. Login still lands on `/` by default; a secondary button
  on the token form opens the home page.
- Invite retry grace: the same code from the same IP within 60 seconds
  reuses the original device session (a kicked device cannot come back
  through the grace window).
- Settings page: listen address first, recommended-usage guide, inline
  device rename (no `window.prompt`), self-check always reports token-read
  on/off.
- Control-surface JSON: malformed bodies stay `400 invalid-request`;
  unexpected handler throws become `500 action-failed`.
- Wait-page poll script embeds URLs and copy via JSON, not HTML escaping.
- README / npm screenshot gallery recaptured (including device home and
  the approval wait page).

Full notes: [CHANGELOG](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.3.1/CHANGELOG.md) · [中文 README](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.3.1/README.zh.md) · [English README](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.3.1/README.md)
