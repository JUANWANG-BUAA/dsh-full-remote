# v0.5.0 benchmark evidence / 原始证据

These are the measured artifacts used by the v0.5.0 release notes, retained in
Git rather than relying on the ignored local output directory.

- [summary.json](./summary.json): normalized per-round results, positive and negative deltas, raw-artifact SHA-256.
- [transport.json](./transport.json): 15 measured paired rounds + two excluded warm-up rounds, raw samples, source/asset identities and codec timing.
- [polling.json](./polling.json): real old/new React components with fake clock and RPC mocks, exact counts and start/end traces.
- [session.json](./session.json): five repetitions of real SSE with deterministic idle/absolute clocks, not wall-clock endurance.

Baseline: `0d4b48c8837ac4b11f3c477b1c04bde46c75f5d6` (already gzip). The current
source was the pre-release working tree; production source SHA-256 is recorded
in the artifacts. Documentation/version changes after measurement do not change
those production modules.

Read [English report](../../performance-benchmark.md) /
[中文报告](../../performance-benchmark.zh.md) for methodology, reproducible
commands and explicit limitations. Do not compare the gzip baseline to
uncompressed resources and call the difference this release's incremental gain.

原始结果不是统一的产品加速承诺；本机 HTTP、模拟时钟 RPC、确定性 SSE
各有独立范围，不代表手机 LCP、耗电、真实弱网或生产长尾。
