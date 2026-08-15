import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { createConnection } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { injectViewport } from '../src/index.js'
import { readState, writeState } from '../src/persist.js'
import { forwardHeaders, listenProxy } from '../src/proxy.js'
import {
  generateAccessToken,
  isAuthenticated,
  parseCookies,
  safeEqual,
  sessionCookie,
} from '../src/security.js'

const cleanups = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).reverse().map(fn => fn()))
})

function http({ port, path = '/', method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    if (body !== undefined) req.end(body)
    else req.end()
  })
}

function chunked({ port, path = '/', headers = {}, chunks }) {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: { ...headers, 'transfer-encoding': 'chunked' },
    }, (res) => {
      const parts = []
      res.on('data', chunk => parts.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString('utf8') }))
    })
    req.on('error', reject)
    for (const chunk of chunks) req.write(chunk)
    req.end()
  })
}

/** Raw WebSocket handshake over a plain TCP socket; resolves once the proxy
 * has written its complete response head (101 relay or 401 deny). */
function wsHandshake({ port, path = '/ws', cookie }) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(port, '127.0.0.1')
    const chunks = []
    let settled = false
    const settle = (error, result) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve({ socket, ...result })
    }
    const parse = (chunk) => {
      chunks.push(chunk)
      const buffer = Buffer.concat(chunks)
      const at = buffer.indexOf('\r\n\r\n')
      if (at === -1) return
      socket.removeListener('data', parse)
      const lines = buffer.slice(0, at).toString('utf8').split('\r\n')
      settle(undefined, { status: lines[0] ?? '', headers: lines.slice(1), head: buffer.slice(at + 4) })
    }
    socket.on('data', parse)
    socket.on('error', error => settle(error))
    socket.on('close', () => settle(new Error('socket closed before handshake completed')))
    socket.on('connect', () => {
      socket.write([
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        ...(cookie === undefined ? [] : [`Cookie: ${cookie}`]),
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        '',
        '',
      ].join('\r\n'))
    })
  })
}

/** Wait for data on an established raw socket; resolves 100ms after the last
 * chunk so a split frame arrives whole. */
function readSocket(socket, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket read timeout')), timeoutMs)
    const parts = []
    const onData = (chunk) => {
      parts.push(chunk)
      clearTimeout(timer)
      setTimeout(() => {
        socket.removeListener('data', onData)
        resolve(Buffer.concat(parts))
      }, 100)
    }
    socket.on('data', onData)
  })
}

describe('security', () => {
  it('generates strong URL-safe tokens and compares them safely', () => {
    const token = generateAccessToken()
    assert.match(token, /^[A-Za-z0-9_-]{32}$/)
    assert.equal(safeEqual(token, token), true)
    assert.equal(safeEqual(token, `${token}x`), false)
    assert.equal(safeEqual(token, 'wrong'), false)
  })

  it('creates and validates an HttpOnly session cookie', () => {
    const token = generateAccessToken()
    const cookie = sessionCookie(token, 'session')
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /SameSite=Strict/)
    const pair = cookie.split(';', 1)[0]
    assert.deepEqual(Object.keys(parseCookies(pair)), ['session'])
    assert.equal(isAuthenticated({ headers: { cookie: pair } }, token, 'session'), true)
    assert.equal(isAuthenticated({ headers: { cookie: pair } }, 'other', 'session'), false)
  })
})

describe('persistence', () => {
  it('round-trips state atomically and rejects invalid input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-reverse-proxy-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'state.json')
    assert.deepEqual(await readState(path), { enabled: false })
    await writeState(path, { enabled: true, accessToken: 'x'.repeat(32) })
    assert.deepEqual(await readState(path), { enabled: true, accessToken: 'x'.repeat(32) })
    assert.equal((await readFile(path, 'utf8')).endsWith('\n'), true)
  })

  it('keeps well-formed listen overrides and drops malformed ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-reverse-proxy-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const path = join(dir, 'state.json')
    await writeState(path, {
      enabled: true,
      accessToken: 'x'.repeat(32),
      listenHost: '0.0.0.0',
      listenPort: 9081,
    })
    assert.deepEqual(await readState(path), {
      enabled: true,
      accessToken: 'x'.repeat(32),
      listenHost: '0.0.0.0',
      listenPort: 9081,
    })
    await writeState(path, {
      enabled: true,
      accessToken: 'x'.repeat(32),
      listenHost: 'bad host',
      listenPort: 99999,
    })
    assert.deepEqual(await readState(path), { enabled: true, accessToken: 'x'.repeat(32) })
  })
})

