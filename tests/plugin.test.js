import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { createConnection } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { injectIndexEnhancements, injectViewport } from '../src/index.js'
import { readState, writeState } from '../src/persist.js'
import { forwardHeaders, listenProxy } from '../src/proxy.js'
import { formatAuthority, formatHttpUrl, isSelfLoop, isWildcardHost, publishHost, rewriteLoopbackAuthority } from '../src/http-util.js'
import { generateAccessToken, safeEqual } from '../src/security.js'
import { createSessionStore, encodeSessionCookie, hashSessionSecret, newSessionId, newSessionSecret } from '../src/sessions.js'

const cleanups = []
afterEach(async () => {
  // Sequential reverse order: disposers may write state files, so a parallel
  // rm would race them.
  for (const fn of cleanups.splice(0).reverse()) await fn()
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

  it('issues independent per-device session cookies that revoke cleanly', () => {
    const store = createSessionStore({ maxAgeSeconds: 3600 })
    const first = store.login({ userAgent: 'Mozilla/5.0 (Macintosh) Chrome/126' })
    const second = store.login({ userAgent: 'Mozilla/5.0 (iPhone) Safari/604' })
    const cookieA = encodeSessionCookie(first.id, first.secret)
    const cookieB = encodeSessionCookie(second.id, second.secret)
    // Both devices authenticate independently.
    assert.equal(store.validate(cookieA)?.id, first.id)
    assert.equal(store.validate(cookieB)?.id, second.id)
    // Tampering with the secret or reusing another device's secret fails.
    assert.equal(store.validate(encodeSessionCookie(first.id, 'x'.repeat(32))), undefined)
    assert.equal(store.validate(encodeSessionCookie(first.id, second.secret)), undefined)
    // Kicking device A leaves device B untouched.
    assert.equal(store.revoke(first.id), true)
    assert.equal(store.validate(cookieA), undefined)
    assert.equal(store.validate(cookieB)?.id, second.id)
    // Labels are derived from the User-Agent.
    assert.equal(first.label, 'Chrome on macOS')
    assert.equal(second.label, 'Safari on iOS')
    // Secrets are hashed at rest: the serialized form never carries them.
    for (const record of store.serialize()) {
      assert.equal(record.secretHash.length, 43)
      assert.equal('secret' in record, false)
    }
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

describe('index enhancements', () => {
  const INDEX = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>DeepSeek Harness</title></head><body><div id="root"></div></body></html>'

  it('injects the viewport upgrade and the guarded randomUUID polyfill', () => {
    const out = injectIndexEnhancements(INDEX)
    assert.match(out, /viewport-fit=cover/)
    assert.match(out, /<script data-plugin="dsh-reverse-proxy">/)
    assert.match(out, /globalThis\.crypto/)
    assert.match(out, /getRandomValues/)
  })

  it('places the polyfill exactly once, directly after <head>', () => {
    const out = injectIndexEnhancements(INDEX)
    const matches = out.match(/data-plugin="dsh-reverse-proxy"/g) ?? []
    assert.strictEqual(matches.length, 1)
    assert.match(out, /<head><script data-plugin="dsh-reverse-proxy">/)
  })

  it('is idempotent: a second pass does not inject another script', () => {
    const twice = injectIndexEnhancements(injectIndexEnhancements(INDEX))
    const matches = twice.match(/data-plugin="dsh-reverse-proxy"/g) ?? []
    assert.strictEqual(matches.length, 1)
  })

  it('degrades on HTML without <head>', () => {
    const out = injectIndexEnhancements('<html><body>bare</body></html>')
    assert.doesNotMatch(out, /<script/)
    assert.match(out, /<html>/)
  })

  it('polyfill guard never assumes a secure context', () => {
    // The shim must check typeof randomUUID — the guard text itself is the
    // contract for insecure-context browsers.
    const out = injectIndexEnhancements(INDEX)
    assert.match(out, /typeof c\.randomUUID!=="function"/)
    assert.match(out, /AbortSignal/)
    assert.match(out, /AS\.any/)
    assert.match(out, /__DSH_FULL_REMOTE_TRUSTED__/)
    assert.match(out, /__ModuleLoader__/)
    assert.match(out, /@deepseek-ai\/dsh-client-connection/)
  })
})

describe('real index fixture', () => {
  it('upgrades the viewport and injects the polyfill into the harness dist index without touching assets', async () => {
    const html = await import('node:fs/promises').then(fs => fs.readFile(new URL('./fixtures/dsh-dist-index.html', import.meta.url), 'utf8'))
    const out = injectIndexEnhancements(html)
    assert.match(out, /viewport-fit=cover/)
    assert.match(out, /<head><script data-plugin="dsh-reverse-proxy">/)
    // Every original asset link and the module entry survive verbatim.
    for (const line of ['index-Dqw48FrP.js', 'vendor-Cjbwl5VI.js', 'index-CSGf6Qzd.css', 'manifest.webmanifest']) {
      assert.equal(out.includes(line), true, `missing ${line}`)
    }
    assert.equal((out.match(/data-plugin="dsh-reverse-proxy"/g) ?? []).length, 1)
  })
})

describe('bundle patch', () => {
  it('disables the native directory picker and pins the in-app browse pair', async () => {
    const yaml = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    assert.match(yaml, /id: directory-picker\n {2}disabled: true/)
    assert.match(yaml, /id: directory-picker-browse\n {6}name: '@deepseek-ai\/dsh-host-directory-picker-browse'/)
    assert.match(yaml, /id: ui-directory-picker-browse\n {6}name: '@deepseek-ai\/dsh-client-ui-directory-picker-browse'/)
    assert.match(yaml, /id: reverse-proxy\n {6}name: dsh-full-remote/)
  })
})

describe('listen address formatting', () => {
  it('brackets IPv6 so the result is a legal URL authority', () => {
    assert.equal(formatAuthority('::', 62475), '[::]:62475')
    assert.equal(formatAuthority('::1', 3081), '[::1]:3081')
    assert.equal(formatAuthority('[::1]', 3081), '[::1]:3081')
    assert.equal(formatAuthority('127.0.0.1', 3081), '127.0.0.1:3081')
    assert.equal(formatHttpUrl('::', 80), 'http://[::]:80')
    assert.doesNotMatch(formatHttpUrl('::', 62475), /http:\/\/:::/)
    new URL(formatHttpUrl('::1', 3081))
  })

  it('treats 0.0.0.0 and :: as wildcards, not destinations', () => {
    assert.equal(isWildcardHost('0.0.0.0'), true)
    assert.equal(isWildcardHost('::'), true)
    assert.equal(isWildcardHost('[::]'), true)
    assert.equal(isWildcardHost('127.0.0.1'), false)
    assert.equal(isWildcardHost('192.168.1.5'), false)
    assert.notEqual(publishHost('0.0.0.0'), '0.0.0.0')
    new URL(formatHttpUrl(publishHost('0.0.0.0'), 3081))
  })

  it('detects self-loop on wildcard listen at the backend port', () => {
    assert.equal(isSelfLoop('127.0.0.1', 3080, '127.0.0.1', 3080), true)
    assert.equal(isSelfLoop('0.0.0.0', 3080, '127.0.0.1', 3080), true)
    assert.equal(isSelfLoop('::', 3080, '127.0.0.1', 3080), true)
    assert.equal(isSelfLoop('localhost', 3080, '127.0.0.1', 3080), true)
    assert.equal(isSelfLoop('127.0.0.1', 3081, '127.0.0.1', 3080), false)
    assert.equal(isSelfLoop('192.168.1.5', 3080, '127.0.0.1', 3080), false)
  })

  it('rewrites Host/Origin to a loopback literal independent of backendHost', () => {
    assert.equal(rewriteLoopbackAuthority(62468), '127.0.0.1:62468')
    const headers = forwardHeaders({
      headers: { host: 'public.example', origin: 'http://public.example' },
      socket: { remoteAddress: '10.0.0.8' },
    }, rewriteLoopbackAuthority(62468))
    assert.equal(headers.host, '127.0.0.1:62468')
    assert.equal(headers.origin, 'http://127.0.0.1:62468')
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

    const health = await http({ port: proxy.port, path: '/_dsh_reverse_proxy/healthz' })
    assert.equal(health.status, 200)
    assert.deepEqual(JSON.parse(health.body), { ok: true })

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

  it('rewrites Host to loopback when backendHost is the 0.0.0.0 wildcard', async () => {
    const seen = []
    const backend = createServer((req, res) => {
      seen.push({ host: req.headers.host, origin: req.headers.origin })
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    await new Promise((resolve, reject) => {
      backend.once('error', reject)
      backend.listen(0, '127.0.0.1', resolve)
    })
    cleanups.push(() => new Promise(resolve => backend.close(resolve)))
    const backendPort = backend.address().port
    const token = generateAccessToken()
    const proxy = await listenProxy({
      listenHost: '127.0.0.1',
      listenPort: 0,
      backendHost: '0.0.0.0',
      backendPort,
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
    const cookie = login.headers['set-cookie'][0].split(';', 1)[0]
    const proxied = await http({ port: proxy.port, path: '/api/example', headers: { cookie } })
    assert.equal(proxied.status, 200)
    assert.equal(seen[0].host, `127.0.0.1:${backendPort}`)
    assert.equal(seen[0].origin, `http://127.0.0.1:${backendPort}`)
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

describe('device sessions', () => {
  async function proxyWith(storeOptions = {}, spec = {}) {
    const backend = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    await new Promise((resolve, reject) => {
      backend.once('error', reject)
      backend.listen(0, '127.0.0.1', resolve)
    })
    cleanups.push(() => new Promise(resolve => backend.close(resolve)))
    const sessionStore = createSessionStore(storeOptions)
    const proxy = await listenProxy({
      listenHost: '127.0.0.1',
      listenPort: 0,
      backendHost: '127.0.0.1',
      backendPort: backend.address().port,
      accessToken: 'correct-token',
      cookieName: 'session',
      controlPrefix: '/dsh-reverse-proxy',
      maxRequestBytes: 4096,
      upstreamTimeoutMs: 2000,
      loginDelayMs: 0,
      sessionStore,
      ...spec,
    })
    cleanups.push(proxy.close)
    return { proxy, sessionStore }
  }

  const login = (port, token = 'correct-token', headers = {}) => http({
    port,
    path: '/_dsh_reverse_proxy/login',
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: `token=${encodeURIComponent(token)}`,
  })

  const cookieOf = (response) => response.headers['set-cookie'][0].split(';', 1)[0]

  it('issues a per-device session on login that revocation kills immediately', async () => {
    const { proxy, sessionStore } = await proxyWith()
    const good = await login(proxy.port)
    assert.equal(good.status, 303)
    assert.equal(good.headers.location, '/')
    const cookie = cookieOf(good)

    const authed = await http({ port: proxy.port, headers: { cookie } })
    assert.equal(authed.status, 200)

    const [device] = sessionStore.list()
    assert.equal(device.status, 'active')
    assert.equal(sessionStore.revoke(device.id), true)
    const afterKick = await http({ port: proxy.port, headers: { cookie } })
    assert.equal(afterKick.status, 303)
    assert.equal(afterKick.headers.location, '/_dsh_reverse_proxy/login')
  })

  it('holds new devices on the wait page until approved, then admits them', async () => {
    const { proxy, sessionStore } = await proxyWith({ approvalRequired: true })
    const loginRes = await login(proxy.port, 'correct-token', { 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/126' })
    assert.equal(loginRes.status, 303)
    assert.match(loginRes.headers.location, /^\/_dsh_reverse_proxy\/wait\//)
    const waitPath = loginRes.headers.location
    const cookie = cookieOf(loginRes)

    // Pending cookie is rejected by the auth gate.
    const blocked = await http({ port: proxy.port, headers: { cookie } })
    assert.equal(blocked.status, 303)

    // The wait page renders with the device label and a poll endpoint.
    const page = await http({ port: proxy.port, path: waitPath, headers: { cookie } })
    assert.equal(page.status, 200)
    assert.match(page.body, /Chrome on macOS/)
    assert.match(page.body, /等待审批/)

    const status = await http({ port: proxy.port, path: `${waitPath}/status`, headers: { cookie } })
    assert.deepEqual(JSON.parse(status.body), { status: 'pending' })

    const [device] = sessionStore.list()
    assert.equal(device.status, 'pending')
    assert.equal(sessionStore.approve(device.id), true)

    const approved = await http({ port: proxy.port, path: `${waitPath}/status`, headers: { cookie } })
    assert.deepEqual(JSON.parse(approved.body), { status: 'active' })
    const admitted = await http({ port: proxy.port, headers: { cookie } })
    assert.equal(admitted.status, 200)
  })

  it('keeps rejected devices out and answers unknown wait ids with a login redirect', async () => {
    const { proxy, sessionStore } = await proxyWith({ approvalRequired: true })
    const loginRes = await login(proxy.port)
    const waitPath = loginRes.headers.location
    const cookie = cookieOf(loginRes)
    const [device] = sessionStore.list()
    sessionStore.revoke(device.id)
    const status = await http({ port: proxy.port, path: `${waitPath}/status`, headers: { cookie } })
    assert.deepEqual(JSON.parse(status.body), { status: 'unknown' })
    const unknown = await http({ port: proxy.port, path: '/_dsh_reverse_proxy/wait/not-a-session', headers: { cookie } })
    assert.equal(unknown.status, 303)
    assert.equal(unknown.headers.location, '/_dsh_reverse_proxy/login')
  })

  it('escapes hostile labels from the persisted state file on the wait page', async () => {
    // deviceLabel() only emits whitelisted text, but hydrate() accepts any
    // label string — a hand-edited state file is the real injection vector.
    const sessionStore = createSessionStore({ approvalRequired: true })
    const now = Date.now()
    const id = newSessionId()
    const secret = newSessionSecret()
    sessionStore.hydrate([{
      id,
      secretHash: hashSessionSecret(secret),
      label: '<img src=x onerror=alert(1)>',
      status: 'pending',
      createdAt: now,
      lastSeenAt: now,
    }])
    const { proxy } = await proxyWith({ approvalRequired: true }, { sessionStore })
    const cookie = `session=${encodeSessionCookie(id, secret)}`
    const page = await http({ port: proxy.port, path: `/_dsh_reverse_proxy/wait/${id}`, headers: { cookie } })
    assert.equal(page.body.includes('<img src=x'), false)
    assert.equal(page.body.includes('&lt;img src=x onerror=alert(1)&gt;'), true)
  })
})

describe('login rate limiting', () => {
  const badLogin = (port, token = 'wrong') => http({
    port,
    path: '/_dsh_reverse_proxy/login',
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `token=${encodeURIComponent(token)}`,
  })

  async function proxyWith(overrides = {}) {
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
    const proxy = await listenProxy({
      listenHost: '127.0.0.1',
      listenPort: 0,
      backendHost: '127.0.0.1',
      backendPort: backend.address().port,
      accessToken: 'correct-token',
      cookieName: 'session',
      controlPrefix: '/dsh-reverse-proxy',
      maxRequestBytes: 4096,
      upstreamTimeoutMs: 2000,
      loginDelayMs: 0,
      loginMaxAttempts: 3,
      loginLockoutMs: 60_000,
      ...overrides,
    })
    cleanups.push(proxy.close)
    return proxy
  }

  it('locks an IP out after repeated failures and answers 429 with Retry-After', async () => {
    const proxy = await proxyWith()
    for (let i = 0; i < 3; i++) {
      const attempt = await badLogin(proxy.port)
      assert.equal(attempt.status, 401)
    }
    const locked = await badLogin(proxy.port)
    assert.equal(locked.status, 429)
    assert.equal(Number(locked.headers['retry-after']) > 0, true)
    assert.equal(locked.headers['cache-control'], 'no-store')
  })

  it('keeps the lockout even for the correct token while the window is active', async () => {
    const proxy = await proxyWith()
    for (let i = 0; i < 3; i++) await badLogin(proxy.port)
    const correct = await badLogin(proxy.port, 'correct-token')
    assert.equal(correct.status, 429)
  })

  it('clears the bucket on a successful login, so a later single failure is not locked', async () => {
    const proxy = await proxyWith({ loginMaxAttempts: 2 })
    assert.equal((await badLogin(proxy.port)).status, 401)
    const success = await badLogin(proxy.port, 'correct-token')
    assert.equal(success.status, 303)
    // Bucket reset: one more failure is attempt #1, not the locking #2.
    assert.equal((await badLogin(proxy.port)).status, 401)
    assert.equal((await badLogin(proxy.port, 'correct-token')).status, 303)
  })

  it('expires the lockout after the configured window', async () => {
    const proxy = await proxyWith({ loginLockoutMs: 40 })
    for (let i = 0; i < 3; i++) await badLogin(proxy.port)
    assert.equal((await badLogin(proxy.port)).status, 429)
    await new Promise(resolve => setTimeout(resolve, 80))
    const next = await badLogin(proxy.port)
    assert.notEqual(next.status, 429)
  })

  it('serves the login gate in English for English Accept-Language headers', async () => {
    const proxy = await proxyWith()
    const en = await http({
      port: proxy.port,
      path: '/_dsh_reverse_proxy/login',
      headers: { 'accept-language': 'en-US,en;q=0.9' },
    })
    assert.equal(en.status, 200)
    assert.match(en.body, /Enter DeepSeek Harness/)
    assert.doesNotMatch(en.body, /远程访问/)
    const zh = await http({ port: proxy.port, path: '/_dsh_reverse_proxy/login' })
    assert.match(zh.body, /远程访问/)
  })
})

describe('websocket upgrade', () => {
  /** Backend that completes a raw 101 handshake and echoes every upgraded
   * frame back to the sender (node's bare upgrade event does not answer 101
   * by itself — real WebSocket servers do). Like the harness webServer, it
   * tracks its own upgraded sockets so cleanup can tear them down reliably. */
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

  it('propagates FIN to the backend socket when the proxy closes an upgraded session', async () => {
    const backend = await echoBackend()
    let backendEnded = false
    const realUpgrade = backend.listeners('upgrade')[0]
    backend.removeAllListeners('upgrade')
    backend.on('upgrade', (req, socket) => {
      realUpgrade(req, socket)
      socket.once('end', () => { backendEnded = true })
    })
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
    const cookie = login.headers['set-cookie'][0].split(';', 1)[0]
    const { socket } = await wsHandshake({ port: proxy.port, path: '/ws', cookie })
    cleanups.push(() => socket.destroy())

    await proxy.close()
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(backendEnded, true)
  })
})

describe('proxy teardown', () => {
  it('close() returns while a proxied response is still streaming', async () => {
    const backend = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('partial')
    })
    await new Promise((resolve, reject) => {
      backend.once('error', reject)
      backend.listen(0, '127.0.0.1', resolve)
    })
    cleanups.push(() => new Promise(resolve => {
      backend.closeAllConnections?.()
      backend.close(resolve)
    }))
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
    const login = await http({
      port: proxy.port,
      path: '/_dsh_reverse_proxy/login',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(token)}`,
    })
    const cookie = login.headers['set-cookie'][0].split(';', 1)[0]
    const pending = request({
      hostname: '127.0.0.1',
      port: proxy.port,
      path: '/stream',
      headers: { cookie },
    })
    pending.end()
    await new Promise((resolve, reject) => {
      pending.once('response', resolve)
      pending.once('error', reject)
    })
    await Promise.race([
      proxy.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('proxy.close hung')), 3000)),
    ])
  })
})
