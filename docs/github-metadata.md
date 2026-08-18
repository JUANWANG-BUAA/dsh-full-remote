# GitHub metadata checklist

These live in the repo's **About panel**, not under Settings. Values are
ready to paste.

## Where to edit

Repository homepage → right sidebar → **About** → **⚙ gear icon**. One dialog
holds the Description, Topics, and Website fields.

## Description (paste in one line, ~190 chars — well under the 350 limit)

```
Remote DeepSeek Harness with full server-side API access: Host/Origin rewrite restores settings.* / credentials.* / host.listDirectory. Token gate, per-device sessions, mobile panel.
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

- Website: leave empty (or point at the npm page after first publish of
  `dsh-full-remote`).
- Releases: keep enabled; current tag is the latest release shown on the
  repository page (the next planned release is `v0.3.3`).
