/**
 * dsh-full-remote host entry (plugin id `reverse-proxy` is frozen).
 *
 * Composes three jobs behind one plugin row:
 *  - Config schema (Schemastery): every tunable, validated loudly at load.
 *  - Runtime orchestration: state file, token/session lifecycle, and the
 *    proxy server instance with rollback-safe listen changes.
 *  - Loopback-only control surface: HTTP routes under /dsh-reverse-proxy
 *    that the settings section drives.
 *
 * Side effects are confined to ctx.effect(): routes, index taps and the
 * proxy all unwind when the plugin fiber disposes.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Config, type RuntimeConfig } from './config.ts'
import { listenProxy, type ProxyServer } from './proxy.ts'
import { defaultStateFile, readState, writeState, type PersistedState } from './persist.ts'
import { generateAccessToken } from './security.ts'
import { createSessionStore } from './sessions.ts'
import { createTunnelManager, tunnelTrustsForwarding } from './tunnel.ts'
import {
  formatHttpUrl,
  isSelfLoop,
  isWildcardHost,
  isLoopbackHost,
  publishHost,
  reachableHosts,
  asError,
} from './http-util.ts'
import { createAuditLog, defaultAuditPath } from './audit.ts'
import { compileCidrList, ipAllowed } from './cidr.ts'
import { createInviteStore } from './invites.ts'
import { probeFence } from './self-check.ts'
import { qrToSvg } from './qr-svg.ts'
import { LOGIN_PATH } from './pages.ts'
import { CONTROL_PREFIX } from './control.ts'
import { validateBackendHost, validateRuntimeConfig } from './config-validation.ts'
import { injectIndexEnhancements } from './index-enhancements.ts'
import { createControlRoutes, type InviteResult } from './control-routes.ts'
import type { RuntimeStatus } from './runtime-types.ts'

export const name = 'reverse-proxy'
export const inject = ['webServer']

export { Config }
export type { RuntimeConfig }

/** Runtime state once `load()` has regenerated the access token when missing. */
type RuntimeState = PersistedState & { accessToken: string }

/**
 * The subset of the Cordis context plus the `webServer` service this host
 * entry consumes. Declared structurally so the plugin typechecks without
 * depending on `@deepseek-ai/dsh-host-webserver`.
 */
interface RuntimeContext {
  logger: {
    warn(message: string | Error): void
    info(message: string): void
    debug(message: string): void
  }
  webServer: {
    readonly port: number
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
    }): () => void
    tapIndex(transform: (html: string) => string): () => void
  }
  effect(effect: () => () => void | Promise<void>, label?: string): unknown
}

/** Injectable runtime dependencies; tests replace the tunnel factory. */
export interface RuntimeDeps {
  createTunnel?: typeof createTunnelManager
}

export { injectIndexEnhancements, injectViewport } from './index-enhancements.ts'

/** Hostnames, IPv4, and bracketed IPv6 all pass; node listen() is the final judge. */
function isValidListenHost(value: string) {
  if (value.length === 0 || value.length > 253) return false
  return !/[\s/\\]/.test(value)
}

