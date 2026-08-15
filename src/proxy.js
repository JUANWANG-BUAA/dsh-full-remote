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

function loginPage(error = '') {
  const message = error === '' ? '' : `<p role="alert">${error}</p>`
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>DeepSeek Harness 远程访问</title><style>
  :root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif}body{min-height:100dvh;margin:0;display:grid;place-items:center;background:#f4f6f8;color:#15171a}.card{box-sizing:border-box;width:min(92vw,420px);padding:28px;border:1px solid #d9dde3;border-radius:20px;background:#fff;box-shadow:0 16px 48px #0002}h1{font-size:22px;margin:0 0 8px}p{font-size:14px;line-height:1.6;color:#5b6470}label{display:block;font-size:13px;font-weight:600;margin:22px 0 8px}input,button{box-sizing:border-box;width:100%;min-height:48px;border-radius:12px;font:inherit}input{padding:0 14px;border:1px solid #c8ced7;background:transparent;color:inherit}button{margin-top:14px;border:0;background:#111;color:#fff;font-weight:650;cursor:pointer}@media(prefers-color-scheme:dark){body{background:#111418;color:#f7f8fa}.card{background:#1b1f24;border-color:#343a43}p{color:#aeb6c2}input{border-color:#4b535e}button{background:#f7f8fa;color:#111}}@media(prefers-reduced-motion:no-preference){button{transition:transform .15s ease}button:active{transform:scale(.98)}}</style></head><body><main class="card"><h1>DeepSeek Harness 远程访问</h1><p>此入口由通用反向代理保护。请输入本机控制面显示的访问令牌。</p>${message}<form method="post" action="${LOGIN_PATH}"><label for="token">访问令牌</label><input id="token" name="token" type="password" autocomplete="current-password" required autofocus><button type="submit">进入 DeepSeek Harness</button></form></main></body></html>`
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
    html(res, 200, loginPage())
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'GET, POST' })
    res.end()
    return
  }
  try {
    const form = new URLSearchParams(await readForm(req))
    if (!safeEqual(form.get('token') ?? '', spec.accessToken)) {
      // Fixed delay so a failed login costs the same as a successful one,
      // slowing token guessing without a measurable timing difference.
      await new Promise(resolve => setTimeout(resolve, spec.loginDelayMs ?? LOGIN_FAILURE_DELAY_MS))
      html(res, 401, loginPage('令牌无效，请重试。'))
      return
    }
    const secure = req.headers['x-forwarded-proto'] === 'https'
    res.writeHead(303, {
      location: '/',
      'set-cookie': sessionCookie(spec.accessToken, spec.cookieName, secure, spec.sessionMaxAgeSeconds),
      'cache-control': 'no-store',
    })
    res.end()
  } catch {
    html(res, 400, loginPage('请求无效，请重试。'))
  }
}

/**
 * Start an authenticated reverse proxy suitable for any external tunnel.
 * @param {{
 *  listenHost: string, listenPort: number, backendHost: string, backendPort: number,
 *  accessToken: string, cookieName: string, controlPrefix: string,
 *  maxRequestBytes: number, upstreamTimeoutMs: number, sessionMaxAgeSeconds: number,
 *  maxHeaderSizeBytes?: number, headersTimeoutMs?: number, keepAliveTimeoutMs?: number,
 *  loginDelayMs?: number,
 * }} spec
 * @returns {Promise<{ host: string, port: number, close: () => Promise<void> }>}
 */
export function listenProxy(spec) {
  const backendAuthority = `${spec.backendHost}:${spec.backendPort}`
  const runtimeSpec = { ...spec, backendAuthority }
  const server = createServer({
    maxHeaderSize: spec.maxHeaderSizeBytes ?? 16 * 1024,
    requestTimeout: 0,
    headersTimeout: spec.headersTimeoutMs ?? 15_000,
    keepAliveTimeout: spec.keepAliveTimeoutMs ?? 5_000,
  }, async (req, res) => {
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
    const path = pathnameOf(req.url)
    if (path.startsWith(spec.controlPrefix) || !isAuthenticated(req, spec.accessToken, spec.cookieName)) {
      denySocket(socket, '401 Unauthorized')
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
    up.setTimeout(spec.upstreamTimeoutMs, () => { up.destroy() })
    up.on('upgrade', (upRes, upSocket, upHead) => {
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
      resolve({
        host: spec.listenHost,
        port,
        close: () => new Promise((done, closeReject) => {
          server.close((error) => error === undefined ? done() : closeReject(error))
          server.closeAllConnections?.()
        }),
      })
    })
  })
}
