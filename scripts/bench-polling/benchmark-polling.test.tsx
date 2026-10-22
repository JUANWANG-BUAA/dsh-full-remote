/**
 * Reproduce: pnpm exec vitest run --config scripts/bench-polling/vitest.config.ts
 * Simulated-clock real-component / mocked-RPC benchmark, NOT a real browser,
 * HTTP bytes/latency, mobile radio, or battery measurement. Deliberately outside
 * the regular tests/ suite. The companion config archives the fixed old source.
 */
import type { ComponentProps, ComponentType } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RemoteSection } from '../../src/client/RemoteSection.tsx'
import { translatorFor, en } from '../../src/client/i18n.ts'
import type { ProxyApi, ProxyStatus, SessionInfo } from '../../src/client/types.ts'

// Vitest's jsdom transform targets web imports; obtain Node-only output helpers
// from the actual Node host instead of allowing Vite to browser-stub node: imports.
const { createHash } = process.getBuiltinModule('crypto')
const { execFileSync } = process.getBuiltinModule('child_process')
const { mkdirSync, readFileSync, writeFileSync } = process.getBuiltinModule('fs')
const { resolve } = process.getBuiltinModule('path')
const revision = '0d4b48c8837ac4b11f3c477b1c04bde46c75f5d6'
const durationMs = 60_000
const stepMs = 100
const root = process.cwd()
const baselinePath = resolve(root, 'output/benchmarks/polling-baseline')
type Variant = 'baseline' | 'current'
type Method = 'status' | 'sessions'
type Props = ComponentProps<typeof RemoteSection>
type RpcEvent = { method: Method, action: 'start' | 'end', atMs: number, inFlight: number }
type Metric = { count: number, maxInFlight: number, inFlightAtStart: number, inFlightAtEnd: number }
type Measurement = {
  fromMs: number
  toMs: number
  total: Metric
  status: Metric
  sessions: Metric
  requestStartsMs: Record<Method, number[]>
}

const online: ProxyStatus = {
  enabled: true, running: true,
  target: 'http://127.0.0.1:3081', backend: 'http://127.0.0.1:3080',
  listen: { host: '127.0.0.1', port: 3081 },
  tunnel: { state: 'online', publicUrl: 'https://benchmark.trycloudflare.com' },
}
const devices: SessionInfo[] = [{
  id: 'benchmark-device', label: 'Benchmark device', status: 'active',
  createdAt: 0, lastSeenAt: 0,
}]
const t = translatorFor(en)

/** Count actual mock invocations and live unresolved promises; no interval formula. */
function rpcRecorder(delayMs: number) {
  const events: RpcEvent[] = []
  const inFlight: Record<Method, number> = { status: 0, sessions: 0 }
  const request = async <T,>(method: Method, value: T): Promise<T> => {
    inFlight[method] += 1
    events.push({ method, action: 'start', atMs: Date.now(), inFlight: inFlight[method] })
    if (delayMs > 0) await new Promise<void>(resolve => { setTimeout(resolve, delayMs) })
    else await Promise.resolve()
    inFlight[method] -= 1
    events.push({ method, action: 'end', atMs: Date.now(), inFlight: inFlight[method] })
    // Same deterministic response for both versions; fresh object avoids identity artifacts.
    return structuredClone(value)
  }
  const service = {
    status: () => request('status', online),
    sessions: () => request('sessions', devices),
  } satisfies Pick<ProxyApi, Method>
  // Fail closed if this non-interactive scenario unexpectedly calls ANY other RPC.
  const api = new Proxy(service, {
    get(target, property) {
      if (property === 'status' || property === 'sessions') return target[property]
      throw new Error('Unexpected RPC in polling benchmark: ' + String(property))
    },
  }) as ProxyApi
  return { api, events }
}

