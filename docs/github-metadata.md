# GitHub metadata checklist

Apply these in the repository Settings (they cannot be changed from a commit).
Values are ready to paste.

## Description

```
Authenticated reverse-proxy bundle for remote & mobile access to DeepSeek
Harness Web. Point any tunnel (frp / ngrok / cloudflared / Tailscale / SSH)
at the token-gated local endpoint; full HTTP, SSE and WebSocket forwarding;
sidebar control panel with runtime listen-address switching.
```

## Topics

```
dsh-plugin deepseek-harness dsh reverse-proxy remote-access tunnel
mobile websocket security
```

Keep `dsh-plugin` first — GitHub topic pages and awesome-list scanners match
on it.

## Social preview

Settings → General → Social preview: use `docs/rp-demo-panel.png`.

## About sidebar

- Website: leave empty (or point at the npm page after first publish).
- Releases: keep enabled; tag the first release `v0.1.0`.
