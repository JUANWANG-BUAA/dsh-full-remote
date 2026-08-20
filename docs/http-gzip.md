# HTTP gzip and hashed-asset cache

Contract for GitHub issue
[#11](https://github.com/JUANWANG-BUAA/dsh-full-remote/issues/11).
This document is the source of truth for what the proxy compresses, what
it does not, and which size numbers may be quoted. It is **not** a claim
of “95%+” savings, and it does not cover WebSocket smoothness.

中文版：[HTTP gzip](./http-gzip.zh.md)。

## Scope

After authentication, the reverse proxy may gzip **HTTP responses** it
forwards from Harness Web, and may add a long-cache header on
**content-hashed** `/assets/*` files.

It does **not** compress:

- WebSocket upgrades (status 101; the proxy is a raw byte pipe)
- `text/event-stream` (SSE must stay a live event stream)
- fonts (Harness serves `.ttf` / `.woff` / `.woff2` as
  `application/octet-stream`)
- bodies that already have a non-identity `Content-Encoding`
- `HEAD` / `CONNECT`, and status `204` / `206` / `304`
- bodies whose `Content-Length` is present and below 1024 bytes
- plugin gate pages (`sendHtml`: login / wait / home)

`index.html` and `/api` never receive the hashed-asset cache header.

## Configuration

| Option | Default | Effect |
|---|---|---|
| `compressResponses` | `true` | Gzip compressible types when the client sends `Accept-Encoding: gzip` (q > 0) |
| `cacheHashedAssets` | `true` | `Cache-Control: public, max-age=31536000, immutable` on hashed `/assets/*` 200s that have no upstream `Cache-Control` |

Set either to `false` in the `reverse-proxy` row to turn that path off.

## Measured (2026-08-20)

Fixture: `@deepseek-ai/dsh-web-frontend@0.1.0-rc.6` `dist`, gzip level 6,
through this proxy. Re-run with
`node --experimental-strip-types --test tests/compress-matrix.test.ts`
(set `DSH_WEB_FRONTEND_DIST` if the Homebrew global path is absent).

### First load (`index.html` + hashed index/vendor JS and CSS)

**1,285,699 → 350,802 bytes (−72.7%).** This is the number to quote for
remote first paint of the Harness shell.

| File | Raw | Wire | Saved |
|---|---:|---:|---:|
| `vendor-*.js` | 744,872 | 180,729 | −75.7% |
| `index-*.js` | 442,711 | 149,984 | −66.1% |
| `index-*.css` | 67,798 | 11,357 | −83.2% |
| `vendor-*.css` | 29,642 | 8,056 | −72.8% |
| `index.html` | 676 | 676 | skipped (&lt; 1 KB) |

### All 89 dist files

**4,621,051 → 1,707,217 (−63.1%).** Lower than first-load because 59 font
files (~1.07 MB) are left uncompressed on the wire.

| Kind | Files | Gzipped | Wire saving |
|---|---:|---:|---:|
| `.js` | 25 | 25 | −82.2% |
| `.css` | 2 | 2 | −80.1% |
| `.svg` (`/favicon.svg`) | 1 | 1 | −51.9% |
| fonts (ttf/woff/woff2) | 59 | 0 | 0% |
| `index.html` / `manifest.webmanifest` | 2 | 0 | below 1 KB |

86 hashed `/assets/*` responses received `immutable`. The three that did
not: `/index.html`, `/favicon.svg`, `/manifest.webmanifest`.

A language-pack file such as `langs/cpp-*.js` can gzip around −92%. That
is real, but it is not the first-load path and must not be used as the
product headline.

### Why “95%+” is not a product number

`tests/compress-matrix.test.ts` includes a JSON size sweep of repeated
padding. At 1024 bytes and above, gzip of that fixture reaches −96% and
higher. Tiny JSON (12 bytes) **grows** (12 → 32). Issue #11’s “95%+”
figure matches this kind of redundant padding, not a Harness UI payload.
It is not an acceptance criterion.

### Gate pages (not gzipped)

Login HTML as actually served: 2413 bytes, no `Content-Encoding`.
`gzipSync` potential −47.7% (~1.2 KB). Wait / home pages are similar.
Left uncompressed on purpose: first-load JS/CSS is hundreds of kilobytes
of saving; gate pages are about one kilobyte.

### Cloudflare quick tunnel

The Cloudflare edge typically already compresses HTML/JS/CSS/JSON.
Proxy-side gzip mainly helps LAN, SSH, and frp paths that do not
compress. Live model output uses WebSocket and is unchanged.

## Tests

- `tests/compress.test.ts` — predicates, SSE delayed second event, skip
  fonts / tiny JSON / already-encoded bodies, real `vendor-*.js`
- `tests/compress-matrix.test.ts` — every dist file through the proxy;
  skipped when the frontend dist is not present

## Shipping

Shipped in `dsh-full-remote@0.3.5`. Close issue #11 after this version is
on npm.
