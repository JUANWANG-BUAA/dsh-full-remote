import { createServer, request as httpRequest } from 'node:http'
import { isAuthenticated, safeEqual, sessionCookie } from './security.js'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
])
const SPOOFABLE_FORWARDING = new Set([
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-real-ip',
  'x-dsh-reverse-proxy',
])
/**
 * The proxy's own session cookie never reaches the backend: the backend
 * cannot set cookies for the remote browser anyway (upstream `set-cookie`
 * is stripped), so forwarding it only risks credential confusion.
 */
const INTERNAL_HEADERS = new Set(['cookie'])
const LOGIN_PATH = '/_dsh_reverse_proxy/login'
const LOGIN_FAILURE_DELAY_MS = 250
const MAX_TRACKED_LOGIN_IPS = 4096

/**
 * Per-IP failed-login tracker with a lockout window. The fixed per-attempt
 * delay alone is parallelizable; this bounds total guessing capacity per
 * source address. Memory is bounded: past the cap, expired entries are
 * swept, and under an active spoofed-source attack the oldest entry is
 * evicted so the proxy can never be driven to unbounded memory.
 * @param {{ loginMaxAttempts?: number, loginLockoutMs?: number }} spec
 */
function createLoginTracker(spec) {
  const maxAttempts = spec.loginMaxAttempts ?? 5
  const lockoutMs = spec.loginLockoutMs ?? 300_000
  /** @type {Map<string, { failures: number, firstFailure: number, lockedUntil?: number }>} */
  const buckets = new Map()
  const sweepExpired = (now) => {
    for (const [ip, bucket] of buckets) {
      if (bucket.lockedUntil !== undefined && bucket.lockedUntil <= now) buckets.delete(ip)
      else if (now - bucket.firstFailure > lockoutMs) buckets.delete(ip)
    }
  }
  return {
    /** @returns {number} seconds the client must wait; 0 means allowed. */
    check(ip, now = Date.now()) {
      const bucket = buckets.get(ip)
      if (bucket?.lockedUntil !== undefined) {
        if (bucket.lockedUntil > now) return Math.ceil((bucket.lockedUntil - now) / 1000)
        buckets.delete(ip)
      }
      return 0
    },
    fail(ip, now = Date.now()) {
      const bucket = buckets.get(ip)
      if (bucket === undefined || now - bucket.firstFailure > lockoutMs) {
        buckets.set(ip, { failures: 1, firstFailure: now })
        return
      }
      bucket.failures += 1
      if (bucket.failures >= maxAttempts) bucket.lockedUntil = now + lockoutMs
    },
    success(ip) {
      buckets.delete(ip)
    },
    prune(now = Date.now()) {
      if (buckets.size <= MAX_TRACKED_LOGIN_IPS) return
      sweepExpired(now)
      if (buckets.size <= MAX_TRACKED_LOGIN_IPS) return
      let oldest
      for (const entry of buckets) {
        if (oldest === undefined || entry[1].firstFailure < oldest[1].firstFailure) oldest = entry
      }
      if (oldest !== undefined) buckets.delete(oldest[0])
    },
  }
}

export function pathnameOf(url) {
  try {
    return new URL(url ?? '/', 'http://proxy.invalid').pathname
  } catch {
    return '/'
  }
}

export function forwardHeaders(req, backendHost) {
  const headers = {}
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase()
    if (value === undefined || lower === 'host' || HOP_BY_HOP.has(lower) || SPOOFABLE_FORWARDING.has(lower) || INTERNAL_HEADERS.has(lower)) continue
    headers[lower] = value
  }
  const sourceHost = req.headers.host ?? ''
  const remote = req.socket.remoteAddress ?? ''
  headers.host = backendHost
  headers.origin = `http://${backendHost}`
  headers['x-forwarded-for'] = remote
  headers['x-forwarded-host'] = sourceHost
  headers['x-forwarded-proto'] = 'http'
  headers['x-dsh-reverse-proxy'] = '1'
  return headers
}

function html(res, status, body, extra = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    ...extra,
  })
  res.end(body)
}

