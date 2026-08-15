/**
 * trust-settings — backup wrap if connection.provide was not intercepted.
 *
 * The index-tap IIFE wraps `__ModuleLoader__` so official settings plugins
 * see `connection.isLoopback === true` at provide time. This module still
 * wraps `settingsScope.bind` for any consumer that binds later. When the
 * handle is already trusted, wrap is a no-op.
 *
 * The durable declaration is `__DSH_FULL_REMOTE_TRUSTED__` (stand-in until
 * upstream `__DSH_BOOT__` grows a trust field).
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

type SettingsBinder = {
  bind: (spec: unknown) => unknown
}

type ConnectionHandleLike = {
  isLoopback?: boolean
}

/** True when this plugin's index tap ran and the page is not loopback. */
export function pageNeedsHostSettingsPersistence(
  hostname = globalThis.location?.hostname ?? '',
  trusted = (globalThis as { __DSH_FULL_REMOTE_TRUSTED__?: number }).__DSH_FULL_REMOTE_TRUSTED__,
): boolean {
  return trusted === 1 && hostname !== '' && !LOOPBACK_HOSTS.has(hostname)
}

/**
 * Wrap `binder.bind` so a remote, plugin-trusted page persists settings to
 * the host document. No-op when the page is already loopback, when the tap
 * flag is missing, or when bind was already wrapped.
 */
export function trustSettingsPersistence(
  binder: SettingsBinder,
  getConnection: () => ConnectionHandleLike | undefined,
  options?: { hostname?: string, trusted?: number },
): void {
  if (!pageNeedsHostSettingsPersistence(options?.hostname, options?.trusted)) return
  if (typeof binder.bind !== 'function') return
  if ((binder.bind as { __dshFullRemoteTrusted?: boolean }).__dshFullRemoteTrusted === true) return
  const original = binder.bind
  const wrapped = function wrapped(this: SettingsBinder, spec: unknown) {
    const connection = getConnection()
    if (connection === undefined || connection.isLoopback === true) {
      return original.call(this, spec)
    }
    const previous = connection.isLoopback
    try {
      Object.defineProperty(connection, 'isLoopback', {
        value: true,
        configurable: true,
        enumerable: true,
        writable: true,
      })
    } catch {
      return original.call(this, spec)
    }
    try {
      return original.call(this, spec)
    } finally {
      try {
        Object.defineProperty(connection, 'isLoopback', {
          value: previous,
          configurable: true,
          enumerable: true,
          writable: true,
        })
      } catch {
        // The handle was sealed after bind; leave it. Persistence already chose.
      }
    }
  }
  ;(wrapped as { __dshFullRemoteTrusted?: boolean }).__dshFullRemoteTrusted = true
  binder.bind = wrapped
}
