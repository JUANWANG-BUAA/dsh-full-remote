import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { listenProxy } from '../src/proxy.ts'
import { generateAccessToken } from '../src/security.ts'
import {
  MIN_GZIP_BODY_BYTES,
  acceptsGzip,
  encodingQ,
  isCompressibleMediaType,
  isHashedStaticAssetPath,
  maybeSetHashedAssetCacheControl,
  shouldGzipResponse,
} from '../src/proxy-compress.ts'

interface RawResponse {
  status: number | undefined
  headers: IncomingHttpHeaders
  body: Buffer
}

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

function portOf(server: Server): number {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP bind')
  return address.port
}

function httpRaw(options: {
  port: number
  path?: string
  method?: string
  headers?: Record<string, string>
  body?: string
}): Promise<RawResponse> {
  const { port, path = '/', method = 'GET', headers = {}, body } = options
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers }, (res: IncomingMessage) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }))
    })
    req.on('error', reject)
    if (body !== undefined) req.end(body)
    else req.end()
  })
}

function ratio(raw: number, compressed: number) {
  return raw === 0 ? 0 : 1 - compressed / raw
}

function formatPct(value: number) {
  return `${(value * 100).toFixed(1)}%`
}

async function startBackend(handler: (req: IncomingMessage, res: import('node:http').ServerResponse) => void) {
  const backend = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    backend.once('error', reject)
    backend.listen(0, '127.0.0.1', resolve)
  })
  cleanups.push(() => new Promise<void>(resolve => {
    backend.closeAllConnections?.()
    backend.close(() => resolve())
  }))
  return backend
}

async function startProxy(backend: Server, extra: { compressResponses?: boolean, cacheHashedAssets?: boolean } = {}) {
  const token = generateAccessToken()
  const proxy = await listenProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    backendHost: '127.0.0.1',
    backendPort: portOf(backend),
    accessToken: token,
    cookieName: 'session',
    controlPrefix: '/dsh-reverse-proxy',
    maxRequestBytes: 16 * 1024 * 1024,
    upstreamTimeoutMs: 2_000,
    loginDelayMs: 0,
    compressResponses: extra.compressResponses,
    cacheHashedAssets: extra.cacheHashedAssets,
  })
  cleanups.push(proxy.close)
  const login = await httpRaw({
    port: proxy.port,
    path: '/_dsh_reverse_proxy/login',
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `token=${encodeURIComponent(token)}`,
  })
  assert.equal(login.status, 303)
  const cookie = String(login.headers['set-cookie']![0]).split(';', 1)[0]
  return { proxy, cookie }
}

function findFrontendDist(): string | undefined {
  const env = process.env.DSH_WEB_FRONTEND_DIST
  const candidates = [
    env,
    '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist',
  ]
  for (const dir of candidates) {
    if (dir !== undefined && existsSync(join(dir, 'assets'))) return dir
  }
  return undefined
}

