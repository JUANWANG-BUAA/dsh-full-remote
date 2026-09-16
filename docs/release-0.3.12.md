# v0.3.12 GitHub Release

## dsh-full-remote 0.3.12

This release fixes [#31](https://github.com/JUANWANG-BUAA/dsh-full-remote/issues/31): the reverse proxy now starts correctly when DeepSeek Harness Desktop launches its embedded backend with `--skip-auth` (`DSH_SKIP_AUTH=1`).

In that mode Harness serves the launch URL directly with HTTP 2xx and does not create an upstream browser-session cookie. dsh-full-remote now recognizes that explicit configuration while keeping its own access-token and per-device session gate fully enabled. Cookie-free 2xx responses still fail closed during normal authenticated operation.

### Upgrade

```sh
dsh plugin --profile web update --latest dsh-full-remote
```

Restart `dsh web` after updating.

Full notes: [CHANGELOG](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.3.12/CHANGELOG.md) · [中文 README](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.3.12/README.zh.md) · [English README](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/v0.3.12/README.md)
