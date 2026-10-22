# HTTP compression, static caching and session activity — 0.5.0

[中文](./http-gzip.zh.md) · [0.5.0 release notes](./releases/v0.5.0.md) · [Benchmark report (中文)](./performance-benchmark.zh.md)

This document defines the **0.5.0** transport contract. Compression existed before this release; the new work adds negotiated Brotli, bounded device-private static reuse, activity-aware sessions and visibility-aware polling. It does not promise “95%+” product savings or faster WebSocket output.

## 1. Configuration

The existing reverse-proxy configuration switches are unchanged:

| Option | Default | 0.5.0 behavior |
|---|---|---|
| `compressResponses` | `true` | Negotiate Brotli quality 4 / gzip level 6 for eligible HTTP responses |
| `cacheHashedAssets` | `true` | Admit eligible hashed assets to private immutable browser caching and bounded device-scoped encoded caching |

Set either to `false` in the `reverse-proxy` row to disable that path. **The old public-cache policy in the historical section is not the current configuration.**

## 2. Compression and streaming boundaries

After authentication, forwarded HTTP responses may be transformed according to strict `Accept-Encoding` q values. Brotli wins ties with gzip; an explicitly higher preference for identity leaves the response uncompressed. Brotli Q4 is not guaranteed smaller than gzip L6.

Both request and response `Cache-Control: no-transform` are respected. Existing upstream encodings are preserved. The proxy merges `Vary: Accept-Encoding` for negotiated identity variants too, weakens strong ETags after transformation, and removes invalid length/digest metadata.

The proxy does **not** compress:

- WebSocket upgrades (101; raw byte forwarding), SSE (`text/event-stream`) or range responses;
- fonts, raster images or other non-compressible types;
- already non-identity encoded bodies;
- `HEAD` / `CONNECT`, or statuses 204 / 206 / 304;
- bodies with a known `Content-Length` below 1024 bytes;
- plugin gate pages (login / wait / home).

SSE and WebSocket remain live streams: no injected heartbeat and no automatic write replay. Proxy compression does not establish a Cloudflare-edge, cellular or whole-page performance improvement.

## 3. Static caching: private, bounded and authenticated

### Browser cache

Only strictly admitted content-hashed `/assets/*` paths with appropriate MIME types receive the generated `Cache-Control: private, max-age=31536000, immutable` policy, and only if upstream supplied neither a cache policy nor `Expires`. Existing `no-store`, `no-cache`, `must-revalidate` and other upstream freshness constraints are not overridden. HTML, `Set-Cookie` and unknown `Vary` never gain long-lived caching merely from a hashed filename.

A fresh browser cache can avoid the entire network request; it does not necessarily produce a 304. Revocation cannot remotely erase assets already downloaded into a browser's private cache. New network requests still require authentication.

### Encoded-variant cache in the proxy

- An authenticated, per-device LRU holds at most **8 MiB / 128 entries**; each entry including headers/key is at most **1 MiB**, with at most **five minutes** freshness.
- Upstream `max-age`, `Age`, `Date`, `Expires` and generation time can shorten that freshness. Hits retain correctly increasing `Age`.
- Keys include device identity, full URL and `Accept-Encoding`; variants are never shared across devices.
- No HTML, dynamic API/chat, request bodies, ranges, `Authorization`, secret queries, `Set-Cookie` or unknown `Vary` are admitted. At most eight bounded captures run concurrently without buffering delivery.
- Authentication and CIDR checks precede every hit. Revocation, token rotation and proxy stop invalidate the relevant cache entries.
- Fresh same-device/encoding hits avoid upstream and re-encoding. ETag / Last-Modified conditional hits can return bodyless 304 responses. A zero-byte body does not mean zero HTTP bytes: headers still cost bandwidth.

## 4. Connections, device activity and polling

The proxy owns an upstream keep-alive pool capped at **64 sockets/origin, 128 total and eight idle sockets**, destroyed on stop. This is not a claim that older Node deployments never reused connections.

Actual HTTP request/response and WebSocket bytes update device activity; an open socket by itself does not renew a session. Persistence notification is throttled to one second. Activity cannot extend absolute TTL or cross credential reissue, revocation or hydration generations. Quiet leases are checked every second; invalid streams close both peers. These changes do not guarantee lossless reconnect or replay writes.

Hidden settings pages pause device/tunnel polling; visibility recovery pulls once, and slow requests stay single-flight per method. Cockpit automatic recoveries coalesce at a five-second minimum spacing; manual refresh may run immediately but shares the flight. The cockpit only observes the host connection: a connected channel is **not** proof of synchronized session state.

## 5. 0.5.0 measurements and limitations

### Body sizes, not general product ratios

| Content | Raw | gzip L6 | Brotli Q4 |
|---|---:|---:|---:|
| Highly repetitive fixture | 17,100 B | 138 B | 57 B |
| Real local `vendor-CCJJTK99.js` | 740,575 B | 178,527 B | 178,714 B |

The repetitive fixture is not representative of the frontend. The real vendor file is slightly **larger** with Brotli Q4.

### Paired local HTTP benchmark

