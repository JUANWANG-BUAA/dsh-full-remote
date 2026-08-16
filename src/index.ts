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
import { listenProxy, type ProxyServer } from './proxy.ts'
import { defaultStateFile, readState, writeState, type PersistedState } from './persist.ts'
import { generateAccessToken } from './security.ts'
import { createSessionStore } from './sessions.ts'
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
} from './http-util.ts'
import { PAGE_BOOTSTRAP_SOURCE } from './page-bootstrap.ts'
import { createAuditLog, defaultAuditPath, readAuditLog } from './audit.ts'
import { compileCidrList, ipAllowed, parseCidr } from './cidr.ts'
import { createInviteStore } from './invites.ts'
import { probeFence } from './self-check.ts'
import { qrToSvg } from './qr-svg.ts'
import { LOGIN_PATH } from './pages.ts'

export const name = 'reverse-proxy'
export const inject = ['webServer']

export const Config = Schema.object({
  listenHost: Schema.string().default('127.0.0.1').description('Default bind address. 0.0.0.0 / :: bind every interface but are not copyable destinations — the panel reports a reachable address separately. Prefer a concrete LAN IP for phone-on-WiFi. The UI can override this at runtime.'),
  listenPort: Schema.number().min(0).max(65535).default(3081).description('Default local tunnel target port; 0 chooses a free port; the UI can override it at runtime.'),
  backendHost: Schema.string().default('127.0.0.1').description('DeepSeek Harness Web backend host. Must be a loopback address, not a wildcard (0.0.0.0 / ::). TCP connects here; Host/Origin rewrite always uses 127.0.0.1 regardless.'),
  backendPort: Schema.number().min(0).max(65535).default(0).description('DeepSeek Harness Web backend port; 0 follows webServer.port.'),
  stateFile: Schema.string().default('').description('Durable state file; empty uses $DSH_HOME/reverse-proxy.json.'),
  autoRestore: Schema.boolean().default(true).description('Restore the last enabled state after DeepSeek Harness restarts.'),
  maxRequestBytes: Schema.number().min(1024).default(16 * 1024 * 1024).description('Maximum declared request body size.'),
  upstreamTimeoutMs: Schema.number().min(1000).default(15_000).description('Timeout while connecting to the DeepSeek Harness backend.'),
  sessionMaxAgeSeconds: Schema.number().min(60).default(30 * 24 * 3600).description('Absolute lifetime of a device session from creation (and legacy idle window when sessionIdleSeconds is 0).'),
  sessionIdleSeconds: Schema.number().min(0).default(0).description('Inactivity timeout in seconds (0 = disabled; uses lastSeenAt). When set, sessions expire after this idle window independently of sessionMaxAgeSeconds.'),
  cookieName: Schema.string().default('dsh_reverse_proxy_session').description('Authentication session cookie name.'),
  maxHeaderSizeBytes: Schema.number().min(1024).default(16 * 1024).description('Maximum HTTP header size accepted by the proxy.'),
  headersTimeoutMs: Schema.number().min(1000).default(15_000).description('Timeout for a client to send a complete request head.'),
  keepAliveTimeoutMs: Schema.number().min(1000).default(5_000).description('Keep-alive timeout for idle proxy connections.'),
  loginDelayMs: Schema.number().min(0).max(10_000).default(250).description('Fixed delay after a failed login, slowing token guessing.'),
  loginMaxAttempts: Schema.number().min(1).default(5).description('Failed login attempts per remote IP before that IP is locked out.'),
  loginLockoutSeconds: Schema.number().min(10).default(300).description('Lockout duration for a remote IP that exceeded loginMaxAttempts.'),
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
  trustForwardedFor: Schema.boolean().default(false).description('When true and the direct peer is loopback, use the first X-Forwarded-For value as the remote client IP for CIDR / rate limiting / audit. Only enable behind a trusted local tunnel/edge; do not enable for LAN direct access.'),
})

/** Validated plugin config: every field carries its Schema default. */
interface RuntimeConfig {
  listenHost: string
  listenPort: number
  backendHost: string
  backendPort: number
  stateFile: string
  autoRestore: boolean
  maxRequestBytes: number
  upstreamTimeoutMs: number
  sessionMaxAgeSeconds: number
  sessionIdleSeconds: number
  cookieName: string
  maxHeaderSizeBytes: number
  headersTimeoutMs: number
  keepAliveTimeoutMs: number
  loginDelayMs: number
  loginMaxAttempts: number
  loginLockoutSeconds: number
  approvalMode: boolean
  maxSessions: number
  logRequests: boolean
  auditLog: boolean
  auditLogFile: string
  allowedCidrs: string[]
  allowTokenRead: boolean
  tlsCertFile: string
  tlsKeyFile: string
  trustForwardedProto: boolean
  trustForwardedFor: boolean
}

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
  authenticated: boolean
  reason?: string
}