describe('gzip / cache decision predicates', () => {
  it('parses Accept-Encoding q-values', () => {
    assert.equal(acceptsGzip(undefined), false)
    assert.equal(acceptsGzip('gzip'), true)
    assert.equal(acceptsGzip('gzip, deflate, br'), true)
    assert.equal(acceptsGzip('gzip;q=0, br'), false)
    assert.equal(encodingQ('br, gzip;q=0.5', 'gzip'), 0.5)
    assert.equal(acceptsGzip('*'), true)
    assert.equal(acceptsGzip('br'), false)
  })

  it('classifies compressible media types', () => {
    assert.equal(isCompressibleMediaType('application/json; charset=utf-8'), true)
    assert.equal(isCompressibleMediaType('text/javascript; charset=utf-8'), true)
    assert.equal(isCompressibleMediaType('text/event-stream'), false)
    assert.equal(isCompressibleMediaType('font/woff2'), false)
    assert.equal(isCompressibleMediaType('application/octet-stream'), false)
    assert.equal(isCompressibleMediaType('image/svg+xml'), true)
    assert.equal(isCompressibleMediaType('image/png'), false)
    assert.equal(isCompressibleMediaType('image/jpeg'), false)
    assert.equal(isCompressibleMediaType('image/webp'), false)
    assert.equal(isCompressibleMediaType('image/gif'), false)
  })

  it('skips tiny, encoded, HEAD, and SSE bodies', () => {
    const base = {
      compressEnabled: true,
      method: 'GET',
      status: 200,
      acceptEncoding: 'gzip',
      contentType: 'application/json',
    }
    assert.equal(shouldGzipResponse({ ...base, contentLength: String(MIN_GZIP_BODY_BYTES - 1) }), false)
    assert.equal(shouldGzipResponse({ ...base, contentLength: String(MIN_GZIP_BODY_BYTES) }), true)
    assert.equal(shouldGzipResponse({ ...base, contentEncoding: 'gzip' }), false)
    assert.equal(shouldGzipResponse({ ...base, method: 'HEAD', contentLength: '4096' }), false)
    assert.equal(shouldGzipResponse({ ...base, contentType: 'text/event-stream', contentLength: '4096' }), false)
    assert.equal(shouldGzipResponse({ ...base, compressEnabled: false, contentLength: '4096' }), false)
    assert.equal(shouldGzipResponse({ ...base, status: 204, contentLength: '4096' }), false)
  })

  it('recognizes Vite hashed /assets paths and ignores HTML shells', () => {
    assert.equal(isHashedStaticAssetPath('/assets/vendor-Cjbwl5VI.js'), true)
    assert.equal(isHashedStaticAssetPath('/assets/index-Dqw48FrP.js'), true)
    assert.equal(isHashedStaticAssetPath('/assets/langs/cpp-DIPi6g--.js'), true)
    assert.equal(isHashedStaticAssetPath('/assets/fonts/KaTeX_AMS-Regular-BQhdFMY1.woff2'), true)
    assert.equal(isHashedStaticAssetPath('/assets/preview-desktop.png'), false)
    assert.equal(isHashedStaticAssetPath('/index.html'), false)
    assert.equal(isHashedStaticAssetPath('/api/session.list'), false)
    assert.equal(isHashedStaticAssetPath('/favicon.svg'), false)
  })

  it('adds immutable cache only on hashed 200s without an upstream cache header', () => {
    const headers: Record<string, string | string[] | number | undefined> = { 'content-type': 'text/javascript' }
    maybeSetHashedAssetCacheControl(headers, '/assets/vendor-Cjbwl5VI.js', 200, true)
    assert.equal(headers['cache-control'], 'public, max-age=31536000, immutable')
    const kept = { 'cache-control': 'no-store' }
    maybeSetHashedAssetCacheControl(kept, '/assets/vendor-Cjbwl5VI.js', 200, true)
    assert.equal(kept['cache-control'], 'no-store')
    const miss: Record<string, string | undefined> = {}
    maybeSetHashedAssetCacheControl(miss, '/assets/vendor-Cjbwl5VI.js', 404, true)
    assert.equal(miss['cache-control'], undefined)
  })
})

describe('gzip measurements (fixtures, not issue claims)', () => {
  it('records that gzip grows tiny JSON, which is why the 1 KB floor exists', () => {
    const tiny = Buffer.from('{"ok":true}\n')
    const gz = gzipSync(tiny, { level: 6 })
    const saved = ratio(tiny.length, gz.length)
    console.log(`gzip tiny JSON ${tiny.length} -> ${gz.length} (${formatPct(saved)} saved)`)
    assert.ok(gz.length > tiny.length, 'tiny JSON must not be advertised as a gzip win')
    assert.equal(shouldGzipResponse({
      compressEnabled: true,
      acceptEncoding: 'gzip',
      contentType: 'application/json',
      contentLength: String(tiny.length),
    }), false)
  })

  it('records gzipSync ratios for representative bodies', () => {
    const rows: Array<{ name: string, raw: number, gzip: number, saved: number }> = []
    const jsonListing = Buffer.from(JSON.stringify({
      entries: Array.from({ length: 80 }, (_, i) => ({
        name: `file-${i}.ts`,
        path: `/Users/demo/project/src/file-${i}.ts`,
        type: i % 5 === 0 ? 'dir' : 'file',
      })),
    }))
    const js = Buffer.from(Array.from({ length: 400 }, (_, i) => (
      `export function handle${i}(input){return input.map(x=>x+${i}).filter(Boolean).join(",")}`
    )).join(';\n'))
    const loginish = Buffer.from('<!doctype html><html><head><style>body{margin:0}button{width:100%}</style></head><body><main>login</main></body></html>'.repeat(8))
    const noise = randomBytes(4096)

    for (const [name, buf] of [
      ['json-listing-80', jsonListing],
      ['js-export-400', js],
      ['html-repeated', loginish],
      ['incompressible-4k', noise],
    ] as const) {
      const gz = gzipSync(buf, { level: 6 })
      rows.push({ name, raw: buf.length, gzip: gz.length, saved: ratio(buf.length, gz.length) })
    }

    const dist = findFrontendDist()
    if (dist !== undefined) {
      const assets = join(dist, 'assets')
      const vendor = readdirSync(assets).find(name => name.startsWith('vendor-') && name.endsWith('.js'))
      const indexJs = readdirSync(assets).find(name => name.startsWith('index-') && name.endsWith('.js'))
      for (const file of [vendor, indexJs]) {
        if (file === undefined) continue
        const buf = readFileSync(join(assets, file))
        const gz = gzipSync(buf, { level: 6 })
        rows.push({ name: `dist:${file}`, raw: buf.length, gzip: gz.length, saved: ratio(buf.length, gz.length) })
      }
    } else {
      console.log('dsh-web-frontend dist not found; skipping real-bundle gzipSync rows')
    }

    console.log('gzipSync measurements (level 6)')
    for (const row of rows) {
      console.log(`  ${row.name}\t${row.raw}\t${row.gzip}\t${formatPct(row.saved)}`)
    }

    const jsRow = rows.find(row => row.name === 'js-export-400')
    assert.ok(jsRow !== undefined)
    if (jsRow.saved < 0.10) {
      assert.fail(`JS fixture gzip saved only ${formatPct(jsRow.saved)}; default-on gzip would be self-deception`)
    }
    const noiseRow = rows.find(row => row.name === 'incompressible-4k')
    assert.ok(noiseRow !== undefined)
    assert.ok(
      noiseRow.saved < 0.05,
      `random bytes saved ${formatPct(noiseRow.saved)}; gzip must not be applied to binary/fonts`,
    )
    assert.ok(loginish.length < MIN_GZIP_BODY_BYTES)
    assert.equal(shouldGzipResponse({
      compressEnabled: true,
      acceptEncoding: 'gzip',
      contentType: 'text/html',
      contentLength: String(loginish.length),
    }), false)
    const tinyClaim = rows.filter(row => row.name !== 'html-repeated').every(row => row.saved >= 0.95)
    assert.equal(tinyClaim, false, 'must not treat 95% as a universal gzip result')
  })
})

