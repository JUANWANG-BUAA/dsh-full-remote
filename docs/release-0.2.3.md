# v0.2.3 GitHub Release 正文

只把下面「发布说明」从 `## dsh-full-remote 0.2.3` 起到文末贴进
<https://github.com/JUANWANG-BUAA/dsh-full-remote/releases/tag/v0.2.3>
（Edit release）。Release 标题用 `v0.2.3`。不要贴本段说明。

链接一律用仓库绝对地址；相对 `README.md` 在 Release 页会解析错。

---

## dsh-full-remote 0.2.3

Product hardening for phone invite, fence self-check, audit, and ops
controls. Host sources are now fully typed TypeScript.

### Upgrade

```bash
dsh plugin --profile web update dsh-full-remote
```

（新装用 `dsh plugin --profile web add dsh-full-remote@0.2.3`。）

### Highlights

- Settings → Reverse proxy **Fence self-check** (`settings.describe` + trust
  bootstrap).
- **Phone invite**: QR + one-time `?invite=` link (single use, 15 min TTL;
  the standing token never appears in the URL).
- JSONL **audit log** (default on), **CIDR allowlist**, **idle timeout**,
  **device rename**.
- Optional **local TLS** (`tlsCertFile` / `tlsKeyFile`).
- Split read/write control gates; `sec-fetch-site` normalized; ModuleLoader
  wrap warns on failure.
- Sessions rehydrate from the state file across restarts.
- Host sources migrated `.js` → `.ts` with `noImplicitAny` enabled; unit
  tests run as plain JS through `node --experimental-strip-types`.
- Weekly upstream canary workflow: `.github/workflows/canary.yml`.

### Notes

- Set `allowTokenRead: false` to disable standing `GET /token`.
- Full list of fixes and changes: [CHANGELOG.md](https://github.com/JUANWANG-BUAA/dsh-full-remote/blob/main/CHANGELOG.md#023-2026-08-16).