const CONTROL_PREFIX = '/dsh-reverse-proxy'
const VIEWPORT = 'width=device-width, initial-scale=1, viewport-fit=cover'
// FROZEN (roadmap §7.1 class 2/3/4): plugin id, cookie name, control prefix,
// forwarding header, polyfill marker. Renaming any of these drops sessions
// or silently disables anti-spoof stripping. Only the npm package name moves.

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
 * `window.__ModuleLoader__` so `connection.isLoopback` is true before
 * official settings plugins bind (a late `settingsScope.bind` wrap cannot
 * rewrite scopes that already chose memory persistence).
 */
const INDEX_BOOTSTRAP = `<script data-plugin="dsh-reverse-proxy">${PAGE_BOOTSTRAP_SOURCE}</script>`

export function injectIndexEnhancements(html: string) {
  const withViewport = injectViewport(html)
  if (!withViewport.includes('<head>')) return withViewport
  // Idempotent: multiple taps (or a retried transform) must not stack copies.
  if (withViewport.includes('data-plugin="dsh-reverse-proxy"')) return withViewport
  return withViewport.replace('<head>', `<head>${INDEX_BOOTSTRAP}`)
}

function isLoopbackAddress(address: string | undefined) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function isLoopbackOrigin(origin: string | undefined) {
  if (origin === undefined) return true
  try {
    const hostname = new URL(origin).hostname
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
  } catch {
    return false
  }
}

/** Hostnames, IPv4, and bracketed IPv6 all pass; node listen() is the final judge. */
function isValidListenHost(value: string) {
  if (value.length === 0 || value.length > 253) return false
  return !/[\s/\\]/.test(value)
}