describe('viewport injection', () => {
  it('adds viewport-fit without adding executable UI assets', () => {
    const html = '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>'
    const out = injectViewport(html)
    assert.match(out, /viewport-fit=cover/)
    assert.doesNotMatch(out, /<script/)
  })
})

describe('header forwarding', () => {
  it('drops spoofable, hop-by-hop, and internal credential fields', () => {
    const headers = forwardHeaders({
      headers: {
        host: 'public.example',
        connection: 'keep-alive',
        forwarded: 'for=attacker',
        'x-forwarded-for': 'attacker',
        'x-real-ip': 'attacker',
        cookie: 'dsh_reverse_proxy_session=secret',
        authorization: 'Bearer ok',
      },
      socket: { remoteAddress: '127.0.0.1' },
    }, '127.0.0.1:3080')
    assert.equal(headers.host, '127.0.0.1:3080')
    assert.equal(headers.authorization, 'Bearer ok')
    assert.equal(headers['x-forwarded-for'], '127.0.0.1')
    assert.equal(headers.forwarded, undefined)
    assert.equal(headers.connection, undefined)
    assert.equal(headers.cookie, undefined)
    assert.equal(headers['x-dsh-reverse-proxy'], '1')
  })
})

describe('authenticated reverse proxy', () => {
  it('gates access, blocks control paths, and forwards authenticated traffic', async () => {
    const backend = createServer((req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'backend_session=should-not-leak; Path=/',
      })
      res.end(JSON.stringify({
        path: req.url,
        host: req.headers.host,
        marker: req.headers['x-dsh-reverse-proxy'],
      }))
    })
    await new Promise((resolve, reject) => {
      backend.once('error', reject)
      backend.listen(0, '127.0.0.1', resolve)
    })
    cleanups.push(() => new Promise(resolve => backend.close(resolve)))
    const backendPort = backend.address().port
    const token = generateAccessToken()
    const logged = []
    const proxy = await listenProxy({
      listenHost: '127.0.0.1',
      listenPort: 0,
      backendHost: '127.0.0.1',
      backendPort,
      accessToken: token,
      cookieName: 'session',
      controlPrefix: '/dsh-reverse-proxy',
      maxRequestBytes: 1024,
      upstreamTimeoutMs: 2000,
      sessionMaxAgeSeconds: 3600,
      maxHeaderSizeBytes: 16384,
      headersTimeoutMs: 2000,
      keepAliveTimeoutMs: 1000,
      loginDelayMs: 0,
      log: entry => { logged.push(entry) },
    })
    cleanups.push(proxy.close)

    const anonymous = await http({ port: proxy.port })
    assert.equal(anonymous.status, 303)
    assert.equal(anonymous.headers.location, '/_dsh_reverse_proxy/login')

    const bad = await http({
      port: proxy.port,
      path: '/_dsh_reverse_proxy/login',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'token=wrong',
    })
    assert.equal(bad.status, 401)

    const login = await http({
      port: proxy.port,
      path: '/_dsh_reverse_proxy/login',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(token)}`,
    })
    assert.equal(login.status, 303)
    assert.match(login.headers['set-cookie'][0], /Max-Age=3600/)
    const cookie = login.headers['set-cookie'][0].split(';', 1)[0]

    const blocked = await http({
      port: proxy.port,
      path: '/dsh-reverse-proxy/status',
      headers: { cookie },
    })
    assert.equal(blocked.status, 403)

    const proxied = await http({
      port: proxy.port,
      path: '/api/example',
      headers: { cookie },
    })
    assert.equal(proxied.status, 200)
    assert.equal(proxied.headers['set-cookie'], undefined)
    assert.deepEqual(JSON.parse(proxied.body), {
      path: '/api/example',
      host: `127.0.0.1:${backendPort}`,
      marker: '1',
    })

    assert.equal(logged.some(e => e.method === 'GET' && e.path === '/api/example' && e.status === 200), true)
    assert.equal(logged.some(e => e.method === 'POST' && e.path === '/_dsh_reverse_proxy/login' && e.status === 401), true)
    assert.equal(logged.some(e => e.method === 'GET' && e.path === '/dsh-reverse-proxy/status' && e.status === 403), true)
  })

  it('enforces the byte limit on chunked uploads that declare no content-length', async () => {
    const backend = createServer((req, res) => {
      req.resume()
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    await new Promise((resolve, reject) => {
      backend.once('error', reject)
      backend.listen(0, '127.0.0.1', resolve)
    })
    cleanups.push(() => new Promise(resolve => backend.close(resolve)))
    const token = generateAccessToken()
    const proxy = await listenProxy({
      listenHost: '127.0.0.1',
      listenPort: 0,
      backendHost: '127.0.0.1',
      backendPort: backend.address().port,
      accessToken: token,
      cookieName: 'session',
      controlPrefix: '/dsh-reverse-proxy',
      maxRequestBytes: 1024,
      upstreamTimeoutMs: 2000,
    })
    cleanups.push(proxy.close)

    const login = await http({
      port: proxy.port,
      path: '/_dsh_reverse_proxy/login',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(token)}`,
    })
    const cookie = login.headers['set-cookie'][0].split(';', 1)[0]

    const over = await chunked({
      port: proxy.port,
      path: '/api/upload',
      headers: { cookie },
      chunks: ['a'.repeat(800), 'b'.repeat(800)],
    })
    assert.equal(over.status, 413)

    const under = await chunked({
      port: proxy.port,
      path: '/api/upload',
      headers: { cookie },
      chunks: ['a'.repeat(200), 'b'.repeat(200)],
    })
    assert.equal(under.status, 200)
  })
})

