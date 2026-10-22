# Transport optimization benchmark

[中文报告](./performance-benchmark.zh.md)

## Bottom line

Compared with the **previous implementation, which already used gzip**, the main gains in the changes included in 0.5.0 are:

1. **Warm static requests avoid upstream reads and repeated encoding.** Four real entry assets repeated ten times: upstream requests 40 → 0; median cumulative local HTTP download time 424.68 → 28.15 ms (−93.4%). This is not a 93.4% improvement in mobile page-load speed.
2. **Hidden panels stop unnecessary polling.** Real old/new React components under a simulated clock: 50 → 0 RPCs during 60 hidden seconds. Normal visible polling stays at 50, rather than lowering the refresh frequency to claim a gain.
3. **Cold response bytes barely change.** 415,637 → 415,534 B: just **103 B / 0.025%** less. Existing gzip savings are not counted again.
4. **Not every case is faster or smaller.** Cached 304 metadata is larger; the synthetic JSON API takes about 16.2% longer locally; real vendor JS and index CSS are slightly larger with Brotli Q4 than gzip L6.

These scenarios do not support a single “the entire product is X% faster” claim.

## 1. Baseline, environment and raw results

- Baseline: Git `0d4b48c8837ac4b11f3c477b1c04bde46c75f5d6`, extracted unchanged with `git archive` — **not the current implementation with compression/cache switches disabled**.
- Candidate: the optimized, then-uncommitted workspace whose changes are included in 0.5.0; product logic was not modified for the benchmark. This is not a measurement of a separately downloaded release tarball.
- Environment: Apple M5 Pro / arm64 / macOS kernel Darwin 27.0.0 / Node v26.12.0.
- HTTP: loopback HTTP/1.1 on one machine, serial requests, a new downstream TCP connection per request. No TLS, Cloudflare, mobile network, browser cache or page rendering.
- Fifteen measured paired rounds, excluding two warm-up rounds; the three variants rotate and reverse order. Decoded byte equality, cold/warm upstream request counts and negotiated encodings are asserted.
- Resources: real local Harness frontend dist `index.html`, two entry JS files and two CSS files, totaling **1,480,308 B**. Not repetitive padding, and not all fonts or lazy-loaded resources.
- A separate 7,314 B **synthetic JSON** response is an uncached negative control, not a sample of actual chat/session API traffic.
- Raw records: `output/benchmarks/transport.json` (rounds, source/resource SHA-256 and measured encodings), `polling.json` (request start/end events), and `session.json` (five behavioral rounds).
- Retained release evidence: [summary](./benchmarks/v0.5.0/summary.json), [transport rounds](./benchmarks/v0.5.0/transport.json), [polling events](./benchmarks/v0.5.0/polling.json), and [session observations](./benchmarks/v0.5.0/session.json). These preserve the final results in the repository and release assets. Reproduction writes fresh results to ignored `output/benchmarks/summary.json` and the raw paths above; it does not overwrite the retained release evidence.

**The baseline already uses gzip level 6; the candidate prefers Brotli quality 4 at equal browser weights.** A candidate gzip-only variant separates caching from algorithm selection. Node v26's default global Agent already uses keep-alive, so connection reuse is not claimed as a new 100% gain.

## 2. HTTP comparison

Values are **per paired round**, not the sum of all fifteen rounds. Each time is the sum of request-to-complete-body HTTP durations, then the median of fifteen rounds. Client decompression/equality checks and rendering are excluded: this is not LCP.

| Scenario | Requests/round | Old body B | Candidate body B | Old upstream requests | Candidate upstream requests | Old cumulative HTTP ms | Candidate cumulative HTTP ms | Time change |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Cold device, HTML + 4 entry assets | 5 | 415,637 | 415,534 | 5 | 5 | 42.08 | 25.61 | −39.1% |
| Same-device warm reads, 4 assets × 10 | 40 | 4,148,120 | 4,147,090 | 40 | 0 | 424.68 | 28.15 | −93.4% |
| Same-device conditional requests, 4 assets × 10 | 40 | 0 | 0 | 40 | 0 | 24.10 | 17.51 | −27.3% |
| Synthetic dynamic JSON API × 10 | 10 | 6,960 | 4,050 | 10 | 10 | 8.82 | 10.25 | **+16.2%** |