const LOGIN_COPY = {
  zh: {
    title: 'DeepSeek Harness 远程访问',
    intro: '此入口由通用反向代理保护。请输入本机控制面显示的访问令牌。',
    label: '访问令牌',
    submit: '进入 DeepSeek Harness',
    invalidToken: '令牌无效，请重试。',
    invalidRequest: '请求无效，请重试。',
  },
  en: {
    title: 'DeepSeek Harness remote access',
    intro: 'This entry is protected by a reverse proxy. Enter the access token shown in the local control panel.',
    label: 'Access token',
    submit: 'Enter DeepSeek Harness',
    invalidToken: 'Invalid token, please retry.',
    invalidRequest: 'Invalid request, please retry.',
  },
}

/** zh stays the default (matching the harness fallback locale); explicit
 *  English Accept-Language heads get the English gate. */
function loginLocale(req) {
  const header = String(req.headers['accept-language'] ?? '').toLowerCase()
  if (header !== '' && !header.startsWith('zh')) return 'en'
  return 'zh'
}

function loginPage(locale, error = '') {
  const copy = LOGIN_COPY[locale] ?? LOGIN_COPY.zh
  const message = error === '' ? '' : `<p role="alert">${error}</p>`
  return `<!doctype html><html lang="${locale === 'en' ? 'en' : 'zh-CN'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${copy.title}</title><style>
  :root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif}body{min-height:100dvh;margin:0;display:grid;place-items:center;background:#f4f6f8;color:#15171a}.card{box-sizing:border-box;width:min(92vw,420px);padding:28px;border:1px solid #d9dde3;border-radius:20px;background:#fff;box-shadow:0 16px 48px #0002}h1{font-size:22px;margin:0 0 8px}p{font-size:14px;line-height:1.6;color:#5b6470}label{display:block;font-size:13px;font-weight:600;margin:22px 0 8px}input,button{box-sizing:border-box;width:100%;min-height:48px;border-radius:12px;font:inherit}input{padding:0 14px;border:1px solid #c8ced7;background:transparent;color:inherit}button{margin-top:14px;border:0;background:#111;color:#fff;font-weight:650;cursor:pointer}@media(prefers-color-scheme:dark){body{background:#111418;color:#f7f8fa}.card{background:#1b1f24;border-color:#343a43}p{color:#aeb6c2}input{border-color:#4b535e}button{background:#f7f8fa;color:#111}}@media(prefers-reduced-motion:no-preference){button{transition:transform .15s ease}button:active{transform:scale(.98)}}</style></head><body><main class="card"><h1>${copy.title}</h1><p>${copy.intro}</p>${message}<form method="post" action="${LOGIN_PATH}"><label for="token">${copy.label}</label><input id="token" name="token" type="password" autocomplete="current-password" required autofocus><button type="submit">${copy.submit}</button></form></main></body></html>`
}

function denySocket(socket, status = '403 Forbidden') {
  socket.write(`HTTP/1.1 ${status}\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\nforbidden\n`)
  socket.destroy()
}

function readForm(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('form-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function proxyRequest(req, res, spec) {
  const contentLength = Number(req.headers['content-length'] ?? 0)
  if (!Number.isFinite(contentLength) || contentLength > spec.maxRequestBytes) {
    res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
    res.end('request too large\n')
    return
  }
  const up = httpRequest({
    hostname: spec.backendHost,
    port: spec.backendPort,
    path: req.url,
    method: req.method,
    headers: forwardHeaders(req, spec.backendAuthority),
  }, (incoming) => {
    clearTimeout(connectTimer)
    const responseHeaders = { ...incoming.headers }
    delete responseHeaders['set-cookie']
    res.writeHead(incoming.statusCode ?? 502, responseHeaders)
    incoming.pipe(res)
  })
  spec.trackUpstream?.(up)
  const connectTimer = setTimeout(() => {
    up.destroy(new Error('upstream timeout'))
  }, spec.upstreamTimeoutMs)
  connectTimer.unref()
  up.on('error', () => {
    clearTimeout(connectTimer)
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('bad gateway\n')
    } else {
      res.destroy()
    }
  })
  // Enforce the byte limit on the stream itself: a chunked upload declares no
  // content-length, so the header check above cannot see its real size.
  let received = 0
  let overflow = false
  req.on('data', (chunk) => {
    received += chunk.length
    if (!overflow && received > spec.maxRequestBytes) {
      overflow = true
      req.unpipe(up)
      up.destroy()
      if (!res.headersSent) {
        res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
        res.end('request too large\n')
      } else {
        res.destroy()
      }
    }
  })
  // A client abort must not leave the upstream request hanging.
  req.once('error', () => { up.destroy() })
  req.pipe(up)
}

