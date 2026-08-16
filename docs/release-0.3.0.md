## dsh-full-remote 0.3.0

Product hardening for phone invite, fence self-check, audit, and ops controls.

### Upgrade

```bash
dsh plugin --profile web add dsh-full-remote@0.3.0
```

### Highlights

- Settings → Reverse proxy **Fence self-check** (`settings.describe` + trust bootstrap).
- **Phone invite**: QR + `login?token=` auto-submit.
- JSONL **audit log** (default on), **CIDR allowlist**, **idle timeout**, **device rename**.
- Optional **local TLS** (`tlsCertFile` / `tlsKeyFile`).
- Split read/write control gates; `sec-fetch-site` normalized; ModuleLoader wrap warns on failure.
- Sessions rehydrate from the state file across restarts.

### Notes

- Set `allowTokenRead: false` to disable standing `GET /token`.
- Weekly upstream canary workflow: `.github/workflows/canary.yml`.