### How to interpret the numbers

- **Cold** means a device has no server-side static variant, not a new process or an empty connection pool. The server and pool are warmed.
- Warm reads deliberately bypass browser caching to measure proxy caching. The baseline repeatedly fetches and encodes; the candidate sends encoded bytes from its device-isolated LRU. Warm upstream raw body bytes fall **14,794,830 → 0 B/round**, but downstream clients still receive about 4.15 MB: this is not a 100% reduction in client traffic.
- A fresh browser immutable-cache hit may avoid the network in either version. That existing capability is not counted as a new gain.
- The backend correctly handles weak ETags in both versions: **the baseline already returns 304 with a zero-byte body**. The new gain is avoiding upstream requests, not reducing a nonzero body to zero.
- Cached 304 responses carry more Cache-Control / Vary / Age metadata. Total downstream HTTP bytes across forty requests increase **6,360 → 9,800 B (+54.1%)**, or 86 B per request. With zero bodies, these are header bytes; this overhead is not hidden.
- Dynamic API request counts and upstream bodies stay identical, confirming the API is not incorrectly cached. Brotli makes this synthetic response smaller, but these tiny local requests take longer; not all APIs are faster.

### Same-encoding control: caching gains do not depend on Brotli

| Scenario | Old gzip ms | Candidate gzip-only ms | Candidate negotiated Brotli ms |
|---|---:|---:|---:|
| Cold entry resources | 42.08 | 44.20 | 25.61 |
| 40 warm static requests | 424.68 | 27.88 | 28.15 |
| 40 conditional requests | 24.10 | 17.63 | 17.51 |

The candidate gzip-only cold path has about **5.0% local overhead**; the warm path still improves greatly without changing encoding. Brotli client decoding can also be slower: median wall time for the entire warm loop, including decoding/assertions, is 447.31 ms for the baseline, 48.53 ms for candidate gzip, and 60.02 ms for candidate Brotli. HTTP download time is not the complete client cost.

### Variation

| Scenario | Old median / sample p95 ms | Candidate median / sample p95 ms |
|---|---:|---:|
| Cold device | 42.08 / 45.60 | 25.61 / 27.29 |
| Warm static | 424.68 / 446.87 | 28.15 / 33.04 |
| Conditional | 24.10 / 29.45 | 17.51 / 21.29 |
| Synthetic dynamic JSON | 8.82 / 11.10 | 10.25 / 12.53 |

With only fifteen rounds, nearest-rank p95 is the sample maximum, not a production tail-latency SLO or confidence interval. Load, Node/zlib versions, network, concurrency and resource changes affect timings; use fresh measurements when reproducing.

## 3. Compression size and encoding cost

Each file/algorithm also receives three warm-ups and twenty synchronous encodes, alternating algorithm order. This measures encoding latency, not production asynchronous-worker throughput or total CPU utilization.

| Resource | Raw B | gzip L6 B | Brotli Q4 B | Median gzip encode ms | Median Brotli encode ms |
|---|---:|---:|---:|---:|---:|
| index JS | 633,282 | 213,609 | 212,891 | 16.24 | 6.95 |
| vendor JS | 740,575 | 178,527 | 178,714 | 13.12 | 5.96 |
| vendor CSS | 29,288 | 8,066 | 7,680 | 0.20 | 0.13 |
| index CSS | 76,338 | 14,610 | 15,424 | 0.87 | 0.50 |

For these real resources, **Q4 encodes faster than L6**; cold bytes do not suddenly shrink by tens of percent. Quality levels differ: this is not a claim that Brotli universally beats gzip at equal quality.

## 4. Background polling benchmark

The benchmark mounts the **actual old RemoteSection** extracted with `git archive` and the actual current component. Only ProxyApi status/sessions are mocked. jsdom / React 18.3.1 / Vitest 4.1.10 simulated clocks advance every 100 ms and flush React. Counts are observed, not calculated from interval constants.

Windows are half-open and the initial request belongs to the first: `[0,60s)`, `[60,120s)`, `[120,180s)`. The tunnel is online. Fast RPCs complete immediately; slow RPCs take exactly five seconds, including the initial request.

