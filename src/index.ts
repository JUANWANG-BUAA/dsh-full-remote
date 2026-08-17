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
import Schema from '@deepseek-ai/schemastery'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { listenProxy, type ProxyServer } from './proxy.ts'
import { defaultStateFile, readState, writeState, type PersistedState } from './persist.ts'
import { generateAccessToken } from './security.ts'
import { createSessionStore } from './sessions.ts'
import { createTunnelManager, tunnelTrustsForwarding, type TunnelStatus } from './tunnel.ts'
import {
  pathnameOf,
  readJson,
  sendJson,
  formatHttpUrl,
  isSelfLoop,
  isWildcardHost,
  isLoopbackHost,
  publishHost,
  reachableHosts,
  asError,
} from './http-util.ts'
import { PAGE_BOOTSTRAP_SOURCE } from './page-bootstrap.ts'
import { createAuditLog, defaultAuditPath, readAuditLog, readAuditLogAll } from './audit.ts'
import { compileCidrList, ipAllowed, parseCidr } from './cidr.ts'
import { createInviteStore } from './invites.ts'
import { probeFence } from './self-check.ts'
import { qrToSvg } from './qr-svg.ts'
import { LOGIN_PATH } from './pages.ts'
import { CONTROL_HEADER, CONTROL_HEADER_VALUE, CONTROL_PREFIX } from './control.ts'

export const name = 'reverse-proxy'
export const inject = ['webServer']

export const Config = Schema.object({
  listenHost: Schema.string().default('127.0.0.1').description('Default bind address. 0.0.0.0 / :: bind every interface but are not copyable destinations — the panel reports a reachable address separately. Prefer a concrete LAN IP for phone-on-WiFi. The UI can override this at runtime.'),
  listenPort: Schema.number().min(0).max(65535).default(3081).description('Default local tunnel target port; 0 chooses a free port; the UI can override it at runtime.'),
  backendHost: Schema.string().default('127.0.0.1').description('DeepSeek Harness Web backend host. Must be a loopback address, not a wildcard (0.0.0.0 / ::). TCP connects here; Host/Origin rewrite always uses 127.0.0.1 regardless.'),
  backendPort: Schema.number().min(0).max(65535).default(0).description('DeepSeek Harness Web backend port; 0 follows webServer.port.'),
  cloudflaredPath: Schema.string().default('').description('Optional explicit path to a cloudflared binary for the one-click quick tunnel. When empty the tunnel resolves the binary via PATH, then a pinned, SHA256-verified download cache under the state file directory.'),
  stateFile: Schema.string().default('').description('Durable state file; empty uses $DSH_HOME/reverse-proxy.json.'),
  autoRestore: Schema.boolean().default(true).description('Restore the last enabled state after DeepSeek Harness restarts.'),
  maxRequestBytes: Schema.number().min(1024).default(16 * 1024 * 1024).description('Maximum declared request body size.'),
  upstreamTimeoutMs: Schema.number().min(1000).default(15_000).description('Timeout while connecting to the DeepSeek Harness backend.'),
  sessionMaxAgeSeconds: Schema.number().min(60).default(30 * 24 * 3600).description('Absolute lifetime of a device session from creation (and legacy idle window when sessionIdleSeconds is 0).'),
  sessionIdleSeconds: Schema.number().min(0).default(0).description('Inactivity timeout in seconds (0 = disabled; uses lastSeenAt). When set, sessions expire after this idle window independently of sessionMaxAgeSeconds.'),
  cookieName: Schema.string().default('dsh_reverse_proxy_session').description('Authentication session cookie name.'),
  maxHeaderSizeBytes: Schema.number().min(1024).default(16 * 1024).description('Maximum HTTP header size accepted by the proxy.'),
  headersTimeoutMs: Schema.number().min(1000).default(15_000).description('Timeout for a client to send a complete request head. Must not exceed requestTimeoutMs.'),
  requestTimeoutMs: Schema.number().min(1000).default(120_000).description('Timeout for a complete request (headers plus body) accepted by the proxy. The effective request timeout is at least headersTimeoutMs.'),
  keepAliveTimeoutMs: Schema.number().min(1000).default(5_000).description('Keep-alive timeout for idle proxy connections.'),
  loginDelayMs: Schema.number().min(0).max(10_000).default(250).description('Fixed delay after a failed login, slowing token guessing.'),
  loginMaxAttempts: Schema.number().min(1).default(5).description('Failed login attempts per remote IP before that IP is locked out.'),
  loginLockoutSeconds: Schema.number().min(10).default(300).description('Lockout duration for a remote IP that exceeded loginMaxAttempts.'),
  upgradeMaxAttempts: Schema.number().min(1).default(10).description('Failed WebSocket upgrade attempts per remote IP before that IP is locked out.'),
  upgradeLockoutSeconds: Schema.number().min(10).default(300).description('Lockout duration for a remote IP that exceeded upgradeMaxAttempts.'),
  approvalMode: Schema.boolean().default(false).description('Require local approval for every new device before it can reach DeepSeek Harness.'),
  maxSessions: Schema.number().min(1).max(64).default(16).description('Maximum concurrent device sessions; the stalest session is evicted past this cap.'),
  logRequests: Schema.boolean().default(false).description('Log every proxied request at debug level.'),
  auditLog: Schema.boolean().default(true).description('Append structured JSONL audit events (login, approve, revoke, rotate, token reveal) next to the state file.'),
  auditLogFile: Schema.string().default('').description('Audit JSONL path; empty uses <stateFile without .json>.audit.jsonl.'),
  allowedCidrs: Schema.array(Schema.string()).default([]).description('Optional remote IP allowlist (CIDR or bare IP). Empty = allow all authenticated clients. Loopback is always allowed.'),
  allowTokenRead: Schema.boolean().default(true).description('When false, GET /token is disabled; the token is only returned from rotate-token (and the panel must rotate or use a prior reveal).'),
  tlsCertFile: Schema.string().default('').description('Optional PEM certificate path for local TLS on the proxy listen port (pair with tlsKeyFile). Empty = plain HTTP.'),
  tlsKeyFile: Schema.string().default('').description('Optional PEM private key path for local TLS (pair with tlsCertFile).'),
  trustForwardedProto: Schema.boolean().default(false).description('When true, trust inbound X-Forwarded-Proto from a reverse-edge for Secure cookies and upstream proto. Leave false unless a trusted TLS terminator sits in front.'),
  trustForwardedFor: Schema.boolean().default(false).description('When true and the direct peer is loopback, derive the remote client IP for CIDR / rate limiting / audit from CF-Connecting-IP or the rightmost X-Forwarded-For value (loopback and malformed values are never trusted). Only enable behind a trusted local tunnel/edge that sets these headers; do not enable for LAN direct access.'),
})