describe('websocket upgrade', () => {
  /** Backend that completes a raw 101 handshake and echoes every upgraded
   * frame back to the sender (node's bare upgrade event does not answer 101
   * by itself — real WebSocket servers do). Like the harness webServer, it
   * tracks its own upgraded sockets so cleanup can tear them down reliably:
   * destroying the client side of an upgrade does not propagate in Node. */
  async function echoBackend() {
    const upgraded = new Set()
    const backend = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    backend.on('upgrade', (req, socket) => {
      upgraded.add(socket)
      socket.once('close', () => upgraded.delete(socket))
      socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Connection: Upgrade',
        'Upgrade: websocket',
        '',
        '',
      ].join('\r\n'))
      socket.on('data', chunk => { socket.write(chunk) })
    })
    await new Promise((resolve, reject) => {
      backend.once('error', reject)
      backend.listen(0, '127.0.0.1', resolve)
    })
    cleanups.push(() => new Promise(resolve => {
      for (const socket of upgraded) socket.destroy()
      backend.close(resolve)
    }))
    return backend
  }

  async function proxyWithCookie() {
    const backend = await echoBackend()
    const token = generateAccessToken()
    const proxy = await listenProxy({
      listenHost: '127.0.0.1',
      listenPort: 0,
      backendHost: '127.0.0.1',
      backendPort: backend.address().port,
      accessToken: token,
      cookieName: 'session',
      controlPrefix: '/dsh-reverse-proxy',
      maxRequestBytes: 1024,
      upstreamTimeoutMs: 2000,
      loginDelayMs: 0,
    })
    cleanups.push(proxy.close)
    const login = await http({
      port: proxy.port,
      path: '/_dsh_reverse_proxy/login',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(token)}`,
    })
    return { proxy, cookie: login.headers['set-cookie'][0].split(';', 1)[0] }
  }

  it('denies unauthenticated upgrade attempts with 401', async () => {
    const { proxy } = await proxyWithCookie()
    const attempt = await wsHandshake({ port: proxy.port, path: '/ws' })
    attempt.socket.destroy()
    assert.match(attempt.status, /^HTTP\/1\.1 401/)
  })

  it('relays an authenticated upgrade and forwards frames both ways', async () => {
    const { proxy, cookie } = await proxyWithCookie()
    const { socket, status, headers } = await wsHandshake({ port: proxy.port, path: '/ws', cookie })
    cleanups.push(() => socket.destroy())
    assert.match(status, /^HTTP\/1\.1 101/)
    assert.equal(headers.some(line => /^upgrade: websocket$/i.test(line)), true)

    // Masked text frame "hi" (FIN|text, len 2, 4-byte mask).
    const frame = Buffer.from([0x81, 0x82, 0x00, 0x01, 0x02, 0x03, 0x68, 0x6a])
    socket.write(frame)
    const echoed = await readSocket(socket)
    assert.deepEqual(echoed, frame)
  })
})
