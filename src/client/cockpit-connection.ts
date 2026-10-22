/** Connection recovery presentation, independent of Session baseline readiness. */
export type ConnectionSourceState = 'connected' | 'connecting' | 'disconnected' | undefined

/** Structural subset of the rc.2 public ConnectionHandle; no carrier ownership. */
export interface ConnectionSourceHandle {
  readonly state: {
    getSnapshot(): ConnectionSourceState
    subscribe(listener: () => void): () => void
  }
  reconnect(): void
}

export interface CockpitConnectionSnapshot {
  readonly state: Exclude<ConnectionSourceState, undefined> | 'unknown'
  readonly refreshing: boolean
  /** Only a thrown/rejected refresh or timeout; absence does not prove synchronization. */
  readonly refreshFailed: boolean
}

export interface CockpitConnection {
  getSnapshot(): CockpitConnectionSnapshot
  subscribe(listener: () => void): () => void
  dispose(): void
  /**
   * Explicit user refresh bypasses the recovery budget, but shares any in-flight
   * attempt. Settles after the attempt, timeout, or disposal; failures live in snapshot.
   */
  refresh(): Promise<void>
  reconnect(): void
}

export interface CockpitConnectionDocument {
  readonly visibilityState: DocumentVisibilityState
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

export interface CockpitConnectionOptions {
  /** Explicit null disables browser visibility observation. */
  readonly document?: CockpitConnectionDocument | null
}

const REFRESH_TIMEOUT_MS = 8_000
const RECOVERY_REFRESH_INTERVAL_MS = 5_000

/**
 * Observe the existing connection, and refresh on connected/visible recovery edges.
 * Initial state is observed without issuing another baseline request. Neither a
 * connected carrier nor a resolved refresh establishes domain synchronization.
 * A timeout ends presentation busy state, but retains single-flight ownership
 * until the original operation settles. Recovery edges during it are coalesced,
 * never queued for automatic replay. Automatic recovery starts at most once per
 * 5s, with one trailing merged refresh; hidden pages defer to the visible edge.
 * The cockpit read-only callback calls sessions.refresh() once, then updates a
 * local pending projection. The upstream service owns any RPC fanout/shortcuts;
 * this 5s budget counts callbacks, with no periodic refresh or failure retry.
 * Explicit user refresh bypasses 5s but still shares a flight (including timeout).
 * Browser online/offline stays upstream-owned.
 */
export function createCockpitConnection(
  handle: ConnectionSourceHandle | undefined,
  refresh: () => Promise<void>,
  options: CockpitConnectionOptions = {},
): CockpitConnection {
  const page = options.document === undefined
    ? (typeof document === 'undefined' ? undefined : document)
    : options.document ?? undefined
  const listeners = new Set<() => void>()
  let disposed = false
  let lastRefreshAt = -Infinity
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined
  const clearRecoveryTimer = () => {
    if (recoveryTimer !== undefined) clearTimeout(recoveryTimer)
    recoveryTimer = undefined
  }
  let snapshot: CockpitConnectionSnapshot = {
    state: handle?.state.getSnapshot() ?? 'unknown',
    refreshing: false,
    refreshFailed: false,
  }
  let flight: {
    promise: Promise<void>
    finish: () => void
    timer: ReturnType<typeof setTimeout> | undefined
    timedOut: boolean
  } | undefined

  const publish = (next: CockpitConnectionSnapshot) => {
    if (disposed || (next.state === snapshot.state
      && next.refreshing === snapshot.refreshing
      && next.refreshFailed === snapshot.refreshFailed)) return
    snapshot = next
    for (const listener of listeners) listener()
  }

  const requestRefresh = (automatic = false): Promise<void> => {
    if (disposed) return Promise.resolve()
    clearRecoveryTimer()
    if (flight !== undefined) return flight.promise
    lastRefreshAt = Date.now()
    let finish = () => {}
    const promise = new Promise<void>((resolve) => { finish = resolve })
    const attempt = { promise, finish, timer: undefined as ReturnType<typeof setTimeout> | undefined, timedOut: false }
    flight = attempt
    attempt.timer = setTimeout(() => {
      attempt.timer = undefined
      attempt.timedOut = true
      attempt.finish()
      publish({ ...snapshot, refreshing: false, refreshFailed: true })
    }, REFRESH_TIMEOUT_MS)
    // Start asynchronously so subscription callbacks cannot create a second flight.
    const settle = (failed: boolean) => {
      if (attempt.timer !== undefined) clearTimeout(attempt.timer)
      attempt.timer = undefined
      if (flight === attempt) flight = undefined
      attempt.finish()
      if (!attempt.timedOut) publish({ ...snapshot, refreshing: false, refreshFailed: failed })
    }
    void Promise.resolve().then(() => {
      if (!disposed && (!automatic || page?.visibilityState !== 'hidden')) return refresh()
    }).then(() => { settle(false) }, () => { settle(true) })
    publish({ ...snapshot, refreshing: true, refreshFailed: false })
    return promise
  }

  const requestRecoveryRefresh = () => {
    if (disposed || page?.visibilityState === 'hidden' || flight !== undefined) return
    const delay = lastRefreshAt + RECOVERY_REFRESH_INTERVAL_MS - Date.now()
    if (delay <= 0) {
      void requestRefresh(true)
    } else if (recoveryTimer === undefined) {
      recoveryTimer = setTimeout(() => {
        recoveryTimer = undefined
        requestRecoveryRefresh()
      }, delay)
    }
  }

  const observeConnection = () => {
    if (disposed) return
    const state = handle?.state.getSnapshot() ?? 'unknown'
    const recovered = state === 'connected' && snapshot.state !== 'connected'
    publish({ ...snapshot, state })
    if (recovered) requestRecoveryRefresh()
  }
  const unsubscribe = handle?.state.subscribe(observeConnection)
  let visibility = page?.visibilityState
  const observeVisibility = () => {
    const next = page?.visibilityState
    const recovered = next === 'visible' && visibility !== 'visible'
    visibility = next
    if (next === 'hidden') clearRecoveryTimer()
    if (recovered) requestRecoveryRefresh()
  }
  page?.addEventListener('visibilitychange', observeVisibility)

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refresh: () => requestRefresh(),
    reconnect() {
      if (!disposed) handle?.reconnect()
    },
    dispose() {
      if (disposed) return
      disposed = true
      clearRecoveryTimer()
      unsubscribe?.()
      page?.removeEventListener('visibilitychange', observeVisibility)
      listeners.clear()
      if (flight?.timer !== undefined) clearTimeout(flight.timer)
      flight?.finish()
      flight = undefined
    },
  }
}