describe('authenticated proxy gzip and hashed-asset cache', () => {
  it('gzips a large JS body, gunzips to the original, and beats the 10% floor', async () => {
    const raw = Buffer.from(Array.from({ length: 400 }, (_, i) => (
      `export function handle${i}(input){return input.map(x=>x+${i}).filter(Boolean).join(",")}`
    )).join(';\n'))
    const backend = await startBackend((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': raw.length })
      res.end(raw)
    })
    const { proxy, cookie } = await startProxy(backend)
    const res = await httpRaw({
      port: proxy.port,
      path: '/assets/index-Dqw48FrP.js',
      headers: { cookie, 'accept-encoding': 'gzip' },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-encoding'], 'gzip')
    assert.match(String(res.headers.vary ?? ''), /Accept-Encoding/i)
    assert.equal(res.headers['content-length'], undefined)
    const decoded = gunzipSync(res.body)
    assert.equal(Buffer.compare(decoded, raw), 0)
    const saved = ratio(raw.length, res.body.length)
    console.log(`proxy gzip JS ${raw.length} -> ${res.body.length} (${formatPct(saved)} saved)`)
    if (saved < 0.10) {
      assert.fail(`proxy gzip saved only ${formatPct(saved)} on JS; do not keep compressResponses default true`)
    }
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable')
  })

  it('does not gzip when the client omits Accept-Encoding', async () => {
    const raw = Buffer.from('x'.repeat(4096))
    const backend = await startBackend((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ pad: raw.toString() }))
    })
    const { proxy, cookie } = await startProxy(backend)
    const res = await httpRaw({
      port: proxy.port,
      path: '/api/session.list',
      headers: { cookie },
    })
    assert.equal(res.headers['content-encoding'], undefined)
    assert.equal(JSON.parse(res.body.toString('utf8')).pad.length, 4096)
  })

  it('does not gzip when compressResponses is false', async () => {
    const raw = Buffer.from(Array.from({ length: 200 }, (_, i) => `const n${i}=${i}`).join('\n'))
    const backend = await startBackend((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/javascript', 'content-length': raw.length })
      res.end(raw)
    })
    const { proxy, cookie } = await startProxy(backend, { compressResponses: false })
    const res = await httpRaw({
      port: proxy.port,
      path: '/assets/index-Dqw48FrP.js',
      headers: { cookie, 'accept-encoding': 'gzip' },
    })
    assert.equal(res.headers['content-encoding'], undefined)
    assert.equal(Buffer.compare(res.body, raw), 0)
  })

  it('passes through an already-gzipped upstream body', async () => {
    const raw = Buffer.from('{"k":"' + 'abcd'.repeat(400) + '"}')
    const encoded = gzipSync(raw)
    const backend = await startBackend((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-length': encoded.length,
      })
      res.end(encoded)
    })
    const { proxy, cookie } = await startProxy(backend)
    const res = await httpRaw({
      port: proxy.port,
      path: '/api/payload',
      headers: { cookie, 'accept-encoding': 'gzip' },
    })
    assert.equal(res.headers['content-encoding'], 'gzip')
    assert.equal(Buffer.compare(res.body, encoded), 0)
    assert.equal(Buffer.compare(gunzipSync(res.body), raw), 0)
  })

  it('does not gzip woff2 or tiny JSON', async () => {
    const font = Buffer.alloc(2048, 7)
    const tiny = Buffer.from('{"status":"pending"}\n')
    const backend = await startBackend((req, res) => {
      if (req.url === '/assets/fonts/KaTeX_Main-Regular-B22Nviop.woff2') {
        res.writeHead(200, { 'content-type': 'font/woff2', 'content-length': font.length })
        res.end(font)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': tiny.length })
      res.end(tiny)
    })
    const { proxy, cookie } = await startProxy(backend)
    const fontRes = await httpRaw({
      port: proxy.port,
      path: '/assets/fonts/KaTeX_Main-Regular-B22Nviop.woff2',
      headers: { cookie, 'accept-encoding': 'gzip' },
    })
    assert.equal(fontRes.headers['content-encoding'], undefined)
    assert.equal(Buffer.compare(fontRes.body, font), 0)
    assert.equal(fontRes.headers['cache-control'], 'public, max-age=31536000, immutable')

    const jsonRes = await httpRaw({
      port: proxy.port,
      path: '/api/wait',
      headers: { cookie, 'accept-encoding': 'gzip' },
    })
    assert.equal(jsonRes.headers['content-encoding'], undefined)
    assert.equal(jsonRes.body.toString('utf8'), tiny.toString('utf8'))
    assert.equal(jsonRes.headers['cache-control'], undefined)
  })

  it('does not gzip SSE, so a delayed second event still arrives', { timeout: 5_000 }, async () => {
    let timer: NodeJS.Timeout | undefined
    const backend = await startBackend((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write('data: first\n\n')
      timer = setTimeout(() => {
        res.write('data: second\n\n')
        res.end()
      }, 250)
    })
    cleanups.push(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
    const { proxy, cookie } = await startProxy(backend)
    const res = await httpRaw({
      port: proxy.port,
      path: '/events',
      headers: { cookie, 'accept-encoding': 'gzip' },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-encoding'], undefined)
    assert.match(String(res.headers['content-type']), /text\/event-stream/)
    assert.equal(res.body.toString('utf8'), 'data: first\n\ndata: second\n\n')
  })

  it('does not cache /api or index.html', async () => {
    const backend = await startBackend((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<html><body>app</body></html>')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, pad: 'n'.repeat(2048) }))
    })
    const { proxy, cookie } = await startProxy(backend)
    const api = await httpRaw({
      port: proxy.port,
      path: '/api/session.list',
      headers: { cookie, 'accept-encoding': 'gzip' },
    })
    assert.equal(api.headers['cache-control'], undefined)
    const page = await httpRaw({
      port: proxy.port,
      path: '/',
      headers: { cookie, 'accept-encoding': 'gzip' },
    })
    assert.equal(page.headers['cache-control'], undefined)
  })

  it('leaves hashed-asset cache off when cacheHashedAssets is false', async () => {
    const raw = Buffer.from('export const n=1\n'.repeat(80))
    const backend = await startBackend((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/javascript', 'content-length': raw.length })
      res.end(raw)
    })
    const { proxy, cookie } = await startProxy(backend, { cacheHashedAssets: false })
    const res = await httpRaw({
      port: proxy.port,
      path: '/assets/index-Dqw48FrP.js',
      headers: { cookie, 'accept-encoding': 'gzip' },
    })
    assert.equal(res.headers['cache-control'], undefined)
  })

  it('gzips a real frontend vendor bundle when the dist is present', async (t) => {
    const dist = findFrontendDist()
    if (dist === undefined) {
      t.skip('dsh-web-frontend dist not found on this machine')
      return
    }
    const assets = join(dist, 'assets')
    const vendorName = readdirSync(assets).find(name => name.startsWith('vendor-') && name.endsWith('.js'))
    if (vendorName === undefined) {
      t.skip('no vendor-*.js in frontend dist')
      return
    }
    const raw = readFileSync(join(assets, vendorName))
    const backend = await startBackend((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': raw.length })
      res.end(raw)
    })
    const { proxy, cookie } = await startProxy(backend)
    const res = await httpRaw({
      port: proxy.port,
      path: `/assets/${vendorName}`,
      headers: { cookie, 'accept-encoding': 'gzip' },
    })
    assert.equal(res.headers['content-encoding'], 'gzip')
    assert.equal(Buffer.compare(gunzipSync(res.body), raw), 0)
    const saved = ratio(raw.length, res.body.length)
    console.log(`proxy gzip dist ${vendorName} ${raw.length} -> ${res.body.length} (${formatPct(saved)} saved)`)
    if (saved < 0.10) {
      assert.fail(`real vendor.js gzip saved only ${formatPct(saved)}; default-on gzip would be self-deception`)
    }
  })
})
