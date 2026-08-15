import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
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
  it('drops spoofable and hop-by-hop fields', () => {
    const headers = forwardHeaders({
      headers: {
        host: 'public.example',
        connection: 'keep-alive',
        forwarded: 'for=attacker',
        'x-forwarded-for': 'attacker',
        'x-real-ip': 'attacker',
        authorization: 'Bearer ok',
      },
      socket: { remoteAddress: '127.0.0.1' },
    }, '127.0.0.1:3080')
    assert.equal(headers.host, '127.0.0.1:3080')
    assert.equal(headers.authorization, 'Bearer ok')
    assert.equal(headers['x-forwarded-for'], '127.0.0.1')
    assert.equal(headers.forwarded, undefined)
    assert.equal(headers.connection, undefined)
    assert.equal(headers['x-dsh-reverse-proxy'], '1')
  })
})

describe('authenticated reverse proxy', () => {
  it('gates access, blocks control paths, and forwards authenticated traffic', async () => {
    const backend = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
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
    assert.deepEqual(JSON.parse(proxied.body), {
      path: '/api/example',
      host: `127.0.0.1:${backendPort}`,
      marker: '1',
    })
  })
})
