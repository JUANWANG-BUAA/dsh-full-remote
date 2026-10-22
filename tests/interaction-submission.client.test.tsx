import { StrictMode, type PropsWithChildren } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReverseProxyTranslate } from '../src/client/i18n.ts'
import { useInteractionSubmission } from '../src/client/use-interaction-submission.ts'

const translate = (language: string): ReverseProxyTranslate => key => language + ':' + key
const t = translate('zh')

function deferred() {
  let resolve!: () => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('useInteractionSubmission', () => {
  it('locks immediately against multiple calls before React commits busy', async () => {
    const pending = deferred()
    const operation = vi.fn(() => pending.promise)
    const duplicate = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useInteractionSubmission(t))
    expect(result.current.busy).toBeUndefined()
    act(() => {
      result.current.run('answer', operation)
      result.current.run('cancel', duplicate)
      result.current.run('answer', operation)
    })
    expect(operation).toHaveBeenCalledTimes(1)
    expect(duplicate).not.toHaveBeenCalled()
    expect(result.current.busy).toBe('answer')
    await act(async () => { pending.resolve() })
    expect(result.current.notice).toBe(t('cockpit.confirming'))
    expect(result.current.busy).toBe('answer')
    expect(result.current.error).toBeUndefined()
    act(() => { result.current.run('answer', duplicate) })
    expect(duplicate).not.toHaveBeenCalled()
  })

  it('waits for registry removal after a successful cancellation without unlocking', async () => {
    const operation = vi.fn().mockResolvedValue(undefined)
    const { result, rerender } = renderHook(() => useInteractionSubmission(t))
    await act(async () => { result.current.run('cancel', operation) })
    rerender()
    expect(result.current.busy).toBe('cancel')
    expect(result.current.notice).toBe(t('cockpit.confirming'))
    act(() => { result.current.run('answer', operation) })
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it.each(['pending', 'resolved'] as const)('marks a %s attempt uncertain after ten seconds without replay', async (state) => {
    const pending = deferred()
    const operation = vi.fn(() => pending.promise)
    const { result } = renderHook(() => useInteractionSubmission(t))
    act(() => { result.current.run('answer', operation) })
    if (state === 'resolved') await act(async () => { pending.resolve() })
    act(() => { vi.advanceTimersByTime(9_999) })
    expect(result.current.notice).toBe(state === 'resolved' ? t('cockpit.confirming') : undefined)
    act(() => { vi.advanceTimersByTime(1) })
    expect(result.current.notice).toBe(t('cockpit.uncertain'))
    expect(result.current.busy).toBe('answer')
    if (state === 'pending') await act(async () => { pending.resolve() })
    expect(result.current.notice).toBe(t('cockpit.uncertain'))
    act(() => {
      vi.advanceTimersByTime(60_000)
      result.current.run('answer', operation)
    })
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it.each(['throw', 'reject'] as const)('catches %s without unhandled rejection and keeps the uncertain attempt locked', async (mode) => {
    const operation = vi.fn((): Promise<void> => {
      if (mode === 'throw') throw new Error('transport lost')
      return Promise.reject(new Error('transport lost'))
    })
    const { result } = renderHook(() => useInteractionSubmission(t))
    await act(async () => { result.current.run('answer', operation) })
    expect(result.current.error).toBe('transport lost')
    expect(result.current.notice).toBe(t('cockpit.uncertain'))
    expect(result.current.busy).toBe('answer')
    act(() => {
      vi.advanceTimersByTime(10_000)
      result.current.run('cancel', operation)
    })
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('captures a non-Error rejection as displayable text', async () => {
    const { result } = renderHook(() => useInteractionSubmission(t))
    await act(async () => { result.current.run('cancel', () => Promise.reject('not pending')) })
    expect(result.current.error).toBe('not pending')
    expect(result.current.notice).toBe(t('cockpit.uncertain'))
    expect(result.current.busy).toBe('cancel')
  })

  it('translates the notice key on every render without restarting its timer or attempt', async () => {
    const { result, rerender } = renderHook(({ language }) => useInteractionSubmission(translate(language)), {
      initialProps: { language: 'zh' },
    })
    await act(async () => { result.current.run('answer', () => Promise.resolve()) })
    act(() => { vi.advanceTimersByTime(5_000) })
    rerender({ language: 'en' })
    expect(result.current.notice).toBe('en:cockpit.confirming')
    act(() => { vi.advanceTimersByTime(5_000) })
    expect(result.current.notice).toBe('en:cockpit.uncertain')
    rerender({ language: 'zh' })
    expect(result.current.notice).toBe('zh:cockpit.uncertain')
    expect(result.current.busy).toBe('answer')
  })

  it.each(['resolve', 'reject'] as const)('cleans timers on unmount and ignores late %s plus stale run callbacks', async (outcome) => {
    const pending = deferred()
    const operation = vi.fn(() => pending.promise)
    const render = vi.fn(() => useInteractionSubmission(t))
    const { result, unmount } = renderHook(render)
    const run = result.current.run
    act(() => { run('answer', operation) })
    expect(vi.getTimerCount()).toBe(1)
    const renders = render.mock.calls.length
    const snapshot = result.current
    unmount()
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => {
      if (outcome === 'resolve') pending.resolve()
      else pending.reject(new Error('late failure'))
    })
    act(() => {
      vi.advanceTimersByTime(60_000)
      run('cancel', operation)
    })
    expect(render).toHaveBeenCalledTimes(renders)
    expect(result.current).toBe(snapshot)
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('survives strict effect cleanup without replaying or losing the lock', async () => {
    const wrapper = ({ children }: PropsWithChildren) => <StrictMode>{children}</StrictMode>
    const operation = vi.fn().mockResolvedValue(undefined)
    const { result, unmount } = renderHook(() => useInteractionSubmission(t), { wrapper })
    await act(async () => {
      result.current.run('answer', operation)
      result.current.run('answer', operation)
    })
    expect(result.current.busy).toBe('answer')
    expect(result.current.notice).toBe(t('cockpit.confirming'))
    expect(operation).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
