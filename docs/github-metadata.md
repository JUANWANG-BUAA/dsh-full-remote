# GitHub metadata checklist

These live in the repo's **About panel**, not under Settings. Values are
ready to paste.

## Where to edit

Repository homepage → right sidebar → **About** → **⚙ gear icon**. One dialog
holds the Description, Topics, and Website fields.

## Description (current About panel value)

```
Auditable, token-gated DeepSeek Harness remote gateway: mobile QR access, per-device sessions, Host/Origin rewrite, settings/credentials/directory support.
```

## Topics

```
dsh-plugin deepseek-harness dsh reverse-proxy remote-access tunnel mobile websocket security
```

Keep `dsh-plugin` first — GitHub topic pages and awesome-list scanners match
on it.

Apply with:

```sh
gh api -X PUT /repos/JUANWANG-BUAA/dsh-full-remote/topics \
  -H 'Accept: application/vnd.github+json' \
  -f names[]=dsh-plugin \
  -f names[]=deepseek-harness \
  -f names[]=dsh \
  -f names[]=reverse-proxy \
  -f names[]=remote-access \
  -f names[]=tunnel \
  -f names[]=mobile \
  -f names[]=websocket \
  -f names[]=security
```

## Social preview

Repository homepage → right sidebar → **About → ⚙** does not hold this one.
Instead: **Settings → General → Social preview → Edit** → upload
`docs/rp-demo-panel.png`.

## About sidebar extras

- Website: `https://www.npmjs.com/package/dsh-full-remote`.
- Releases: keep enabled; current tag is `v0.3.6`.

The description, homepage, and topics were applied with `gh repo edit` and
verified through the GitHub API on 2026-08-18. Social preview upload remains a
manual browser task; it is not required for publishing or installation.