/** Validated plugin config: every field carries its Schema default. */
type RuntimeConfig = ReturnType<typeof Config>

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

/** The control-surface snapshot returned to the panel. */
interface RuntimeStatus {
  enabled: boolean
  running: boolean
  target: string
  backend: string
  listen: { host: string, port: number }
  bound: { host: string, port: number }
  reachables: string[]
  wildcard: boolean
  approvalMode: boolean
  tls: boolean
  auditLog: boolean
  trustForwardedFor: boolean
  reason?: string
  tunnel: TunnelStatus
}

/** Injectable runtime dependencies; tests replace the tunnel factory. */
export interface RuntimeDeps {
  createTunnel?: typeof createTunnelManager
}

const VIEWPORT = 'width=device-width, initial-scale=1, viewport-fit=cover'

export function injectViewport(html: string) {
  return html.replace(
    /content="width=device-width, initial-scale=1(?:, viewport-fit=cover)?"/,
    `content="${VIEWPORT}"`,
  )
}

/**
 * Remote browsers reach this app over plain HTTP at a non-loopback host,
 * which the browser treats as an insecure context. `crypto.randomUUID` is
 * secure-context-only, and the DeepSeek Harness Web composer calls it when attaching
 * files — on a proxied page that call throws and breaks attachments. This
 * guarded shim restores it from `crypto.getRandomValues`, which remains
 * available in insecure contexts. The same IIFE also wraps
 * `window.__ModuleLoader__` so that after the official connection plugin
 * `apply()` returns, `connection.isLoopback` is true on the handle.
 * Official settings plugins then bind against a trusted loopback handle.
 * A late `settingsScope.bind` wrap cannot rewrite scopes that already
 * chose memory persistence.
 *
 * tapIndex is not authentication: the script is injected into the host
 * index for every visitor of that page, including local `127.0.0.1`.
 * The proxy authenticates separately at its own listen port. Do not
 * assign Cordis mixin methods (`ctx.provide`) from this script.
 */