function measure(events: RpcEvent[], fromMs: number, toMs: number): Measurement {
  const before: Record<Method, number> = { status: 0, sessions: 0 }
  for (const event of events.filter(event => event.atMs < fromMs)) before[event.method] += event.action === 'start' ? 1 : -1
  const live = { ...before }
  const metric = (n: number): Metric => ({ count: 0, maxInFlight: n, inFlightAtStart: n, inFlightAtEnd: n })
  const status = metric(before.status)
  const sessions = metric(before.sessions)
  const total = metric(before.status + before.sessions)
  const byMethod = { status, sessions }
  const requestStartsMs: Record<Method, number[]> = { status: [], sessions: [] }
  for (const event of events.filter(event => event.atMs >= fromMs && event.atMs < toMs)) {
    live[event.method] += event.action === 'start' ? 1 : -1
    expect(live[event.method]).toBe(event.inFlight)
    if (event.action === 'start') {
      total.count += 1
      byMethod[event.method].count += 1
      requestStartsMs[event.method].push(event.atMs)
    }
    byMethod[event.method].maxInFlight = Math.max(byMethod[event.method].maxInFlight, live[event.method])
    total.maxInFlight = Math.max(total.maxInFlight, live.status + live.sessions)
  }
  status.inFlightAtEnd = live.status
  sessions.inFlightAtEnd = live.sessions
  total.inFlightAtEnd = live.status + live.sessions
  return { fromMs, toMs, total, status, sessions, requestStartsMs }
}

/** Flush real React state/effects at every 100ms simulated checkpoint.
 * All tested timers/delays are multiples of 100ms. One giant 60s act would defer
 * the bootstrap status effect (and tunnel interval) until the end: not faithful.
 */
async function advance(ms: number) {
  expect(ms % stepMs).toBe(0)
  for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
    await act(async () => { await vi.advanceTimersByTimeAsync(stepMs) })
  }
}

