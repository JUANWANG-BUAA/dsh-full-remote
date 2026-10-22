import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVisibilityPolling, type PollingDocument } from '../src/client/visibility-polling.ts'

function visibility(initial: DocumentVisibilityState = 'visible') {
  let state = initial
  const listeners = new Set<() => void>()
  const page: PollingDocument = {
    get visibilityState() { return state },
    addEventListener: (_type, listener) => { listeners.add(listener) },
    removeEventListener: (_type, listener) => { listeners.delete(listener) },
  }
  return {
    page, listeners,
    set(next: DocumentVisibilityState) {
      state = next
      for (const listener of listeners) listener()
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

afterEach(() => { vi.useRealTimers() })

describe('visibility-aware polling', () => {
  it('makes zero hidden requests and resumes once without replaying background ticks', async () => {
    vi.useFakeTimers()
    const page = visibility('hidden')
    const request = vi.fn().mockResolvedValue('value')
    const onValue = vi.fn()
    const dispose = createVisibilityPolling({ document: page.page, intervalMs: 3000, request, onValue })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(request).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    page.set('visible')
    page.set('visible')
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledTimes(1)
    expect(onValue).toHaveBeenCalledWith('value')
    await vi.advanceTimersByTimeAsync(2999)
    expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(request).toHaveBeenCalledTimes(2)
    page.set('hidden')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(request).toHaveBeenCalledTimes(2)
    dispose()
    expect(page.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not overlap slow requests or replay visible edges during a flight', async () => {
    vi.useFakeTimers()
    const page = visibility()
    const pending = deferred<number>()
    const request = vi.fn().mockReturnValue(pending.promise)
    const onValue = vi.fn()
    const dispose = createVisibilityPolling({ document: page.page, intervalMs: 2000, request, onValue })
    await vi.advanceTimersByTimeAsync(20_000)
    page.set('hidden')
    page.set('visible')
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledTimes(1)
    pending.resolve(7)
    await vi.advanceTimersByTimeAsync(0)
    expect(onValue).toHaveBeenCalledWith(7)
    expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(request).toHaveBeenCalledTimes(2)
    dispose()
  })

  it('preserves the delayed first tunnel poll and normal cadence after failures', async () => {
    vi.useFakeTimers()
    const request = vi.fn().mockRejectedValue(new Error('offline'))
    const onError = vi.fn()
    const dispose = createVisibilityPolling({ document: null, intervalMs: 2000, immediate: false, request, onValue: vi.fn(), onError })
    await vi.advanceTimersByTimeAsync(1999)
    expect(request).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(request).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1999)
    expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(request).toHaveBeenCalledTimes(2)
    dispose()
  })

  it.each(['resolve', 'reject'] as const)('suppresses late %s after disposal', async (settlement) => {
    vi.useFakeTimers()
    const page = visibility()
    const pending = deferred<number>()
    const request = vi.fn().mockReturnValue(pending.promise)
    const onValue = vi.fn()
    const onError = vi.fn()
    const dispose = createVisibilityPolling({ document: page.page, intervalMs: 3000, request, onValue, onError })
    await vi.advanceTimersByTimeAsync(0)
    dispose()
    if (settlement === 'resolve') pending.resolve(1)
    else pending.reject(new Error('late'))
    page.set('hidden')
    page.set('visible')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(request).toHaveBeenCalledTimes(1)
    expect(onValue).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(page.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
