import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCockpitConnection,
  type CockpitConnectionDocument,
  type ConnectionSourceHandle,
  type ConnectionSourceState,
} from '../src/client/cockpit-connection.ts'

function connection(initial: ConnectionSourceState = undefined) {
  let value = initial
  const listeners = new Set<() => void>()
  const handle: ConnectionSourceHandle = {
    state: {
      getSnapshot: () => value,
      subscribe(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    reconnect: vi.fn(),
  }
  return {
    handle,
    listeners,
    set(next: ConnectionSourceState) {
      value = next
      for (const listener of listeners) listener()
    },
  }
}

function visibility(initial: DocumentVisibilityState = 'visible') {
  let state = initial
  const listeners = new Set<() => void>()
  const page: CockpitConnectionDocument = {
    get visibilityState() { return state },
    addEventListener: (_type, listener) => { listeners.add(listener) },
    removeEventListener: (_type, listener) => { listeners.delete(listener) },
  }
  return {
    page,
    listeners,
    set(next: DocumentVisibilityState) {
      state = next
      for (const listener of listeners) listener()
    },
  }
}

function deferred() {
  let resolve = () => {}
  let reject = (_error: Error) => {}
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => { vi.useRealTimers() })

describe('createCockpitConnection', () => {
  it('merges recovery bursts at a minimum 5s start interval without periodic retry', async () => {
    vi.useFakeTimers()
    const upstream = connection('disconnected')
    const page = visibility()
    const refresh = vi.fn().mockResolvedValue(undefined)
    const source = createCockpitConnection(upstream.handle, refresh, { document: page.page })
    upstream.set('connected')
    await flush()
    for (let i = 0; i < 4; i++) {
      upstream.set('connecting')
      upstream.set('connected')
      page.set('hidden')
      page.set('visible')
    }
    await vi.advanceTimersByTimeAsync(4999)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    source.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drops hidden deferred work and never retries a failed automatic refresh by itself', async () => {
    vi.useFakeTimers()
    const upstream = connection('disconnected')
    const page = visibility()
    const refresh = vi.fn().mockRejectedValue(new Error('offline'))
    const source = createCockpitConnection(upstream.handle, refresh, { document: page.page })
    upstream.set('connected')
    await flush()
    expect(source.getSnapshot().refreshFailed).toBe(true)
    upstream.set('connecting')
    upstream.set('connected')
    page.set('hidden')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(refresh).toHaveBeenCalledTimes(1)
    page.set('visible')
    page.set('visible')
    await flush()
    expect(refresh).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    source.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('makes zero automatic hidden requests and requests only once when visible', async () => {
    vi.useFakeTimers()
    const upstream = connection('disconnected')
    const page = visibility('hidden')
    const refresh = vi.fn().mockResolvedValue(undefined)
    const source = createCockpitConnection(upstream.handle, refresh, { document: page.page })
    for (let i = 0; i < 4; i++) {
      upstream.set('connecting')
      upstream.set('connected')
    }
    await vi.advanceTimersByTimeAsync(60_000)
    expect(refresh).not.toHaveBeenCalled()
    page.set('visible')
    page.set('visible')
    upstream.set('connected')
    await flush()
    expect(refresh).toHaveBeenCalledTimes(1)
    source.dispose()
    expect(page.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels deferred work while hidden or disposed and lets manual refresh consume it', async () => {
    vi.useFakeTimers()
    const upstream = connection('disconnected')
    const page = visibility()
    const refresh = vi.fn().mockResolvedValue(undefined)
    const source = createCockpitConnection(upstream.handle, refresh, { document: page.page })
    upstream.set('connected')
    await flush()
    upstream.set('connecting')
    upstream.set('connected')
    page.set('hidden')
    await vi.advanceTimersByTimeAsync(1000)
    expect(refresh).toHaveBeenCalledTimes(1)
    page.set('visible')
    await source.refresh()
    expect(refresh).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5000)
    expect(refresh).toHaveBeenCalledTimes(2)
    upstream.set('connecting')
    upstream.set('connected')
    await flush()
    expect(refresh).toHaveBeenCalledTimes(3)
    upstream.set('connecting')
    upstream.set('connected')
    source.dispose()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(refresh).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not fabricate a connected or synchronized state without a handle', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    const source = createCockpitConnection(undefined, refresh, { document: null })
    expect(source.getSnapshot()).toEqual({ state: 'unknown', refreshing: false, refreshFailed: false })
    const stable = source.getSnapshot()
    expect(source.getSnapshot()).toBe(stable)
    expect(source.reconnect()).toBeUndefined()
    expect(refresh).not.toHaveBeenCalled()
    await source.refresh()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(source.getSnapshot()).toEqual(stable)
    source.dispose()
  })

  it('observes upstream state and refreshes only connected transitions', async () => {
    const upstream = connection()
    const refresh = vi.fn().mockResolvedValue(undefined)
    const source = createCockpitConnection(upstream.handle, refresh, { document: null })
    const listener = vi.fn()
    const unsubscribe = source.subscribe(listener)
    upstream.set('connecting')
    expect(source.getSnapshot().state).toBe('connecting')
    upstream.set('disconnected')
    expect(source.getSnapshot().state).toBe('disconnected')
    upstream.set('connected')
    expect(source.getSnapshot()).toEqual({ state: 'connected', refreshing: true, refreshFailed: false })
    await flush()
    expect(refresh).toHaveBeenCalledTimes(1)
    const stable = source.getSnapshot()
    upstream.set('connected')
    expect(source.getSnapshot()).toBe(stable)
    expect(refresh).toHaveBeenCalledTimes(1)
    upstream.set(undefined)
    expect(source.getSnapshot().state).toBe('unknown')
    unsubscribe()
    const calls = listener.mock.calls.length
    upstream.set('connecting')
    expect(listener).toHaveBeenCalledTimes(calls)
    expect(source.reconnect()).toBeUndefined()
    expect(upstream.handle.reconnect).toHaveBeenCalledTimes(1)
    source.dispose()
  })

  it('reads initial connected state without requesting a duplicate baseline', () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    const source = createCockpitConnection(connection('connected').handle, refresh, { document: null })
    expect(source.getSnapshot().state).toBe('connected')
    expect(refresh).not.toHaveBeenCalled()
    source.dispose()
  })

  it('coalesces manual, connection, and visible recovery until settlement', async () => {
    vi.useFakeTimers()
    const upstream = connection('disconnected')
    const page = visibility('hidden')
    const work = deferred()
    const refresh = vi.fn(() => work.promise)
    const source = createCockpitConnection(upstream.handle, refresh, { document: page.page })
    const first = source.refresh()
    expect(source.refresh()).toBe(first)
    page.set('visible')
    upstream.set('connected')
    await flush()
    expect(refresh).toHaveBeenCalledTimes(1)
    work.resolve()
    await first
    await flush()
    expect(source.getSnapshot().refreshing).toBe(false)
    page.set('visible')
    expect(refresh).toHaveBeenCalledTimes(1)
    page.set('hidden')
    page.set('visible')
    await flush()
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    source.dispose()
  })

  it('records sync throws and rejections without claiming resolved requests synchronized', async () => {
    const refresh = vi.fn<() => Promise<void>>()
      .mockImplementationOnce(() => { throw new Error('sync failure') })
      .mockRejectedValueOnce(new Error('transport failure'))
      .mockResolvedValueOnce(undefined)
    const source = createCockpitConnection(undefined, refresh, { document: null })
    await source.refresh()
    expect(source.getSnapshot().refreshFailed).toBe(true)
    await source.refresh()
    expect(source.getSnapshot().refreshFailed).toBe(true)
    const last = source.refresh()
    expect(source.getSnapshot()).toEqual({ state: 'unknown', refreshing: true, refreshFailed: false })
    await last
    expect(source.getSnapshot()).toEqual({ state: 'unknown', refreshing: false, refreshFailed: false })
    expect(Object.keys(source.getSnapshot()).sort()).toEqual(['refreshFailed', 'refreshing', 'state'])
    source.dispose()
  })

  it('times out busy state but retains flight ownership and never replays recovery', async () => {
    vi.useFakeTimers()
    const upstream = connection('disconnected')
    const page = visibility('hidden')
    const work = deferred()
    const refresh = vi.fn(() => work.promise)
    const source = createCockpitConnection(upstream.handle, refresh, { document: page.page })
    const first = source.refresh()
    await flush()
    await vi.advanceTimersByTimeAsync(7_999)
    expect(source.getSnapshot().refreshing).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    await first
    expect(source.getSnapshot()).toEqual({ state: 'disconnected', refreshing: false, refreshFailed: true })
    expect(source.refresh()).toBe(first)
    upstream.set('connected')
    page.set('visible')
    await flush()
    expect(refresh).toHaveBeenCalledTimes(1)
    work.resolve()
    await flush()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(source.getSnapshot().refreshFailed).toBe(true)
    await source.refresh()
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(source.getSnapshot().refreshFailed).toBe(false)
    source.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('contains a late rejection after timeout', async () => {
    vi.useFakeTimers()
    const work = deferred()
    const source = createCockpitConnection(undefined, () => work.promise, { document: null })
    const listener = vi.fn()
    source.subscribe(listener)
    const pending = source.refresh()
    await vi.advanceTimersByTimeAsync(8_000)
    await pending
    const snapshot = source.getSnapshot()
    const count = listener.mock.calls.length
    work.reject(new Error('late rejection'))
    await flush()
    expect(source.getSnapshot()).toBe(snapshot)
    expect(listener).toHaveBeenCalledTimes(count)
    source.dispose()
  })

  it('disposes listeners and timers, settles callers, and ignores late completion', async () => {
    vi.useFakeTimers()
    const upstream = connection()
    const page = visibility('hidden')
    const work = deferred()
    const refresh = vi.fn(() => work.promise)
    const source = createCockpitConnection(upstream.handle, refresh, { document: page.page })
    const listener = vi.fn()
    source.subscribe(listener)
    const pending = source.refresh()
    await flush()
    source.dispose()
    source.dispose()
    await pending
    expect(upstream.listeners.size).toBe(0)
    expect(page.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    const snapshot = source.getSnapshot()
    const count = listener.mock.calls.length
    work.reject(new Error('disposed rejection'))
    upstream.set('connected')
    page.set('visible')
    source.reconnect()
    source.subscribe(listener)()
    await source.refresh()
    await flush()
    expect(source.getSnapshot()).toBe(snapshot)
    expect(listener).toHaveBeenCalledTimes(count)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(upstream.handle.reconnect).not.toHaveBeenCalled()
  })

  it('does not start queued work if disposed before its microtask', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    const source = createCockpitConnection(undefined, refresh, { document: null })
    const pending = source.refresh()
    source.dispose()
    await pending
    await flush()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('observes the browser document by default, with no online or offline handlers', () => {
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')
    const source = createCockpitConnection(undefined, async () => {})
    expect(add).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    expect(add.mock.calls.map(([type]) => type)).not.toContain('online')
    expect(add.mock.calls.map(([type]) => type)).not.toContain('offline')
    source.dispose()
    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
  })
})