export function createRuntime(ctx: RuntimeContext, config: RuntimeConfig, deps: RuntimeDeps = {}) {
  validateBackendHost(config.backendHost)
  validateRuntimeConfig(config)
  let bound: ProxyServer | undefined
  let disposed = false
  let state: RuntimeState | undefined
  /** Last start refusal, kept in memory so the panel can explain a stopped proxy. */
  let lastFailure: string | undefined
  /** Mutating operations share one exclusive queue so start/stop/listen/rotate never interleave. */
  let writeGate = Promise.resolve()
  const warn = (error: unknown) => { ctx.logger.warn(asError(error)) }
  const exclusive = <T>(fn: () => T | Promise<T>): Promise<T> => {
    const run = writeGate.then(fn, fn)
    writeGate = run.then(() => {}, () => {})
    return run
  }
  /** Reads wait for the current write to finish, then run concurrently with each other. */
  const shared = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    await writeGate
    return fn()
  }
  const statePath = config.stateFile || defaultStateFile()
  const rawCidrs = Array.isArray(config.allowedCidrs) ? config.allowedCidrs : []
  const cidrRules = compileCidrList(rawCidrs)
  const audit = createAuditLog({
    enabled: config.auditLog === true,
    path: config.auditLogFile || defaultAuditPath(statePath),
    warn: (error) => { ctx.logger.warn(error) },
  })
  const inviteStore = createInviteStore()
  const scheme = () => (config.tlsCertFile && config.tlsKeyFile ? 'https' : 'http')
  /** One-click cloudflared quick tunnel. Session-scoped: never persisted or auto-restored (the URL is random per start). */
  const tunnel = (deps.createTunnel ?? createTunnelManager)({
    target: () => {
      // cloudflared must reach the proxy listener, not the backend. Loopback
      // and wildcard binds resolve to 127.0.0.1; a concrete LAN IP is used as-is.
      if (bound === undefined) return ''
      const host = isWildcardHost(bound.host) || isLoopbackHost(bound.host) ? '127.0.0.1' : bound.host
      return formatHttpUrl(host, bound.port, 'http')
    },
    configuredPath: config.cloudflaredPath,
    cacheDir: join(dirname(statePath), 'bin'),
    audit: (event, fields) => { void audit.record(event, fields) },
    log: message => { ctx.logger.info(message) },
  })
  /** Tunnel trust is live only after cloudflared has reached online state. */
  const tunnelLive = () => tunnelTrustsForwarding(tunnel.status().state)

  let sessionStore: ReturnType<typeof createSessionStore> | undefined
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  /** In-flight first load, memoized so concurrent callers share one read. */
  let loadPromise: Promise<RuntimeState> | undefined
  const scheduleSave = () => {
    if (saveTimer !== undefined) return
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      // Persist through the write gate so dispose/rotate cannot interleave.
      void exclusive(() => save())
    }, 2000)
    saveTimer.unref?.()
  }

  const load = (): Promise<RuntimeState> => {
    if (state !== undefined) return Promise.resolve(state)
    // Two concurrent first loads must not parse the state file twice, mint
    // two tokens, or race two state writes onto the same temp file name.
    loadPromise ??= (async () => {
      const loaded = await readState(statePath) as RuntimeState
      // A missing/short token is regenerated. Old device cookies must not
      // survive that — same semantics as an explicit rotate.
      const regeneratedToken = loaded.accessToken === undefined
      if (regeneratedToken) {
        loaded.accessToken = generateAccessToken()
      }
      state = loaded
      sessionStore = createSessionStore({
        maxSessions: config.maxSessions,
        maxAgeSeconds: config.sessionMaxAgeSeconds,
        idleSeconds: config.sessionIdleSeconds,
        approvalRequired: config.approvalMode,
        onChange: scheduleSave,
      })
      if (!regeneratedToken) sessionStore.hydrate(loaded.sessions)
      await save()
      return loaded
    })()
    return loadPromise
  }

  const save = async () => {
    if (state === undefined) return
    try {
      await writeState(statePath, {
        enabled: state.enabled,
        accessToken: state.accessToken,
        sessions: sessionStore!.serialize(),
        ...(state.listenHost !== undefined ? { listenHost: state.listenHost } : {}),
        ...(state.listenPort !== undefined ? { listenPort: state.listenPort } : {}),
      })
    } catch (error) {
      warn(error)
    }
  }

  /** Runtime overrides from the UI win over the Config defaults. */
  const effectiveListen = () => ({
    host: typeof state?.listenHost === 'string' && state.listenHost !== '' ? state.listenHost : config.listenHost,
    port: Number.isInteger(state?.listenPort) ? (state?.listenPort as number) : config.listenPort,
  })

  const snapshot = async (extra: { reason?: string } = {}): Promise<RuntimeStatus> => {
    await load()
    const backendPort = config.backendPort || ctx.webServer.port
    const listen = bound === undefined ? effectiveListen() : { host: bound.host, port: bound.port }
    const published = publishHost(listen.host)
    const reason = extra.reason ?? lastFailure
    return {
      enabled: state!.enabled,
      running: bound !== undefined,
      target: formatHttpUrl(published, listen.port, scheme()),
      backend: formatHttpUrl(config.backendHost, backendPort),
      listen,
      bound: listen,
      reachables: reachableHosts(listen.host).map(host => formatHttpUrl(host, listen.port, scheme())),
      wildcard: isWildcardHost(listen.host),
      approvalMode: config.approvalMode,
      tls: scheme() === 'https',
      auditLog: audit.enabled,
      trustForwardedFor: config.trustForwardedFor === true,
      tunnel: tunnel.status(),
      ...(reason !== undefined ? { reason } : {}),
    }
  }

  const loadTls = async () => {
    if (!config.tlsCertFile || !config.tlsKeyFile) return undefined
    const [cert, key] = await Promise.all([
      readFile(config.tlsCertFile),
      readFile(config.tlsKeyFile),
    ])
    return { cert, key }
  }

  const closeBound = async () => {
    const current = bound
    if (current === undefined) return
    // Clear `bound` only after close succeeds. Clearing first left a zombie
    // listener when close() rejected (still listening after grace), and the
    // next rotate thought no restart was needed.
    await current.close()
    if (bound === current) bound = undefined
    ctx.logger.info(`reverse-proxy: stopped listening on ${formatHttpUrl(current.host, current.port, scheme())}`)
  }

  /** Stop the tunnel first so cloudflared is not still forwarding into a closing listener. */
  const teardown = async () => {
    await tunnel.stop()
    await closeBound()
  }

  const restartTunnelIfLive = async (wasLive: boolean) => {
    if (!wasLive || bound === undefined || disposed || scheme() === 'https') return
    await tunnel.start()
  }

  const stop = async () => {
    await load()
    await teardown()
    state!.enabled = false
    lastFailure = undefined
    await save()
    void audit.record('proxy.stop')
    return snapshot()
  }

  const failStart = (reason: string) => {
    lastFailure = reason
    return snapshot({ reason })
  }

  const start = async () => {
    await load()
    if (disposed) return failStart('disposed')
    if (bound !== undefined) {
      lastFailure = undefined
      return snapshot()
    }
    const { host, port } = effectiveListen()
    const backendPort = config.backendPort || ctx.webServer.port
    // A backend pointing at the proxy's own listen address would loop every
    // request back into itself. Refuse loudly instead of spinning.
    if (isSelfLoop(host, port, config.backendHost, backendPort)) {
      ctx.logger.warn(`reverse-proxy: refusing to start — listen ${formatHttpUrl(host, port, scheme())} would loop onto backend ${formatHttpUrl(config.backendHost, backendPort)}`)
      return failStart('self-loop')
    }
    let tls
    try {
      tls = await loadTls()
    } catch (error) {
      warn(error)
      return failStart('tls-failed')
    }
    try {
      bound = await listenProxy({
        listenHost: host,
        listenPort: port,
        backendHost: config.backendHost,
        backendPort,
        accessToken: state!.accessToken,
        cookieName: config.cookieName,
        controlPrefix: CONTROL_PREFIX,
        maxRequestBytes: config.maxRequestBytes,
        upstreamTimeoutMs: config.upstreamTimeoutMs,
        sessionMaxAgeSeconds: config.sessionMaxAgeSeconds,
        maxHeaderSizeBytes: config.maxHeaderSizeBytes,
        headersTimeoutMs: config.headersTimeoutMs,
        requestTimeoutMs: config.requestTimeoutMs,
        keepAliveTimeoutMs: config.keepAliveTimeoutMs,
        loginDelayMs: config.loginDelayMs,
        loginMaxAttempts: config.loginMaxAttempts,
        loginLockoutMs: config.loginLockoutSeconds * 1000,
        upgradeMaxAttempts: config.upgradeMaxAttempts,
        upgradeLockoutMs: config.upgradeLockoutSeconds * 1000,
        sessionStore,
        inviteStore,
        approvalMode: config.approvalMode,
        ipAllowed: address => ipAllowed(address, cidrRules),
        audit: (event, fields) => { void audit.record(event, fields) },
        tls,
        // While the one-click tunnel is up, cloudflared peers come from
        // 127.0.0.1 — without trust every tunnel user shares one loopback
        // rate-limit bucket and audit/CIDR see a single fake IP. The proxy
        // only ever trusts forwarding headers from loopback peers, so this
        // probe adds no surface beyond the explicit config.
        trustForwardedProto: () => config.trustForwardedProto === true || tunnelLive(),
        trustForwardedFor: () => config.trustForwardedFor === true || tunnelLive(),
        trustCloudflareConnectingIp: () => config.trustCloudflareConnectingIp === true || tunnelLive(),
        log: config.logRequests
          ? entry => { ctx.logger.debug(`reverse-proxy: ${entry.remote ?? '-'} ${entry.method} ${entry.path} -> ${entry.status}`) }
          : undefined,
      })
    } catch (error) {
      warn(error)
      return failStart('listen-failed')
    }
    lastFailure = undefined
    state!.enabled = true
    await save()
    void audit.record('proxy.start', { host: bound!.host, port: bound!.port, tls: tls !== undefined })
    ctx.logger.info(`reverse-proxy: listening on ${formatHttpUrl(bound!.host, bound!.port, scheme())}`)
    return snapshot()
  }

  // Same shape as start/stop: the work function is unwrapped. HTTP handle
  // and the runtime export each wrap it in exclusive() once. Wrapping here AND
  // in handle() nested the same gate (gate waits for rotateToken, which
  // waits for gate) and froze the control panel on "Rotate token".
  const rotateToken = async () => {
    await load()
    const restart = bound !== undefined
    const wasTunnel = tunnelLive()
    await teardown()
    state!.accessToken = generateAccessToken()
    // Rotation invalidates every device: sessions are independent of the
    // token, so they must be revoked explicitly.
    sessionStore!.clear()
    inviteStore.clear()
    await save()
    void audit.record('token.rotate')
    ctx.logger.info('reverse-proxy: access token rotated')
    if (restart) await start()
    await restartTunnelIfLive(wasTunnel)
    return { ...(await snapshot()), accessToken: state!.accessToken }
  }

  /**
   * Change the published listen address at runtime. A running proxy is
   * restarted on the new address; when the new bind fails, the previous
   * address is restored so the user never loses an already working entry.
   */
  const setListen = (host: unknown, port: unknown) => exclusive(async () => {
    await load()
    const hostname = String(host ?? '').trim()
    const portNumber = Number(port)
    if (!isValidListenHost(hostname) || !Number.isInteger(portNumber) || portNumber < 0 || portNumber > 65535) {
      return snapshot({ reason: 'invalid-listen' })
    }
    const previous = effectiveListen()
    if (hostname === previous.host && portNumber === previous.port) return snapshot()
    const wasRunning = bound !== undefined
    const wasTunnel = tunnelLive()
    state!.listenHost = hostname
    state!.listenPort = portNumber
    lastFailure = undefined
    await save()
    await teardown()
    if (!wasRunning) {
      ctx.logger.info(`reverse-proxy: publish address set to ${hostname}:${portNumber}`)
      return snapshot()
    }
    const status = await start()
    if (status.running) {
      await restartTunnelIfLive(wasTunnel)
      return snapshot()
    }
    // Roll back: keep serving on the address that worked.
    state!.listenHost = previous.host
    state!.listenPort = previous.port
    await save()
    const restored = await start()
    await restartTunnelIfLive(wasTunnel && restored.running)
    return snapshot({ reason: restored.running ? 'listen-failed-restored' : 'listen-failed' })
  })

  const buildInvite = async (publicBase: string | undefined): Promise<InviteResult> => {
    await load()
    const base = String(publicBase ?? '').trim().replace(/\/$/, '')
    // Explicit origin wins; then the live quick-tunnel URL so a phone can
    // scan the QR immediately; finally the local target.
    const tunnelUrl = tunnel.status().publicUrl
    const fallback = (await snapshot()).target
    const origin = base === '' ? (tunnelUrl ?? fallback) : base
    let url
    try {
      url = new URL(LOGIN_PATH, origin.endsWith('/') ? origin : `${origin}/`)
    } catch {
      return { error: 'invalid-base' }
    }
    // Only http(s) origins make a usable invite link / QR.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { error: 'invalid-base' }
    }
    // An invite is a login link to the proxy: with nothing listening, the QR
    // can only produce a connection-refused (or a literal ":0" URL when the
    // port is auto-assigned). Refuse until the proxy is running.
    if (bound === undefined) return { error: 'not-running' }
    // One-time invite code — never put the standing access token in the URL.
    url.searchParams.set('invite', inviteStore.issue())
    const inviteUrl = url.toString()
    const svg = qrToSvg(inviteUrl)
    return {
      inviteUrl,
      qrSvg: svg ?? undefined,
    }
  }

  const runSelfCheck = async () => {
    await load()
    const backendPort = config.backendPort || ctx.webServer.port
    const fence = await probeFence({
      backendHost: config.backendHost,
      backendPort,
      timeoutMs: Math.min(config.upstreamTimeoutMs, 5_000),
    })
    return {
      running: bound !== undefined,
      fence,
      tls: scheme() === 'https',
      auditLog: audit.enabled,
      allowTokenRead: config.allowTokenRead === true,
      trustForwardedFor: config.trustForwardedFor === true,
    }
  }

  const control = createControlRoutes({
    allowTokenRead: config.allowTokenRead === true,
    audit,
    warn,
    exclusive,
    shared,
    snapshot,
    runSelfCheck,
    buildInvite,
    readToken: () => exclusive(async () => {
      await load()
      void audit.record('token.reveal')
      return state!.accessToken
    }),
    listSessions: async () => {
      await load()
      return sessionStore!.list()
    },
    mutateSession: (action, id, label) => exclusive(async () => {
      await load()
      const ok = action === 'approve'
        ? sessionStore!.approve(id)
        : action === 'revoke'
          ? sessionStore!.revoke(id)
          : sessionStore!.rename(id, label)
      if (ok) void audit.record(`session.${action}`, { id })
      return ok
    }),
    startTunnel: async () => {
      await load()
      if (disposed) return 'disposed'
      if (bound === undefined) return 'not-running'
      if (scheme() === 'https') return 'tls-unsupported'
      await tunnel.start()
      return 'ok'
    },
    stopTunnel: async () => {
      await tunnel.stop()
      return snapshot()
    },
    start,
    stop,
    rotateToken,
    setListen,
  })

  return {
    restore: () => exclusive(async () => {
      await load()
      if (!config.autoRestore || !state!.enabled || disposed) return
      const status = await start()
      if (!status.running) {
        ctx.logger.warn(`reverse-proxy: persisted start skipped (${status.reason ?? 'unknown'})`)
      }
    }),
    dispose: () => exclusive(async () => {
      disposed = true
      if (saveTimer !== undefined) {
        clearTimeout(saveTimer)
        saveTimer = undefined
      }
      await teardown()
      await save()
    }),
    status: () => shared(() => snapshot()),
    start: () => exclusive(start),
    stop: () => exclusive(stop),
    token: () => exclusive(async () => {
      await load()
      return state!.accessToken
    }),
    rotateToken: () => exclusive(rotateToken),
    setListen,
    selfCheck: () => shared(() => runSelfCheck()),
    handle: control.handle,
  }
}

/**
 * Publish an authenticated local reverse-proxy endpoint for any tunnel client.
 */
export function apply(ctx: RuntimeContext, config: RuntimeConfig) {
  validateBackendHost(config.backendHost)
  const runtime = createRuntime(ctx, config)
  ctx.effect(() => {
    const unroute = ctx.webServer.register({
      kind: 'prefix',
      path: CONTROL_PREFIX,
      handler: (req, res) => runtime.handle(req, res),
    })
    const untap = ctx.webServer.tapIndex(injectIndexEnhancements)
    ctx.logger.info(`reverse-proxy: control surface mounted at ${CONTROL_PREFIX} (loopback only)`)
    void runtime.restore()
    return async () => {
      unroute()
      untap()
      await runtime.dispose()
    }
  }, 'reverse-proxy')
}