The [full benchmark report](./performance-benchmark.zh.md) compares the unmodified baseline `0d4b48c8837ac4b11f3c477b1c04bde46c75f5d6` (**already gzip L6**) with the implementation released as 0.5.0. It uses real frontend resources, **15 measured paired rounds plus two excluded warm-ups**, loopback HTTP/1.1 and no browser rendering, TLS, tunnel or cellular network. Times below are medians of summed issue-to-response-end times per round, not page-load times.

| Scenario | Baseline | 0.5.0 | Interpretation |
|---|---:|---:|---|
| Cold-device HTML + four entry resources, body | 415,637 B | 415,534 B | Only 103 B / 0.025% smaller |
| 40 warm static requests, upstream requests | 40 | 0 | Same device and encoding; downstream still receives about 4.15 MB |
| 40 warm static requests, HTTP time | 424.68 ms | 28.15 ms | −93.4% for this local proxy scenario, not overall product speed |
| 40 conditional responses, complete downstream HTTP bytes | 6,360 B | 9,800 B | **+54.1%** from additional headers; both versions already send 0 B bodies |
| Ten synthetic JSON API requests, HTTP time | 8.82 ms | 10.25 ms | **+16.2%**; not a real chat API sample |
| Cold-device HTTP time, gzip-only control | 42.08 ms | 44.20 ms | **About +5.0%**; Brotli cold result is 25.61 ms |

In simulated-clock tests of real React components, hidden-60-second polling falls from 50 RPCs to zero while ordinary visible polling stays at 50. This is application behavior, not a measured 100% battery saving. The report also separates deterministic session behavior from real wall-clock endurance and documents unmeasured CPU/RSS, production concurrency and phone LCP/INP.

## 6. Repeatable coverage

- `tests/encoding.test.ts`: negotiation and transformation boundaries.
- `tests/static-cache.test.ts`: eligibility, isolation, bounded freshness and conditional responses.
- `tests/transport.test.ts` / `tests/stream-activity.test.ts`: transport and session activity/expiry.
- Client visibility-polling / cockpit-connection tests: hidden-page polling and recovery behavior.
- `tests/compress.test.ts` / `tests/compress-matrix.test.ts`: compression predicates and real frontend resources (matrix skips if dist is absent).

See the benchmark report for reproduction commands and exact provenance. The fixed [0.5.0 summary](./benchmarks/v0.5.0/summary.json) and raw JSON records are archived under `docs/benchmarks/v0.5.0`; reproduction still writes to the ignored local `output/benchmarks` directory. Publishing 0.5.0 does not imply a new benchmark run.

## 7. Historical archive — 0.3.5 gzip baseline (not 0.5.0 policy)

The following preserves the earlier [issue #11](https://github.com/JUANWANG-BUAA/dsh-full-remote/issues/11) measurements. **0.3.5 already used gzip L6** and generated `Cache-Control: public, max-age=31536000, immutable` for hashed asset 200s without upstream `Cache-Control`. That historical public policy is superseded by the strict private policy in sections 1–3. Its resource set differs from the 0.5.0 benchmark, so the absolute totals must not be compared as release-to-release gains.

### Historical measurements (2026-08-20)

Fixture: `@deepseek-ai/dsh-web-frontend@0.1.0-rc.6` `dist`, gzip level 6,
through this proxy. Re-run with
`node --experimental-strip-types --test tests/compress-matrix.test.ts`
(set `DSH_WEB_FRONTEND_DIST` if the Homebrew global path is absent).

#### First load (`index.html` + hashed index/vendor JS and CSS)

**1,285,699 → 350,802 bytes (−72.7%).** This was the measured 0.3.5 shell payload, not a 0.5.0 improvement or a browser paint-time measurement.

| File | Raw | Wire | Saved |
|---|---:|---:|---:|
| `vendor-*.js` | 744,872 | 180,729 | −75.7% |
| `index-*.js` | 442,711 | 149,984 | −66.1% |
| `index-*.css` | 67,798 | 11,357 | −83.2% |
| `vendor-*.css` | 29,642 | 8,056 | −72.8% |
| `index.html` | 676 | 676 | skipped (&lt; 1 KB) |

#### All 89 dist files

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

#### Why “95%+” is not a product number

`tests/compress-matrix.test.ts` includes a JSON size sweep of repeated
padding. At 1024 bytes and above, gzip of that fixture reaches −96% and
higher. Tiny JSON (12 bytes) **grows** (12 → 32). Issue #11’s “95%+”
figure matches this kind of redundant padding, not a Harness UI payload.
It is not an acceptance criterion.

#### Gate pages (not gzipped)

Login HTML as actually served: 2413 bytes, no `Content-Encoding`.
`gzipSync` potential −47.7% (~1.2 KB). Wait / home pages are similar.
Left uncompressed on purpose: first-load JS/CSS is hundreds of kilobytes
of saving; gate pages are about one kilobyte.

#### Cloudflare quick tunnel

The Cloudflare edge typically already compresses HTML/JS/CSS/JSON.
Proxy-side gzip mainly helps LAN, SSH, and frp paths that do not
compress. Live model output uses WebSocket and is unchanged.
