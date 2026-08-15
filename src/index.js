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
import { listenProxy } from './proxy.js'
import { defaultStateFile, readState, writeState } from './persist.js'
import { generateAccessToken } from './security.js'
import { createSessionStore } from './sessions.js'
import { pathnameOf, readJson, sendJson, formatHttpUrl, isSelfLoop, isWildcardHost, publishHost, reachableHosts } from './http-util.js'
import { PAGE_BOOTSTRAP_SOURCE } from './page-bootstrap.js'

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
  sessionMaxAgeSeconds: Schema.number().min(60).default(30 * 24 * 3600).description('Lifetime of the remote browser session cookie.'),
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
})

const CONTROL_PREFIX = '/dsh-reverse-proxy'
const VIEWPORT = 'width=device-width, initial-scale=1, viewport-fit=cover'
// FROZEN (roadmap §7.1 class 2/3/4): plugin id, cookie name, control prefix,
// forwarding header, polyfill marker. Renaming any of these drops sessions
// or silently disables anti-spoof stripping. Only the npm package name moves.

export function injectViewport(html) {
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

export function injectIndexEnhancements(html) {
  const withViewport = injectViewport(html)
  if (!withViewport.includes('<head>')) return withViewport
  // Idempotent: multiple taps (or a retried transform) must not stack copies.
  if (withViewport.includes('data-plugin="dsh-reverse-proxy"')) return withViewport
  return withViewport.replace('<head>', `<head>${INDEX_BOOTSTRAP}`)
}

function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function isLoopbackOrigin(origin) {
  if (origin === undefined) return true
  try {
    const hostname = new URL(origin).hostname
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
  } catch {
    return false
  }
}

/** Hostnames, IPv4, and bracketed IPv6 all pass; node listen() is the final judge. */
function isValidListenHost(value) {
  if (value.length === 0 || value.length > 253) return false
  return !/[\s/\\]/.test(value)
}

export function createRuntime(ctx, config) {
  /** @type {{ host: string, port: number, close: () => Promise<void> } | undefined} */
  let bound
  let disposed = false
  let state
  /** Last start refusal, kept in memory so the panel can explain a stopped proxy. @type {string | undefined} */
  let lastFailure
  /** @type {Promise<void>} */
  let gate = Promise.resolve()
  const statePath = config.stateFile || defaultStateFile()

  const serial = (fn) => {
    const run = gate.then(fn, fn)
    gate = run.then(() => {}, () => {})
    return run
  }

  let sessionStore
  let saveTimer
  const scheduleSave = () => {
    if (saveTimer !== undefined) return
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      void save()
    }, 2000)
    saveTimer.unref?.()
  }

  const load = async () => {
    if (state !== undefined) return state
    state = await readState(statePath)
    if (state.accessToken === undefined) {
      state.accessToken = generateAccessToken()
    }
    sessionStore = createSessionStore({
      maxSessions: config.maxSessions,
      maxAgeSeconds: config.sessionMaxAgeSeconds,
      approvalRequired: config.approvalMode,
      onChange: scheduleSave,
    })
    sessionStore.hydrate(state.sessions)
    await save()
    return state
  }

  const save = async () => {
    if (state === undefined) return
    try {
      await writeState(statePath, {
        enabled: state.enabled,
        accessToken: state.accessToken,
        sessions: sessionStore.serialize(),
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
    port: Number.isInteger(state?.listenPort) ? state.listenPort : config.listenPort,
  })

  const snapshot = async (extra = {}) => {
    await load()
    const backendPort = config.backendPort || ctx.webServer.port
    const listen = bound === undefined ? effectiveListen() : { host: bound.host, port: bound.port }
    const published = publishHost(listen.host)
    const reason = extra.reason ?? lastFailure
    return {
      enabled: state.enabled,
      running: bound !== undefined,
      target: formatHttpUrl(published, listen.port),
      backend: formatHttpUrl(config.backendHost, backendPort),
      listen,
      bound: listen,
      reachables: reachableHosts(listen.host).map(host => formatHttpUrl(host, listen.port)),
      wildcard: isWildcardHost(listen.host),
      approvalMode: config.approvalMode,
      authenticated: true,
      ...(reason !== undefined ? { reason } : {}),
    }
  }

  const closeBound = async () => {
    const current = bound
    bound = undefined
    if (current !== undefined) {
      await current.close()
      ctx.logger.info(`reverse-proxy: stopped listening on ${formatHttpUrl(current.host, current.port)}`)
    }
  }

  const stop = async () => {
    await load()
    await closeBound()
    state.enabled = false
    lastFailure = undefined
    await save()
    return snapshot()
  }

  const failStart = (reason) => {
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
      ctx.logger.warn(`reverse-proxy: refusing to start — listen ${formatHttpUrl(host, port)} would loop onto backend ${formatHttpUrl(config.backendHost, backendPort)}`)
      return failStart('self-loop')
    }
    try {
      bound = await listenProxy({
        listenHost: host,
        listenPort: port,
        backendHost: config.backendHost,
        backendPort,
        accessToken: state.accessToken,
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
        log: config.logRequests
          ? entry => { ctx.logger.debug(`reverse-proxy: ${entry.remote ?? '-'} ${entry.method} ${entry.path} -> ${entry.status}`) }
          : undefined,
      })
    } catch (error) {
      ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      return failStart('listen-failed')
    }
    lastFailure = undefined
    state.enabled = true
    await save()
    ctx.logger.info(`reverse-proxy: listening on ${formatHttpUrl(bound.host, bound.port)}`)
    return snapshot()
  }

  // Same shape as start/stop: the work function is unwrapped. HTTP handle
  // and the runtime export each wrap it in serial() once. Wrapping here AND
  // in handle() nested the same gate (gate waits for rotateToken, which
  // waits for gate) and froze the control panel on "Rotate token".
  const rotateToken = async () => {
    await load()
    const restart = bound !== undefined
    await closeBound()
    state.accessToken = generateAccessToken()
    // Rotation invalidates every device: sessions are independent of the
    // token, so they must be revoked explicitly.
    sessionStore.clear()
    await save()
    ctx.logger.info('reverse-proxy: access token rotated')
    if (restart) await start()
    return { ...(await snapshot()), accessToken: state.accessToken }
  }

  /**
   * Change the published listen address at runtime. A running proxy is
   * restarted on the new address; when the new bind fails, the previous
   * address is restored so the user never loses an already working entry.
   */
  const setListen = (host, port) => serial(async () => {
    await load()
    const hostname = String(host ?? '').trim()
    const portNumber = Number(port)
    if (!isValidListenHost(hostname) || !Number.isInteger(portNumber) || portNumber < 0 || portNumber > 65535) {
      return snapshot({ reason: 'invalid-listen' })
    }
    const previous = effectiveListen()
    if (hostname === previous.host && portNumber === previous.port) return snapshot()
    const wasRunning = bound !== undefined
    state.listenHost = hostname
    state.listenPort = portNumber
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
    state.listenHost = previous.host
    state.listenPort = previous.port
    await save()
    const restored = await start()
    return snapshot({ reason: restored.running ? 'listen-failed-restored' : 'listen-failed' })
  })

  const handle = async (req, res) => {
    const path = pathnameOf(req.url)
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      sendJson(res, 403, { error: 'loopback-required' })
      return
    }
    const allowed = (req.headers['x-dsh-reverse-proxy-control'] === '1') && isLoopbackOrigin(req.headers.origin)
    if (path === `${CONTROL_PREFIX}/status` && req.method === 'GET') {
      sendJson(res, 200, await serial(() => snapshot()))
      return
    }
    if (path === `${CONTROL_PREFIX}/token` && req.method === 'GET') {
      if (!allowed) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      sendJson(res, 200, { accessToken: await serial(async () => {
        await load()
        return state.accessToken
      }) })
      return
    }
    const actions = new Map([
      [`${CONTROL_PREFIX}/start`, () => start],
      [`${CONTROL_PREFIX}/stop`, () => stop],
      [`${CONTROL_PREFIX}/rotate-token`, () => rotateToken],
    ])
    if (path === `${CONTROL_PREFIX}/sessions` && req.method === 'GET') {
      sendJson(res, 200, { sessions: await serial(async () => {
        await load()
        return sessionStore.list()
      }) })
      return
    }
    const sessionAction = path.match(/^\/dsh-reverse-proxy\/sessions\/(approve|revoke)$/)
    if (sessionAction !== null && req.method === 'POST') {
      if (!allowed) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      try {
        const body = await readJson(req)
        const id = typeof body?.id === 'string' ? body.id : ''
        const result = await serial(async () => {
          await load()
          return sessionAction[1] === 'approve' ? sessionStore.approve(id) : sessionStore.revoke(id)
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
      sendJson(res, 200, await serial(action()))
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
    restore: () => serial(async () => {
      await load()
      if (!config.autoRestore || !state.enabled || disposed) return
      const status = await start()
      if (!status.running) {
        ctx.logger.warn(`reverse-proxy: persisted start skipped (${status.reason ?? 'unknown'})`)
      }
    }),
    dispose: () => serial(async () => {
      disposed = true
      if (saveTimer !== undefined) {
        clearTimeout(saveTimer)
        saveTimer = undefined
      }
      await closeBound()
      await save()
    }),
    status: () => serial(() => snapshot()),
    start: () => serial(start),
    stop: () => serial(stop),
    token: () => serial(async () => {
      await load()
      return state.accessToken
    }),
    rotateToken: () => serial(rotateToken),
    setListen,
    handle,
  }
}

/**
 * Publish an authenticated local reverse-proxy endpoint for any tunnel client.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Schema.Type<typeof Config>} config
 */
export function apply(ctx, config) {
  if (isWildcardHost(config.backendHost)) {
    throw new Error(`reverse-proxy: backendHost "${config.backendHost}" is a wildcard listen address, not a backend. Use 127.0.0.1.`)
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
