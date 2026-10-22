/** Small browser contract so polling can be tested without mounting React. */
export interface PollingDocument {
  readonly visibilityState: DocumentVisibilityState
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

export interface VisibilityPollingOptions<T> {
  readonly intervalMs: number
  readonly request: () => Promise<T>
  readonly onValue: (value: T) => void
  readonly onError?: (reason: unknown) => void
  /** False preserves delayed first polls, e.g. tunnel startup's existing 2s budget. */
  readonly immediate?: boolean
  /** Explicit null disables visibility observation. */
  readonly document?: PollingDocument | null
}

/**
 * One request at a time, at the normal polling cadence. Hidden time accumulates
 * no work: a visible edge requests once (or shares the current flight), never a
 * catch-up burst. Failure waits for the next normal tick, not a retry loop.
 * Disposal releases timers/listeners and suppresses late callbacks, not the
 * transport itself: this helper never owns or rebuilds the carrier.
 */
export function createVisibilityPolling<T>(options: VisibilityPollingOptions<T>): () => void {
  const page = options.document === undefined
    ? (typeof document === 'undefined' ? undefined : document)
    : options.document ?? undefined
  let visibility = page?.visibilityState
  let disposed = false
  let inFlight = false
  let timer: ReturnType<typeof setInterval> | undefined
  const visible = () => page?.visibilityState !== 'hidden'
  const poll = () => {
    if (disposed || inFlight || !visible()) return
    inFlight = true
    void Promise.resolve().then(async () => {
      if (disposed || !visible()) return
      const value = await options.request()
      if (!disposed) options.onValue(value)
    }).catch(reason => {
      if (!disposed) options.onError?.(reason)
    }).finally(() => { inFlight = false })
  }
  const pause = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
  const start = () => {
    if (timer === undefined) timer = setInterval(poll, options.intervalMs)
  }
  const observeVisibility = () => {
    const next = page?.visibilityState
    const recovered = next === 'visible' && visibility !== 'visible'
    visibility = next
    if (!visible()) pause()
    else if (recovered) { start(); poll() }
  }
  page?.addEventListener('visibilitychange', observeVisibility)
  if (visible()) {
    start()
    if (options.immediate !== false) poll()
  }
  return () => {
    disposed = true
    pause()
    page?.removeEventListener('visibilitychange', observeVisibility)
  }
}
