import { describe, it } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { brotliCompressSync, brotliDecompressSync, constants, gzipSync, gunzipSync } from 'node:zlib'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listenProxy } from '../src/proxy.ts'
import { createSessionStore } from '../src/sessions.ts'

const asset = '/assets/transport-abcdefgh.js'
const body = Buffer.from('export const transport = "compressible response payload";'.repeat(300))
interface Response {
  status: number | undefined
  headers: IncomingHttpHeaders
  body: Buffer
}

function http(port: number, path: string, headers: Record<string, string> = {}, method = 'GET', payload?: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers, agent: false }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk)))
      res.once('error', reject)
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.once('error', reject)
    req.end(payload)
  })
}

async function fixture(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse, count: number) => void = (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/javascript', 'content-length': body.length, etag: '"backend-version"' })
  res.end(body)
}, options: { cacheHashedAssets?: boolean, compressResponses?: boolean } = {}) {
  const requests = new Map<string, number>()
  const sockets = new Set<Socket>()
  let connections = 0
  const backend = createServer((req, res) => {
    const path = req.url ?? '/'
    const count = (requests.get(path) ?? 0) + 1
    requests.set(path, count)
    handler(req, res, count)
  })
  backend.on('connection', socket => {
    connections++
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    backend.once('error', reject)
    backend.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise<void>(resolve => { backend.closeAllConnections(); backend.close(() => resolve()) }))
  const address = backend.address()
  assert.ok(address && typeof address !== 'string')
  const sessions = createSessionStore()
  const proxy = await listenProxy({
    listenHost: '127.0.0.1', listenPort: 0, backendHost: '127.0.0.1', backendPort: address.port,
    accessToken: 'transport-test-token', cookieName: 'session', controlPrefix: '/dsh-reverse-proxy',
    maxRequestBytes: 1024 * 1024, upstreamTimeoutMs: 2000, loginDelayMs: 0, sessionStore: sessions,
    ...options,
  })
  t.after(proxy.close)
  async function login() {
    const response = await http(proxy.port, '/_dsh_reverse_proxy/login', {
      'content-type': 'application/x-www-form-urlencoded',
    }, 'POST', 'token=transport-test-token')
    assert.equal(response.status, 303)
    const cookie = response.headers['set-cookie']?.[0]?.split(';', 1)[0]
    assert.ok(cookie)
    return cookie
  }
  const cookie = await login()
  const get = (path = asset, headers: Record<string, string> = {}, deviceCookie = cookie) => http(proxy.port, path, { cookie: deviceCookie, ...headers })
  return { proxy, sessions, cookie, login, get, requests, sockets, connections: () => connections }
}

describe('authenticated HTTP transport and static variants', { timeout: 5000 }, () => {
  it('ages cached responses and 304s without extending upstream freshness', async t => {
    const baseline = Math.floor(Date.now() / 1000) * 1000
    let now = baseline
    t.mock.method(Date, 'now', () => now)
    const f = await fixture(t, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'private, max-age=60',
        date: new Date(baseline).toUTCString(), age: '30', etag: '"age-test"' })
      res.end(body)
    })
    await f.get()
    now += 20_000
    const cached = await f.get()
    assert.equal(cached.headers.age, '50')
    assert.equal(f.requests.get(asset), 1)
    const notModified = await f.get(asset, { 'if-none-match': '"age-test"' })
    assert.equal(notModified.status, 304)
    assert.equal(notModified.body.length, 0)
    assert.equal(notModified.headers.age, '50')
    now += 10_001
    await f.get()
    assert.equal(f.requests.get(asset), 2, 'stale variant must be re-fetched')
  })

  it('does not reset a short freshness lifetime after a slow response body', async t => {
    const baseline = Math.floor(Date.now() / 1000) * 1000
    let now = baseline
    t.mock.method(Date, 'now', () => now)
    const f = await fixture(t, (_req, res) => {
      res.sendDate = false
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'max-age=1', etag: '"short"' })
      res.flushHeaders()
      // The test clock moves during body transfer, not before the proxy sees headers.
      setTimeout(() => { now += 2000; res.end(body) }, 20)
    })
    await f.get()
    await f.get()
    assert.equal(f.requests.get(asset), 2, 'expired output cannot be admitted at finish')
  })

  it('streams Brotli and gzip according to q and preserves identity Vary', async t => {
    const f = await fixture(t)
    const br = await f.get('/api/br', { 'accept-encoding': 'gzip, br' })
    assert.equal(br.headers['content-encoding'], 'br')
    assert.deepEqual(brotliDecompressSync(br.body), body)
    assert.ok(br.body.length < body.length)
    console.log('transport fixture raw/br bytes:', body.length, br.body.length)
    assert.equal(br.headers.etag, 'W/"backend-version"')
    const gzip = await f.get('/api/gzip', { 'accept-encoding': 'br;q=0.4, gzip;q=0.8' })
    assert.equal(gzip.headers['content-encoding'], 'gzip')
    assert.deepEqual(gunzipSync(gzip.body), body)
    console.log('transport fixture raw/gzip bytes:', body.length, gzip.body.length)
    const identity = await f.get('/api/identity', { 'accept-encoding': 'br;q=0.4, gzip;q=0.8, identity;q=1' })
    assert.equal(identity.headers['content-encoding'], undefined)
    assert.deepEqual(identity.body, body)
    assert.match(String(identity.headers.vary), /accept-encoding/i)
    assert.equal(identity.headers.etag, '"backend-version"')
    const dist = process.env.DSH_FRONTEND_DIST ?? '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist'
    if (existsSync(join(dist, 'assets'))) {
      const vendor = readdirSync(join(dist, 'assets')).find(name => /^vendor-.*\.js$/.test(name))
      if (vendor !== undefined) {
        const raw = readFileSync(join(dist, 'assets', vendor))
        const gz = gzipSync(raw, { level: 6 })
        const brotli = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })
        assert.deepEqual(gunzipSync(gz), raw)
        assert.deepEqual(brotliDecompressSync(brotli), raw)
        console.log('optional real vendor raw/gzip/br bytes:', vendor, raw.length, gz.length, brotli.length)
      }
    }
  })

  it('honors request/response no-transform and preserves pre-encoded upstream bytes', async t => {
    const encoded = gzipSync(body)
    const f = await fixture(t, (req, res) => {
      const preencoded = req.url === '/api/encoded'
      const output = preencoded ? encoded : body
      res.writeHead(200, {
        'content-type': 'text/javascript', 'content-length': output.length,
        ...(req.url === '/api/no-transform' ? { 'cache-control': 'private, no-transform' } : {}),
        ...(preencoded ? { 'content-encoding': 'gzip' } : {}),
      })
      res.end(output)
    })
    for (const [path, headers] of [
      ['/api/request-no-transform', { 'cache-control': 'no-transform', 'accept-encoding': 'br, gzip' }],
      ['/api/no-transform', { 'accept-encoding': 'br, gzip' }],
    ] as const) {
      const response = await f.get(path, headers)
      assert.equal(response.headers['content-encoding'], undefined)
      assert.deepEqual(response.body, body)
    }
    const response = await f.get('/api/encoded', { 'accept-encoding': 'br, gzip' })
    assert.equal(response.headers['content-encoding'], 'gzip')
    assert.deepEqual(response.body, encoded)
    assert.deepEqual(gunzipSync(response.body), body)
  })

  it('actually hits the same session/encoding cache and answers ETag 304 without a body', async t => {
    const f = await fixture(t, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/javascript', 'content-length': body.length })
      res.end(body)
    })
    const headers = { 'accept-encoding': 'br, gzip' }
    const first = await f.get(asset, headers)
    assert.equal(first.status, 200)
    assert.match(String(first.headers['cache-control']), /^private,/)
    const cached = await f.get(asset, headers)
    assert.equal(f.requests.get(asset), 1, 'second request must not contact backend')
    assert.deepEqual(cached.body, first.body)
    assert.equal(cached.headers['content-encoding'], 'br')
    assert.ok(cached.headers.etag)
    const conditional = await f.get(asset, { ...headers, 'if-none-match': cached.headers.etag })
    assert.equal(conditional.status, 304)
    assert.equal(conditional.body.length, 0)
    assert.equal(conditional.headers.etag, cached.headers.etag)
    assert.match(String(conditional.headers.vary), /accept-encoding/i)
    assert.equal(f.requests.get(asset), 1)
  })

  it('isolates device cookies, encoding variants and full asset queries', async t => {
    const f = await fixture(t)
    const gzipHeaders = { 'accept-encoding': 'gzip' }
    const brHeaders = { 'accept-encoding': 'br' }
    await f.get(asset, gzipHeaders)
    await f.get(asset, gzipHeaders)
    assert.equal(f.requests.get(asset), 1)
    const cookieB = await f.login()
    assert.notEqual(cookieB, f.cookie)
    const b = await f.get(asset, gzipHeaders, cookieB)
    assert.deepEqual(gunzipSync(b.body), body)
    assert.equal(f.requests.get(asset), 2, 'device B cannot reuse A variant')
    await f.get(asset, gzipHeaders, cookieB)
    assert.equal(f.requests.get(asset), 2)
    const br = await f.get(asset, brHeaders)
    assert.deepEqual(brotliDecompressSync(br.body), body)
    assert.equal(f.requests.get(asset), 3, 'new encoding must fetch its own representation')
    await f.get(asset, brHeaders)
    assert.equal(f.requests.get(asset), 3)
    await f.get(asset + '?v=1', gzipHeaders)
    await f.get(asset + '?v=1', gzipHeaders)
    await f.get(asset + '?v=2', gzipHeaders)
    assert.equal(f.requests.get(asset + '?v=1'), 1)
    assert.equal(f.requests.get(asset + '?v=2'), 1)
  })

  it('bypasses filled caches on request no-cache and no-transform', async t => {
    const f = await fixture(t)
    const headers = { 'accept-encoding': 'gzip' }
    await f.get(asset, headers)
    await f.get(asset, headers)
    assert.equal(f.requests.get(asset), 1)
    await f.get(asset, { ...headers, 'cache-control': 'no-cache' })
    assert.equal(f.requests.get(asset), 2)
    const plain = await f.get(asset, { ...headers, 'cache-control': 'no-transform' })
    assert.equal(plain.headers['content-encoding'], undefined)
    assert.deepEqual(plain.body, body)
    assert.equal(f.requests.get(asset), 3)
  })

  it('does not cache no-cache, must-revalidate, Set-Cookie, Vary Origin, API or HTML', async t => {
    const f = await fixture(t, (req, res) => {
      const path = req.url ?? ''
      const extra = path.includes('nocache') ? { 'cache-control': 'no-cache' }
        : path.includes('revalidate') ? { 'cache-control': 'max-age=600, must-revalidate' }
          : path.includes('cookie') ? { 'set-cookie': 'backend=value' }
            : path.includes('origin') ? { vary: 'Origin' } : {}
      res.writeHead(200, { 'content-type': path.includes('html') ? 'text/html' : 'text/javascript', ...extra })
      res.end(body)
    })
    for (const path of ['/assets/nocache-abcdefgh.js', '/assets/revalidate-abcdefgh.js', '/assets/cookie-abcdefgh.js', '/assets/origin-abcdefgh.js', '/api/data', '/index.html', '/assets/html-abcdefgh.js']) {
      const first = await f.get(path, { 'accept-encoding': 'gzip' })
      await f.get(path, { 'accept-encoding': 'gzip' })
      if (path.includes('cookie') || path.includes('html')) {
        assert.equal(first.headers['cache-control'], undefined, 'hash-looking sensitive body must not get generated max-age')
      }
      assert.equal(f.requests.get(path), 2, path + ' must reach backend twice')
    }
    await f.get(asset)
    await f.get(asset)
    assert.equal(f.requests.get(asset), 1, 'control asset proves caching is active')
  })

  it('respects cache-disabled and compression-disabled options independently', async t => {
    const f = await fixture(t, undefined, { cacheHashedAssets: false })
    const first = await f.get(asset, { 'accept-encoding': 'br' })
    await f.get(asset, { 'accept-encoding': 'br' })
    assert.equal(first.headers['content-encoding'], 'br')
    assert.equal(first.headers['cache-control'], undefined)
    assert.equal(f.requests.get(asset), 2)
    const plain = await fixture(t, undefined, { compressResponses: false })
    const response = await plain.get(asset, { 'accept-encoding': 'br, gzip' })
    await plain.get(asset, { 'accept-encoding': 'br, gzip' })
    assert.equal(response.headers['content-encoding'], undefined)
    assert.deepEqual(response.body, body)
    assert.equal(plain.requests.get(asset), 1, 'identity can still be statically cached')
  })

  it('authorizes before cache hits and redirects a revoked session instead of serving its variant', async t => {
    const f = await fixture(t)
    await f.get()
    await f.get()
    assert.equal(f.requests.get(asset), 1)
    const [device] = f.sessions.list()
    assert.ok(device)
    assert.equal(f.sessions.revoke(device.id), true)
    const revoked = await f.get()
    assert.equal(revoked.status, 303)
    assert.equal(revoked.headers.location, '/_dsh_reverse_proxy/login')
    assert.equal(f.requests.get(asset), 1)
    const anonymous = await http(f.proxy.port, asset)
    assert.equal(anonymous.status, 303)
    assert.equal(f.requests.get(asset), 1)
  })

  it('closeSession invalidates cached variants without revoking the device', async t => {
    const f = await fixture(t)
    await f.get()
    await f.get()
    assert.equal(f.requests.get(asset), 1)
    const [device] = f.sessions.list()
    f.proxy.closeSession(device.id)
    const response = await f.get()
    assert.equal(response.status, 200)
    assert.equal(f.requests.get(asset), 2)
    await f.get()
    assert.equal(f.requests.get(asset), 2)
  })

  it('does not cache an aborted static output, but caches a later complete retry', async t => {
    let firstComplete: () => void = () => {}
    const closed = new Promise<void>(resolve => { firstComplete = resolve })
    const f = await fixture(t, (_req, res, count) => {
      res.writeHead(200, { 'content-type': 'text/javascript', 'content-length': body.length })
      if (count !== 1) { res.end(body); return }
      res.once('close', firstComplete)
      res.write(body.subarray(0, 4096))
      const timer = setTimeout(() => res.end(body.subarray(4096)), 30)
      res.once('close', () => clearTimeout(timer))
    })
    await new Promise<void>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: f.proxy.port, path: asset, headers: { cookie: f.cookie }, agent: false }, res => {
        res.once('data', () => { res.destroy(); resolve() })
        res.once('error', reject)
      })
      req.once('error', reject)
      req.end()
    })
    await closed
    const retry = await f.get()
    assert.deepEqual(retry.body, body)
    assert.equal(f.requests.get(asset), 2, 'abort must not produce a retained partial response')
    await f.get()
    assert.equal(f.requests.get(asset), 2, 'complete retry should become a cache hit')
  })

  it('preserves 206 range bytes and never substitutes or retains a full cached representation', async t => {
    const f = await fixture(t, (req, res) => {
      if (req.headers.range) {
        res.writeHead(206, { 'content-type': 'text/javascript', 'content-range': 'bytes 0-4095/' + body.length, 'content-length': 4096 })
        res.end(body.subarray(0, 4096))
      } else {
        res.writeHead(200, { 'content-type': 'text/javascript' })
        res.end(body)
      }
    })
    await f.get(asset, { 'accept-encoding': 'br' })
    await f.get(asset, { 'accept-encoding': 'br' })
    assert.equal(f.requests.get(asset), 1)
    for (let i = 0; i < 2; i++) {
      const partial = await f.get(asset, { 'accept-encoding': 'br', range: 'bytes=0-4095' })
      assert.equal(partial.status, 206)
      assert.equal(partial.headers['content-encoding'], undefined)
      assert.equal(partial.headers['content-range'], 'bytes 0-4095/' + body.length)
      assert.deepEqual(partial.body, body.subarray(0, 4096))
    }
    assert.equal(f.requests.get(asset), 3)
  })

  it('reuses the owned upstream keep-alive pool across separate clients and destroys idle sockets on close', async t => {
    const f = await fixture(t)
    await f.get('/api/pool-one')
    await f.get('/api/pool-two')
    assert.equal(f.connections(), 1, 'two independent downstream sockets must share one upstream connection')
    assert.equal(f.sockets.size, 1)
    const backendClosed = Promise.all([...f.sockets].map(socket => new Promise<void>(resolve => socket.once('close', () => resolve()))))
    await f.proxy.close()
    await backendClosed
    assert.equal(f.sockets.size, 0, 'proxy close must destroy its owned idle upstream sockets')
  })
})