| Scenario | Old RPCs | Candidate RPCs | Change |
|---|---:|---:|---:|
| Normally visible for 60 s | 50 (status 30 + sessions 20) | 50 | 0% |
| Visible → hidden for 60 s | 50 | 0 | **−100%** |
| Visible again after hiding, 60 s | 50 | 50 | 0%; both candidate data sources refresh immediately on recovery |
| Five-second RPCs, visible for 60 s | 48 | 20 | **−58.3%** |
| Peak total in-flight slow RPCs | 5 | 2 | **−60%** |

Slow per-method peaks are status 3 → 1 and sessions 2 → 1: requests of the same kind no longer overlap, rather than a global one-RPC limit. Fewer slow requests do not mean faster refreshes, and hidden-time polls are not replayed as a backlog.

The simulator deliberately does not apply real browser background-timer throttling, isolating application visibility behavior. Real mobile browsers may already throttle/freeze the baseline, so **50 → 0 does not imply 100% real battery savings**. In-flight requests are not cancelled. Only these two plugin-managed RPCs are counted, not chat or other plugins.

Repeated runs reproduce the counts and JSON. Normal visible refresh frequency does not fall. Transient concurrency differences caused by fast-Promise microtask ordering are not marketed as performance gains.

## 5. Active-session behavior

A real HTTP/SSE byte pipeline uses a controlled store clock. The activity case sets idle timeout to one second; the absolute-TTL case disables idle expiry to isolate the variable. Events arrive every simulated 800 ms; serialization after receiving each event simulates a persistence sweep. Each scenario runs five times with consistent results. This is deterministic session behavior, not an 80-second wall-clock endurance or reconnection test.

| Scenario | Old | Candidate |
|---|---|---|
| Continuous activity to simulated 80 s, absolute TTL 600 s | Sweep removes session at 1.6 s; existing stream stays open; new request 303 | All 101 events received; session retained; new request 200 |
| Absolute TTL 2 s, bytes still arriving every 800 ms | Session invalid but existing stream continues, still delivering at simulated 4 s | Closes at next event at simulated 2.4 s; expired event is not delivered; new request 303 |

This improves idle-activity recognition and invalid-stream cleanup. It **does not extend absolute TTL, guarantee lossless recovery of disconnected events, or replay writes**. Idle expiry is disabled by default; the first row concerns deployments that enable it.

## 6. Reproduction

Run from the repository root with dependencies installed and the Git baseline above available. The HTTP test requires a real frontend dist; it defaults to the local global Harness dist, or specify one explicitly:

~~~bash
# 15 measured rounds, 2 excluded warm-ups; 10 warm/conditional repetitions
DSH_WEB_FRONTEND_DIST=/path/to/dsh-web-frontend/dist \
  BENCH_ROUNDS=15 BENCH_REPEATS=10 \
  node --experimental-strip-types scripts/benchmark-transport.mjs

# Real SSE, deterministic store clock, five paired rounds
node --experimental-strip-types scripts/benchmark-session.mjs

# Actual old/new React components, simulated clocks and RPCs
NODE_ENV=test NODE_OPTIONS=--no-experimental-webstorage \
  pnpm exec vitest run --config scripts/bench-polling/vitest.config.ts

# Portable summary of all three raw JSON records, including SHA-256
node scripts/summarize-benchmark.mjs

# Standalone script lint
pnpm exec eslint scripts/benchmark-transport.mjs scripts/benchmark-session.mjs scripts/summarize-benchmark.mjs scripts/bench-polling
~~~

The scripts do not checkout/reset the user's workspace or access active user sessions. Proxies bind only random loopback ports and close after testing. Run the separate benchmarks sequentially to avoid CPU contention. Scripts read the local dist but **do not execute its page JavaScript**.

## 7. Not measured

- Real mobile page LCP/INP, scrolling, battery consumption, weak networks, or actual tunnel RTT.
- Production concurrent throughput, persistence IOPS, whole-process CPU/RSS/peak heap, or sustained cache-eviction pressure.
- Incremental chat-stream encoding, replay of events missed while disconnected, or shared cross-device caching (deliberately prohibited).

The supported conclusion is: **warm static hits substantially reduce proxy/upstream work, and hidden/slow polling avoids unnecessary calls; cold bytes stay almost unchanged, with overhead in some metadata and dynamic requests.** Not “93% faster overall” or “100% less traffic.”