async function handleLogin(req, res, spec) {
  if (req.method === 'GET') {
    html(res, 200, loginPage(loginLocale(req)))
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'GET, POST' })
    res.end()
    return
  }
  try {
    const remote = req.socket.remoteAddress ?? ''
    const retryAfter = spec.loginTracker.check(remote)
    if (retryAfter > 0) {
      res.writeHead(429, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'retry-after': String(retryAfter),
      })
      res.end('too many attempts\n')
      return
    }
    const form = new URLSearchParams(await readForm(req))
    if (!safeEqual(form.get('token') ?? '', spec.accessToken)) {
      spec.loginTracker.fail(remote)
      spec.loginTracker.prune()
      // Fixed delay so a failed login costs the same as a successful one,
      // slowing token guessing without a measurable timing difference.
      await new Promise(resolve => setTimeout(resolve, spec.loginDelayMs ?? LOGIN_FAILURE_DELAY_MS))
      html(res, 401, loginPage(loginLocale(req), LOGIN_COPY[loginLocale(req)].invalidToken))
      return
    }
    spec.loginTracker.success(remote)
    const secure = req.headers['x-forwarded-proto'] === 'https'
    res.writeHead(303, {
      location: '/',
      'set-cookie': sessionCookie(spec.accessToken, spec.cookieName, secure, spec.sessionMaxAgeSeconds),
      'cache-control': 'no-store',
    })
    res.end()
  } catch {
    html(res, 400, loginPage(loginLocale(req), LOGIN_COPY[loginLocale(req)].invalidRequest))
  }
}

/**
 * Start an authenticated reverse proxy suitable for any external tunnel.
 * @param {{
 *  listenHost: string, listenPort: number, backendHost: string, backendPort: number,
 *  accessToken: string, cookieName: string, controlPrefix: string,
 *  maxRequestBytes: number, upstreamTimeoutMs: number, sessionMaxAgeSeconds: number,
 *  maxHeaderSizeBytes?: number, headersTimeoutMs?: number, keepAliveTimeoutMs?: number,
 *  loginDelayMs?: number, loginMaxAttempts?: number, loginLockoutMs?: number,
 *  log?: (entry: { method: string, path: string, status: number, remote: string }) => void,
 * }} spec
 * @returns {Promise<{ host: string, port: number, close: () => Promise<void> }>}
 */
