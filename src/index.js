import Schema from '@deepseek-ai/schemastery'
import { listenProxy } from './proxy.js'
import { defaultStateFile, readState, writeState } from './persist.js'
import { generateAccessToken } from './security.js'

export const name = 'reverse-proxy'
export const inject = ['webServer']

export const Config = Schema.object({
  listenHost: Schema.string().default('127.0.0.1').description('Default address exposed to the tunnel client; the UI can override it at runtime.'),
  listenPort: Schema.number().min(0).max(65535).default(3081).description('Default local tunnel target port; 0 chooses a free port; the UI can override it at runtime.'),
  backendHost: Schema.string().default('127.0.0.1').description('DeepSeek Harness Web backend host.'),
  backendPort: Schema.number().min(0).max(65535).default(0).description('DeepSeek Harness Web backend port; 0 follows webServer.port.'),
  stateFile: Schema.string().default('').description('Durable state file; empty uses $DSH_HOME/reverse-proxy.json.'),
  autoRestore: Schema.boolean().default(true).description('Restore the last enabled state after DeepSeek Harness restarts.'),
  maxRequestBytes: Schema.number().min(1024).default(16 * 1024 * 1024).description('Maximum declared request body size.'),
  upstreamTimeoutMs: Schema.number().min(1000).default(15_000).description('Timeout while connecting to the DeepSeek Harness backend.'),
  sessionMaxAgeSeconds: Schema.number().min(60).default(30 * 24 * 3600).description('Lifetime of the remote browser session cookie.'),
  cookieName: Schema.string().default('dsh_reverse_proxy_session').description('Authentication session cookie name.'),
})

const CONTROL_PREFIX = '/dsh-reverse-proxy'
const VIEWPORT = 'width=device-width, initial-scale=1, viewport-fit=cover'

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

function pathnameOf(url) {
  try {
    return new URL(url ?? '/', 'http://x').pathname
  } catch {
    return '/'
  }
}

export function injectViewport(html) {
  return html.replace(
    /content="width=device-width, initial-scale=1(?:, viewport-fit=cover)?"/,
    `content="${VIEWPORT}"`,
  )
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

function readJson(req, limit = 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    req.on('error', reject)
  })
}

export function createRuntime(ctx, config) {
  /** @type {{ host: string, port: number, close: () => Promise<void> } | undefined} */
  let bound
  let disposed = false
  let state
  /** @type {Promise<void>} */
  let gate = Promise.resolve()
  const statePath = config.stateFile || defaultStateFile()

  const serial = (fn) => {
    const run = gate.then(fn, fn)
    gate = run.then(() => {}, () => {})
    return run
  }

  const load = async () => {
    if (state !== undefined) return state
    state = await readState(statePath)
    if (state.accessToken === undefined) {
      state.accessToken = generateAccessToken()
      await save()
    }
    return state
  }

  const save = async () => {
    if (state === undefined) return
    try {
      await writeState(statePath, {
        enabled: state.enabled,
        accessToken: state.accessToken,
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
    const { host, port } = effectiveListen()
    return {
      enabled: state.enabled,
      running: bound !== undefined,
      target: bound === undefined
        ? `http://${host}:${port}`
        : `http://${bound.host}:${bound.port}`,
      backend: `http://${config.backendHost}:${backendPort}`,
      listen: effectiveListen(),
      authenticated: true,
      ...extra,
    }
  }

  const closeBound = async () => {
    const current = bound
    bound = undefined
    if (current !== undefined) await current.close()
  }

  const stop = async () => {
    await load()
    await closeBound()
    state.enabled = false
    await save()
    return snapshot()
  }

  const start = async () => {
    await load()
    if (disposed) return snapshot({ reason: 'disposed' })
    if (bound !== undefined) return snapshot()
    const { host, port } = effectiveListen()
    try {
      bound = await listenProxy({
        listenHost: host,
        listenPort: port,
        backendHost: config.backendHost,
        backendPort: config.backendPort || ctx.webServer.port,
        accessToken: state.accessToken,
        cookieName: config.cookieName,
        controlPrefix: CONTROL_PREFIX,
        maxRequestBytes: config.maxRequestBytes,
        upstreamTimeoutMs: config.upstreamTimeoutMs,
        sessionMaxAgeSeconds: config.sessionMaxAgeSeconds,
      })
    } catch (error) {
      ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      return snapshot({ reason: 'listen-failed' })
    }
    state.enabled = true
    await save()
    return snapshot()
  }

  const rotateToken = () => serial(async () => {
    await load()
    const restart = bound !== undefined
    await closeBound()
    state.accessToken = generateAccessToken()
    await save()
    if (restart) await start()
    return { ...(await snapshot()), accessToken: state.accessToken }
  })

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
    await save()
    await closeBound()
    if (!wasRunning) return snapshot()
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
      json(res, 403, { error: 'loopback-required' })
      return
    }
    if (path === `${CONTROL_PREFIX}/status` && req.method === 'GET') {
      json(res, 200, await serial(() => snapshot()))
      return
    }
    if (path === `${CONTROL_PREFIX}/token` && req.method === 'GET') {
      json(res, 200, { accessToken: await serial(async () => {
        await load()
        return state.accessToken
      }) })
      return
    }
    const allowed = (req.headers['x-dsh-reverse-proxy-control'] === '1') && isLoopbackOrigin(req.headers.origin)
    const actions = new Map([
      [`${CONTROL_PREFIX}/start`, () => start],
      [`${CONTROL_PREFIX}/stop`, () => stop],
      [`${CONTROL_PREFIX}/rotate-token`, () => rotateToken],
    ])
    const action = actions.get(path)
    if (action !== undefined && req.method === 'POST') {
      if (!allowed) {
        json(res, 403, { error: 'forbidden' })
        return
      }
      json(res, 200, await serial(action()))
      return
    }
    if (path === `${CONTROL_PREFIX}/listen` && req.method === 'POST') {
      if (!allowed) {
        json(res, 403, { error: 'forbidden' })
        return
      }
      try {
        const body = await readJson(req)
        json(res, 200, await setListen(body?.host, body?.port))
      } catch {
        json(res, 400, { error: 'invalid-request' })
      }
      return
    }
    json(res, 404, { error: 'not-found' })
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
      await closeBound()
    }),
    status: () => serial(() => snapshot()),
    start: () => serial(start),
    stop: () => serial(stop),
    token: () => serial(async () => {
      await load()
      return state.accessToken
    }),
    rotateToken,
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
  const runtime = createRuntime(ctx, config)
  ctx.effect(() => {
    const unroute = ctx.webServer.register({
      kind: 'prefix',
      path: CONTROL_PREFIX,
      handler: (req, res) => runtime.handle(req, res),
    })
    const untap = ctx.webServer.tapIndex(injectViewport)
    void runtime.restore()
    return async () => {
      unroute()
      untap()
      await runtime.dispose()
    }
  }, 'reverse-proxy')
}