export function createRuntime(ctx: RuntimeContext, config: RuntimeConfig) {
  /** @type {{ host: string, port: number, close: () => Promise<void> } | undefined} */
  let bound: ProxyServer | undefined
  let disposed = false
  let state: RuntimeState | undefined
  /** Last start refusal, kept in memory so the panel can explain a stopped proxy. @type {string | undefined} */
  let lastFailure: string | undefined
  /** Mutating operations share one exclusive queue so start/stop/listen/rotate never interleave. */
  let writeGate = Promise.resolve()
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

  let sessionStore: ReturnType<typeof createSessionStore> | undefined
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleSave = () => {
    if (saveTimer !== undefined) return
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      // Persist through the write gate so dispose/rotate cannot interleave.
      void exclusive(() => save())
    }, 2000)
    saveTimer.unref?.()
  }

  const load = async (): Promise<RuntimeState> => {
    if (state !== undefined) return state
    state = await readState(statePath) as RuntimeState
    // A missing/short token is regenerated. Old device cookies must not
    // survive that — same semantics as an explicit rotate.
    const regeneratedToken = state.accessToken === undefined
    if (regeneratedToken) {
      state.accessToken = generateAccessToken()
    }
    sessionStore = createSessionStore({
      maxSessions: config.maxSessions,
      maxAgeSeconds: config.sessionMaxAgeSeconds,
      idleSeconds: config.sessionIdleSeconds,
      approvalRequired: config.approvalMode,
      onChange: scheduleSave,
    })
    if (!regeneratedToken) sessionStore.hydrate(state.sessions)
    await save()
    return state
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
      ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
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
      authenticated: true,
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

  const stop = async () => {
    await load()
    await closeBound()
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
      ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
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
        keepAliveTimeoutMs: config.keepAliveTimeoutMs,
        loginDelayMs: config.loginDelayMs,
        loginMaxAttempts: config.loginMaxAttempts,
        loginLockoutMs: config.loginLockoutSeconds * 1000,
        sessionStore,
        inviteStore,
        ipAllowed: address => ipAllowed(address, cidrRules),
        audit: (event, fields) => { void audit.record(event, fields) },
        tls,
        trustForwardedProto: config.trustForwardedProto === true,
        trustForwardedFor: config.trustForwardedFor === true,
        log: config.logRequests
          ? entry => { ctx.logger.debug(`reverse-proxy: ${entry.remote ?? '-'} ${entry.method} ${entry.path} -> ${entry.status}`) }
          : undefined,
      })
    } catch (error) {
      ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
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
    await closeBound()
    state!.accessToken = generateAccessToken()
    // Rotation invalidates every device: sessions are independent of the
    // token, so they must be revoked explicitly.
    sessionStore!.clear()
    inviteStore.clear()
    await save()
    void audit.record('token.rotate')
    ctx.logger.info('reverse-proxy: access token rotated')
    if (restart) await start()
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
    state!.listenHost = hostname
    state!.listenPort = portNumber
    lastFailure = undefined
    await save()
    await closeBound()
    if (!wasRunning) {
      ctx.logger.info(`reverse-proxy: publish address set to ${hostname}:${portNumber}`)
      return snapshot()
    }
    const status = await start()
    if (status.running) return status
    // Roll back: keep serving on the address that worked.
    state!.listenHost = previous.host
    state!.listenPort = previous.port
    await save()
    const restored = await start()
    return snapshot({ reason: restored.running ? 'listen-failed-restored' : 'listen-failed' })
  })

  const buildInvite = async (publicBase: string | undefined) => {
    await load()
    const base = String(publicBase ?? '').trim().replace(/\/$/, '')
    const fallback = (await snapshot()).target
    const origin = base === '' ? fallback : base
    let url
    try {
      url = new URL(LOGIN_PATH, origin.endsWith('/') ? origin : `${origin}/`)
    } catch {
      return { error: 'invalid-base' }
    }
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

  /** POST-only control routes mapped to their unwrapped work functions. */
  const actions = new Map<string, () => () => Promise<RuntimeStatus>>([
    [`${CONTROL_PREFIX}/start`, () => start],
    [`${CONTROL_PREFIX}/stop`, () => stop],
    [`${CONTROL_PREFIX}/rotate-token`, () => rotateToken],
  ])

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const path = pathnameOf(req.url)
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      sendJson(res, 403, { error: 'loopback-required' })
      return
    }
    const allowed = (req.headers['x-dsh-reverse-proxy-control'] === '1') && isLoopbackOrigin(req.headers.origin)
    if (path === `${CONTROL_PREFIX}/status` && req.method === 'GET') {
      if (!allowed) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      sendJson(res, 200, await shared(() => snapshot()))
      return
    }
    if (path === `${CONTROL_PREFIX}/self-check` && req.method === 'POST') {
      if (!allowed) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      sendJson(res, 200, await shared(() => runSelfCheck()))
      return
    }
    if (path === `${CONTROL_PREFIX}/invite` && req.method === 'POST') {
      if (!allowed) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      try {
        const body = await readJson(req)
        const invite = await shared(() => buildInvite(body?.publicBase))
        if (invite.error !== undefined) {
          sendJson(res, 400, invite)
          return
        }
        void audit.record('invite.create')
        sendJson(res, 200, invite)
      } catch {
        sendJson(res, 400, { error: 'invalid-request' })
      }
      return
    }
    if (path === `${CONTROL_PREFIX}/token` && req.method === 'GET') {
      if (!allowed) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      if (config.allowTokenRead === false) {
        sendJson(res, 403, { error: 'token-read-disabled' })
        return
      }
      sendJson(res, 200, { accessToken: await exclusive(async () => {
        await load()
        void audit.record('token.reveal')
        return state!.accessToken
      }) })
      return
    }
    if (path === `${CONTROL_PREFIX}/sessions` && req.method === 'GET') {
      if (!allowed) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      sendJson(res, 200, { sessions: await shared(async () => {
        await load()
        return sessionStore!.list()
      }) })
      return
    }
    if (path === `${CONTROL_PREFIX}/audit` && req.method === 'GET') {
      if (!allowed) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      const auditUrl = new URL(req.url ?? '/', 'http://localhost')
      const rawLimit = Number(auditUrl.searchParams.get('limit') ?? 50)
      const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50
      const event = auditUrl.searchParams.get('event')?.trim() || undefined
      sendJson(res, 200, await shared(async () => ({
        enabled: audit.enabled,
        events: await readAuditLog(audit.path, limit, event),
      })))
      return
    }
    const sessionAction = path.match(/^\/dsh-reverse-proxy\/sessions\/(approve|revoke|rename)$/)
    if (sessionAction !== null && req.method === 'POST') {
      if (!allowed) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      try {
        const body = await readJson(req)
        const id = typeof body?.id === 'string' ? body.id : ''
        const result = await exclusive(async () => {
          await load()
          if (sessionAction[1] === 'approve') {
            const ok = sessionStore!.approve(id)
            if (ok) void audit.record('session.approve', { id })
            return ok
          }
          if (sessionAction[1] === 'revoke') {
            const ok = sessionStore!.revoke(id)
            if (ok) void audit.record('session.revoke', { id })
            return ok
          }
          const ok = sessionStore!.rename(id, body?.label)
          if (ok) void audit.record('session.rename', { id })
          return ok
        })
        sendJson(res, 200, { ok: result })
      } catch {
        sendJson(res, 400, { error: 'invalid-request' })
      }
      return
    }
    const action = actions.get(path)
    if (action !== undefined && req.method === 'POST') {
      if (!allowed) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      sendJson(res, 200, await exclusive(action()))
      return
    }
    if (path === `${CONTROL_PREFIX}/listen` && req.method === 'POST') {
      if (!allowed) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      try {
        const body = await readJson(req)
        sendJson(res, 200, await setListen(body?.host, body?.port))
      } catch {
        sendJson(res, 400, { error: 'invalid-request' })
      }
      return
    }
    sendJson(res, 404, { error: 'not-found' })
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
      await closeBound()
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
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Schema.Type<typeof Config>} config
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
