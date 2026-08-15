import Schema from '@deepseek-ai/schemastery'
import { listenProxy } from './proxy.js'
import { defaultStateFile, readState, writeState } from './persist.js'
import { generateAccessToken } from './security.js'

export const name = 'reverse-proxy'
export const inject = ['webServer']

export const Config = Schema.object({
  listenHost: Schema.string().default('127.0.0.1').description('Address exposed to the tunnel client.'),
  listenPort: Schema.number().min(0).max(65535).default(3081).description('Local tunnel target port; 0 chooses a free port.'),
  backendHost: Schema.string().default('127.0.0.1').description('DSh Web backend host.'),
  backendPort: Schema.number().min(0).max(65535).default(0).description('DSh Web backend port; 0 follows webServer.port.'),
  stateFile: Schema.string().default('').description('Durable state file; empty uses $DSH_HOME/reverse-proxy.json.'),
  autoRestore: Schema.boolean().default(true).description('Restore the last enabled state after DSh restarts.'),
  maxRequestBytes: Schema.number().min(1024).default(16 * 1024 * 1024).description('Maximum declared request body size.'),
  upstreamTimeoutMs: Schema.number().min(1000).default(15_000).description('Timeout while connecting to the DSh backend.'),
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

function createRuntime(ctx, config) {
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
      })
    } catch (error) {
      ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
    }
  }

  const snapshot = async (extra = {}) => {
    await load()
    const backendPort = config.backendPort || ctx.webServer.port
    return {
      enabled: state.enabled,
      running: bound !== undefined,
      target: bound === undefined
        ? `http://${config.listenHost}:${config.listenPort}`
        : `http://${bound.host}:${bound.port}`,
      backend: `http://${config.backendHost}:${backendPort}`,
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
    try {
      bound = await listenProxy({
        listenHost: config.listenHost,
        listenPort: config.listenPort,
        backendHost: config.backendHost,
        backendPort: config.backendPort || ctx.webServer.port,
        accessToken: state.accessToken,
        cookieName: config.cookieName,
        controlPrefix: CONTROL_PREFIX,
        maxRequestBytes: config.maxRequestBytes,
        upstreamTimeoutMs: config.upstreamTimeoutMs,
      })
    } catch (error) {
      ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      return snapshot({ reason: 'listen-failed' })
    }
    state.enabled = true
    await save()
    return snapshot()
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
    rotateToken: () => serial(async () => {
      await load()
      const restart = bound !== undefined
      await closeBound()
      state.accessToken = generateAccessToken()
      await save()
      if (restart) await start()
      return { ...(await snapshot()), accessToken: state.accessToken }
    }),
    handle: async (req, res) => {
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
      const actions = new Map([
        [`${CONTROL_PREFIX}/start`, start],
        [`${CONTROL_PREFIX}/stop`, stop],
        [`${CONTROL_PREFIX}/rotate-token`, async () => {
          const restart = bound !== undefined
          await closeBound()
          state.accessToken = generateAccessToken()
          await save()
          if (restart) await start()
          return { ...(await snapshot()), accessToken: state.accessToken }
        }],
      ])
      const action = actions.get(path)
      if (action !== undefined && req.method === 'POST') {
        if (
          req.headers['x-dsh-reverse-proxy-control'] !== '1'
          || !isLoopbackOrigin(req.headers.origin)
        ) {
          json(res, 403, { error: 'forbidden' })
          return
        }
        json(res, 200, await serial(action))
        return
      }
      json(res, 404, { error: 'not-found' })
    },
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