async function run(Component: ComponentType<Props>, slow: boolean) {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  let visibility: DocumentVisibilityState = 'visible'
  const visibilitySpy = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  const recorder = rpcRecorder(slow ? 5000 : 0)
  if (!slow) {
    // Register transitions before mounting, so at equal clock time visibility
    // changes precede poll ticks. This makes all measurement windows [start,end).
    setTimeout(() => { visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange')) }, durationMs)
    setTimeout(() => { visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')) }, 2 * durationMs)
  }
  const props = { api: recorder.api, t } as Props // The real component reads no other settings slot props.
  const view = render(<Component {...props} />) // No StrictMode / double effect setup.
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  const firstCalls = recorder.events.filter(event => event.action === 'start')
  expect(firstCalls.map(event => [event.method, event.atMs])).toEqual([['status', 0], ['sessions', 0]])
  await advance(slow ? durationMs : 3 * durationMs)
  const scenarios: Record<string, Measurement> = slow
    ? { slowRpc60s: measure(recorder.events, 0, durationMs) }
    : {
        visible60s: measure(recorder.events, 0, durationMs),
        hidden60s: measure(recorder.events, durationMs, 2 * durationMs),
        visibleAgain60s: measure(recorder.events, 2 * durationMs, 3 * durationMs),
      }
  // Snapshot before teardown: outstanding slow RPCs are NOT counted as completed.
  const rpcTrace = [...recorder.events]
  view.unmount()
  // Dispose polling, then let only already-started slow transports finish.
  await advance(slow ? 5000 : 0)
  expect(recorder.events.filter(event => event.action === 'start')).toHaveLength(rpcTrace.filter(event => event.action === 'start').length)
  expect(vi.getTimerCount()).toBe(0)
  visibilitySpy.mockRestore()
  vi.useRealTimers()
  return { scenarios, rpcTrace }
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

it('records repeatable real old/new component RPC counts and in-flight concurrency', async () => {
  // Dynamic import AFTER the standalone config materializes all old relative dependencies.
  const oldPath = '../../output/benchmarks/polling-baseline/src/client/RemoteSection.tsx'
  const oldModule: { RemoteSection: ComponentType<Props> } = await import(/* @vite-ignore */ oldPath)
  const components = { baseline: oldModule.RemoteSection, current: RemoteSection }
  const results = {} as Record<Variant, Awaited<ReturnType<typeof run>>[]>
  for (const variant of ['baseline', 'current'] as const) {
    results[variant] = [await run(components[variant], false), await run(components[variant], true)]
  }
  const scenarios: Record<string, Record<Variant, Measurement>> = {}
  for (const name of ['visible60s', 'hidden60s', 'visibleAgain60s', 'slowRpc60s']) {
    const index = name === 'slowRpc60s' ? 1 : 0
    scenarios[name] = {
      baseline: results.baseline[index].scenarios[name],
      current: results.current[index].scenarios[name],
    }
  }
  // These assertions validate independent observed counters, not manufacture the output.
  expect(scenarios.visible60s.current.total.count).toBe(scenarios.visible60s.baseline.total.count)
  expect(scenarios.hidden60s.baseline.total.count).toBeGreaterThan(0)
  expect(scenarios.hidden60s.current.total.count).toBe(0)
  expect(scenarios.visibleAgain60s.current.requestStartsMs.status[0]).toBe(120_000)
  expect(scenarios.visibleAgain60s.current.requestStartsMs.sessions[0]).toBe(120_000)
  expect(scenarios.slowRpc60s.current.status.maxInFlight).toBe(1)
  expect(scenarios.slowRpc60s.current.sessions.maxInFlight).toBe(1)
  expect(scenarios.slowRpc60s.baseline.status.maxInFlight).toBeGreaterThan(1)
  expect(scenarios.slowRpc60s.baseline.sessions.maxInFlight).toBeGreaterThan(1)

  const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
  const sourceFiles = {
    baselineRemoteSection: resolve(baselinePath, 'src/client/RemoteSection.tsx'),
    currentRemoteSection: resolve(root, 'src/client/RemoteSection.tsx'),
    currentVisibilityPolling: resolve(root, 'src/client/visibility-polling.ts'),
    benchmark: resolve(root, 'scripts/bench-polling/benchmark-polling.test.tsx'),
    config: resolve(root, 'scripts/bench-polling/vitest.config.ts'),
  }
  const artifact = {
    schemaVersion: 1,
    kind: 'simulated-clock real React component / mocked RPC benchmark',
    baselineRevision: revision,
    command: 'pnpm exec vitest run --config scripts/bench-polling/vitest.config.ts',
    environment: {
      node: process.version, platform: process.platform, arch: process.arch,
      vitest: JSON.parse(readFileSync(resolve(root, 'node_modules/vitest/package.json'), 'utf8')).version,
      react: JSON.parse(readFileSync(resolve(root, 'node_modules/react/package.json'), 'utf8')).version,
      dom: 'jsdom', strictMode: false, fakeClockStepMs: stepMs,
    },
    sourceSha256: Object.fromEntries(Object.entries(sourceFiles).map(([key, path]) => [key, digest(path)])),
    baselineArchiveSha256: createHash('sha256').update(execFileSync('git', ['archive', revision, 'src', 'tsconfig.json'], { cwd: root })).digest('hex'),
    methodology: {
      component: 'Unmodified real baseline and working-tree RemoteSection, with real relative dependencies; only ProxyApi is mocked.',
      response: 'Same online tunnel and one active device for every request in both variants; no user actions or failures.',
      fastRpcDelayMs: 0, slowRpcDelayMs: 5000, durationMs,
      boundary: 'All windows are half-open [start,end): visible/slow [0,60000), hidden [60000,120000), recovered visible [120000,180000). Visibility transitions are registered before mount, so they execute before polling timers at the same timestamp. Requests at 60000 belong only to hidden; at 120000 only to recovered visible; at 180000 excluded. Bootstrap at 0 included.',
      initialization: 'Both mount status and sessions immediately at t=0. Tunnel interval starts only after initial status resolves: first poll at t=2000 fast / t=7000 slow. Sessions cadence is 3000ms; tunnel cadence is 2000ms. Current immediate:false preserves delayed first tunnel poll, but visible recovery polls immediately.',
      concurrency: 'maxInFlight counts outstanding mock RPC promises from recorded start/end events, including combined total and per-method maxima; current single-flight is per polling loop, not global.',
      clock: 'Advance and flush React act every 100ms, not one giant act. All scheduled deadlines in these scenarios align to this grid. Hidden timers are intentionally not browser-throttled, isolating application visibility behavior.',
      isolation: 'Visible -> hidden -> visible is one continuous mounted run per variant. Slow RPC is a separate fresh visible mount with BOTH methods delayed 5000ms including bootstrap. No remount on visibility changes.',
      limitations: 'Not a real browser/mobile-network/battery benchmark. Does not measure HTTP bytes, server CPU, radio wakeups, wall-clock UX, browser background throttling, or cancellation of already in-flight requests.',
    },
    scenarios,
    traces: results,
  }
  mkdirSync(resolve(root, 'output/benchmarks'), { recursive: true })
  writeFileSync(resolve(root, 'output/benchmarks/polling.json'), JSON.stringify(artifact, null, 2) + '\n')
  console.table(Object.entries(scenarios).flatMap(([scenario, variants]) =>
    Object.entries(variants).map(([variant, result]) => ({ scenario, variant,
      requests: result.total.count, status: result.status.count, sessions: result.sessions.count,
      maxTotal: result.total.maxInFlight, maxStatus: result.status.maxInFlight, maxSessions: result.sessions.maxInFlight,
    }))))
})