export function listenProxy(spec) {
  const backendAuthority = `${spec.backendHost}:${spec.backendPort}`
  // Node's closeAllConnections() does not cover upgraded sockets (neither our
  // own client side nor our outbound upstream requests) — track both so
  // close() fully tears down WebSocket sessions.
  const upgradedSockets = new Set()
  const upstreamSockets = new Set()
  const trackUpstream = (up) => {
    upstreamSockets.add(up)
    up.once('close', () => upstreamSockets.delete(up))
  }
  const runtimeSpec = { ...spec, backendAuthority, trackUpstream, loginTracker: createLoginTracker(spec) }
  const logRequest = spec.log === undefined ? undefined : (req, res) => {
    res.once('finish', () => {
      spec.log({ method: req.method, path: req.url ?? '/', status: res.statusCode, remote: req.socket.remoteAddress ?? '' })
    })
  }
  const server = createServer({
    maxHeaderSize: spec.maxHeaderSizeBytes ?? 16 * 1024,
    requestTimeout: 0,
    headersTimeout: spec.headersTimeoutMs ?? 15_000,
    keepAliveTimeout: spec.keepAliveTimeoutMs ?? 5_000,
  }, async (req, res) => {
    logRequest?.(req, res)
    const path = pathnameOf(req.url)
    if (path === '/_dsh_reverse_proxy/healthz') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end('{"ok":true}\n')
      return
    }
    if (path === LOGIN_PATH) {
      await handleLogin(req, res, runtimeSpec)
      return
    }
    if (path.startsWith(spec.controlPrefix)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('forbidden\n')
      return
    }
    if (!isAuthenticated(req, spec.accessToken, spec.cookieName)) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        res.writeHead(303, { location: LOGIN_PATH, 'cache-control': 'no-store' })
        res.end()
      } else {
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end('{"error":"authentication-required"}\n')
      }
      return
    }
    proxyRequest(req, res, runtimeSpec)
  })

  server.on('upgrade', (req, socket, head) => {
    upgradedSockets.add(socket)
    socket.once('close', () => upgradedSockets.delete(socket))
    const path = pathnameOf(req.url)
    if (path.startsWith(spec.controlPrefix) || !isAuthenticated(req, spec.accessToken, spec.cookieName)) {
      denySocket(socket, '401 Unauthorized')
      spec.log?.({ method: req.method, path: req.url ?? '/', status: 401, remote: req.socket.remoteAddress ?? '' })
      return
    }
    const headers = forwardHeaders(req, backendAuthority)
    headers.connection = 'Upgrade'
    headers.upgrade = req.headers.upgrade ?? 'websocket'
    const up = httpRequest({
      hostname: spec.backendHost,
      port: spec.backendPort,
      path: req.url,
      method: 'GET',
      headers,
    })
    trackUpstream(up)
    up.setTimeout(spec.upstreamTimeoutMs, () => { up.destroy() })
    up.on('upgrade', (upRes, upSocket, upHead) => {
      // After a successful upgrade Node detaches the socket from the request,
      // so req.destroy() would leave it open — track the socket itself too.
      trackUpstream(upSocket)
      spec.log?.({ method: req.method, path: req.url ?? '/', status: upRes.statusCode ?? 101, remote: req.socket.remoteAddress ?? '' })
      const lines = [`HTTP/1.1 ${upRes.statusCode ?? 101} ${upRes.statusMessage ?? 'Switching Protocols'}`]
      for (const [key, value] of Object.entries(upRes.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) lines.push(`${key}: ${item}`)
        } else if (value !== undefined) {
          lines.push(`${key}: ${value}`)
        }
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (upHead.length > 0) socket.write(upHead)
      if (head.length > 0) upSocket.write(head)
      upSocket.pipe(socket)
      socket.pipe(upSocket)
    })
    // Upstream answered without upgrading (non-101): relay the status line
    // and close instead of leaving the client socket hanging.
    up.on('response', (upRes) => {
      const lines = [`HTTP/1.1 ${upRes.statusCode ?? 502} ${upRes.statusMessage ?? 'Bad Gateway'}`, 'Connection: close']
      for (const [key, value] of Object.entries(upRes.headers)) {
        if (key.toLowerCase() === 'connection' || key.toLowerCase() === 'transfer-encoding') continue
        if (Array.isArray(value)) {
          for (const item of value) lines.push(`${key}: ${item}`)
        } else if (value !== undefined) {
          lines.push(`${key}: ${value}`)
        }
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      socket.destroy()
    })
    up.on('error', () => { socket.destroy() })
    socket.on('error', () => { up.destroy() })
    up.end()
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(spec.listenPort, spec.listenHost, () => {
      server.off('error', reject)
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : spec.listenPort
      let closed = false
      resolve({
        host: spec.listenHost,
        port,
        close: () => new Promise((done, closeReject) => {
          // Idempotent: runtime rollback paths may race a second close.
          if (closed) {
            done()
            return
          }
          closed = true
          server.close((error) => error === undefined ? done() : closeReject(error))
          server.closeAllConnections?.()
          // closeAllConnections() leaves upgraded sockets alone — destroy
          // both sides of every live WebSocket session explicitly.
          for (const socket of upgradedSockets) socket.destroy()
          for (const up of upstreamSockets) up.destroy()
        }),
      })
    })
  })
}