const INDEX_BOOTSTRAP = `<script data-plugin="dsh-reverse-proxy">${PAGE_BOOTSTRAP_SOURCE}</script>`

export function injectIndexEnhancements(html: string) {
  const withViewport = injectViewport(html)
  if (!withViewport.includes('<head>')) return withViewport
  // Idempotent: multiple taps (or a retried transform) must not stack copies.
  if (withViewport.includes('data-plugin="dsh-reverse-proxy"')) return withViewport
  return withViewport.replace('<head>', `<head>${INDEX_BOOTSTRAP}`)
}

function isLoopbackOrigin(origin: string | undefined) {
  if (origin === undefined) return true
  try {
    return isLoopbackHost(new URL(origin).hostname)
  } catch {
    return false
  }
}

/** Hostnames, IPv4, and bracketed IPv6 all pass; node listen() is the final judge. */
function isValidListenHost(value: string) {
  if (value.length === 0 || value.length > 253) return false
  return !/[\s/\\]/.test(value)
}

export function createRuntime(ctx: RuntimeContext, config: RuntimeConfig, deps: RuntimeDeps = {}) {
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
  if (rawCidrs.length > 0) {
    const dropped = rawCidrs.filter(entry => parseCidr(entry) === undefined)
    for (const entry of dropped) {
      ctx.logger.warn(`reverse-proxy: ignoring invalid CIDR "${entry}"`)
    }
    if (cidrRules.length === 0) {
      ctx.logger.warn('reverse-proxy: allowedCidrs had no valid entries — allowlist is inactive (all IPs allowed after login)')
    }
  }
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
  /** Tunnel trust is live only while cloudflared is starting or online — not after error/off. */
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

  const buildInvite = async (publicBase: string | undefined) => {
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
      allowTokenRead: config.allowTokenRead !== false,
      trustForwardedFor: config.trustForwardedFor === true,
    }
  }

  type ControlHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

  const auditQuery = (req: IncomingMessage) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const rawLimit = Number(url.searchParams.get('limit') ?? 50)
    const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50
    const event = url.searchParams.get('event')?.trim() || undefined
    return { limit, event }
  }

  const withJson = (
    fn: (body: Record<string, unknown>, res: ServerResponse) => Promise<void>,
  ): ControlHandler => async (req, res) => {
    let body: Record<string, unknown>
    try {
      body = await readJson(req) as Record<string, unknown>
    } catch {
      sendJson(res, 400, { error: 'invalid-request' })
      return
    }
    try {
      await fn(body, res)
    } catch (error) {
      warn(error)
      sendJson(res, 500, { error: 'action-failed' })
    }
  }

  const routes = new Map<string, ControlHandler>()
  const route = (method: string, suffix: string, handler: ControlHandler) => {
    routes.set(`${method} ${CONTROL_PREFIX}${suffix}`, handler)
  }

  const runAction = (fn: () => Promise<RuntimeStatus>): ControlHandler => async (_req, res) => {
    // A rejected action (e.g. close-timeout during stop) must still answer
    // the panel — an unanswered request hangs the fetch and leaks an
    // unhandled rejection into the host route.
    try {
      sendJson(res, 200, await exclusive(fn))
    } catch (error) {
      warn(error)
      sendJson(res, 500, { error: 'action-failed' })
    }
  }

  const mutateSession = (action: 'approve' | 'revoke' | 'rename'): ControlHandler => withJson(async (body, res) => {
    const id = typeof body.id === 'string' ? body.id : ''
    const result = await exclusive(async () => {
      await load()
      const ok = action === 'approve'
        ? sessionStore!.approve(id)
        : action === 'revoke'
          ? sessionStore!.revoke(id)
          : sessionStore!.rename(id, typeof body.label === 'string' ? body.label : undefined)
      if (ok) void audit.record(`session.${action}`, { id })
      return ok
    })
    sendJson(res, 200, { ok: result })
  })

  route('GET', '/status', async (_req, res) => {
    sendJson(res, 200, await shared(() => snapshot()))
  })
  route('POST', '/self-check', async (_req, res) => {
    sendJson(res, 200, await shared(() => runSelfCheck()))
  })
  route('POST', '/invite', withJson(async (body, res) => {
    const invite = await shared(() => buildInvite(typeof body.publicBase === 'string' ? body.publicBase : undefined))
    if (invite.error !== undefined) {
      sendJson(res, invite.error === 'not-running' ? 409 : 400, invite)
      return
    }
    void audit.record('invite.create')
    sendJson(res, 200, invite)
  }))
  route('GET', '/token', async (_req, res) => {
    if (config.allowTokenRead === false) {
      sendJson(res, 403, { error: 'token-read-disabled' })
      return
    }
    sendJson(res, 200, { accessToken: await exclusive(async () => {
      await load()
      void audit.record('token.reveal')
      return state!.accessToken
    }) })
  })
  route('GET', '/sessions', async (_req, res) => {
    sendJson(res, 200, { sessions: await shared(async () => {
      await load()
      return sessionStore!.list()
    }) })
  })
  route('GET', '/audit', async (req, res) => {
    const { limit, event } = auditQuery(req)
    sendJson(res, 200, await shared(async () => ({
      enabled: audit.enabled,
      events: await readAuditLog(audit.path, limit, event),
    })))
  })
  route('GET', '/audit/export', async (req, res) => {
    const { event } = auditQuery(req)
    const events = await shared(() => readAuditLogAll(audit.path, event))
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-disposition': 'attachment; filename="dsh-reverse-proxy-audit.json"',
      'x-content-type-options': 'nosniff',
    })
    res.end(JSON.stringify(events, null, 2))
  })
  route('POST', '/tunnel/start', async (_req, res) => {
    const outcome = await exclusive(async (): Promise<'ok' | 'not-running' | 'tls-unsupported' | 'disposed'> => {
      await load()
      if (disposed) return 'disposed'
      // The tunnel forwards to the proxy listener; without a listener there
      // is nothing to forward to (the panel starts the proxy first).
      if (bound === undefined) return 'not-running'
      // CF edge already terminates TLS; a local-TLS proxy plus tunnel is a
      // meaningless combination the panel should not offer silently.
      if (scheme() === 'https') return 'tls-unsupported'
      await tunnel.start()
      return 'ok'
    })
    if (outcome !== 'ok') {
      sendJson(res, outcome === 'not-running' || outcome === 'disposed' ? 409 : 400, { error: outcome })
      return
    }
    sendJson(res, 200, await shared(() => snapshot()))
  })
  route('POST', '/tunnel/stop', async (_req, res) => {
    sendJson(res, 200, await exclusive(async () => {
      await tunnel.stop()
      return snapshot()
    }))
  })
  route('POST', '/sessions/approve', mutateSession('approve'))
  route('POST', '/sessions/revoke', mutateSession('revoke'))
  route('POST', '/sessions/rename', mutateSession('rename'))
  route('POST', '/start', runAction(start))
  route('POST', '/stop', runAction(stop))
  route('POST', '/rotate-token', runAction(rotateToken))
  route('POST', '/listen', withJson(async (body, res) => {
    sendJson(res, 200, await setListen(body.host, body.port))
  }))

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!isLoopbackHost(req.socket.remoteAddress ?? '')) {
      sendJson(res, 403, { error: 'loopback-required' })
      return
    }
    const handler = routes.get(`${req.method} ${pathnameOf(req.url)}`)
    if (handler === undefined) {
      sendJson(res, 404, { error: 'not-found' })
      return
    }
    if (req.headers[CONTROL_HEADER] !== CONTROL_HEADER_VALUE || !isLoopbackOrigin(req.headers.origin)) {
      sendJson(res, 403, { error: 'forbidden' })
      return
    }
    await handler(req, res)
  }

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
    handle,
  }
}

/**
 * Publish an authenticated local reverse-proxy endpoint for any tunnel client.
 */
export function apply(ctx: RuntimeContext, config: RuntimeConfig) {
  if (isWildcardHost(config.backendHost)) {
    throw new Error(`reverse-proxy: backendHost "${config.backendHost}" is a wildcard listen address, not a backend. Use 127.0.0.1.`)
  }
  if (!isLoopbackHost(config.backendHost)) {
    throw new Error(`reverse-proxy: backendHost "${config.backendHost}" must be a loopback address (127.0.0.1 / localhost / ::1). A non-loopback backend would let authenticated remote clients reach an arbitrary TCP target.`)
  }
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
