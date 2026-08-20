import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { listenProxy } from '../src/proxy.ts'
import { generateAccessToken } from '../src/security.ts'
import { homePage, loginPage, waitPage } from '../src/pages.ts'
import {
  MIN_GZIP_BODY_BYTES,
  isHashedStaticAssetPath,
  shouldGzipResponse,
} from '../src/proxy-compress.ts'

/** Same map as Harness `frontend-static` — unknown extensions are octet-stream. */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
}

interface RawResponse {
  status: number | undefined
  headers: IncomingHttpHeaders
  body: Buffer
}

interface MatrixRow {
  name: string
  path: string
  type: string
  raw: number
  wire: number
  gzipSync: number
  gzipApplied: boolean
  cacheImmutable: boolean
  saved: number
  expectedGzip: boolean
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

function walkFiles(root: string, acc: string[] = []): string[] {
  for (const name of readdirSync(root)) {
    const full = join(root, name)
    if (statSync(full).isDirectory()) walkFiles(full, acc)
    else acc.push(full)
  }
  return acc
}

function mimeFor(filePath: string) {
  return MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

async function startProxyOverFiles(files: Map<string, { body: Buffer, type: string }>) {
  const backend = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const entry = files.get(url.pathname)
    if (entry === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('missing')
      return
    }
    res.writeHead(200, { 'content-type': entry.type, 'content-length': entry.body.length })
    res.end(entry.body)
  })
  await new Promise<void>((resolve, reject) => {
    backend.once('error', reject)
    backend.listen(0, '127.0.0.1', resolve)
  })
  cleanups.push(() => new Promise<void>(resolve => {
    backend.closeAllConnections?.()
    backend.close(() => resolve())
  }))
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
    upstreamTimeoutMs: 5_000,
    loginDelayMs: 0,
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
  return { proxy, cookie, loginBody: login.body }
}

async function measurePath(
  proxyPort: number,
  cookie: string,
  pathname: string,
  raw: Buffer,
  type: string,
): Promise<MatrixRow> {
  const expectedGzip = shouldGzipResponse({
    compressEnabled: true,
    method: 'GET',
    status: 200,
    acceptEncoding: 'gzip',
    contentType: type,
    contentLength: raw.length,
  })
  const res = await httpRaw({
    port: proxyPort,
    path: pathname,
    headers: { cookie, 'accept-encoding': 'gzip, deflate, br' },
  })
  assert.equal(res.status, 200)
  const gzipApplied = res.headers['content-encoding'] === 'gzip'
  if (gzipApplied) {
    assert.equal(Buffer.compare(gunzipSync(res.body), raw), 0)
  } else {
    assert.equal(Buffer.compare(res.body, raw), 0)
  }
  const gz = gzipSync(raw, { level: 6 })
  return {
    name: pathname,
    path: pathname,
    type,
    raw: raw.length,
    wire: res.body.length,
    gzipSync: gz.length,
    gzipApplied,
    cacheImmutable: String(res.headers['cache-control'] ?? '').includes('immutable'),
    saved: ratio(raw.length, res.body.length),
    expectedGzip,
  }
}

function printRows(title: string, rows: MatrixRow[]) {
  console.log(`\n=== ${title} ===`)
  console.log(['path', 'type', 'raw', 'wire', 'gzipSync', 'applied', 'cache', 'saved'].join('\t'))
  for (const row of rows) {
    console.log([
      row.path,
      row.type.split(';', 1)[0],
      row.raw,
      row.wire,
      row.gzipSync,
      row.gzipApplied ? 'gzip' : 'plain',
      row.cacheImmutable ? 'immutable' : '-',
      formatPct(row.saved),
    ].join('\t'))
  }
  const raw = rows.reduce((n, row) => n + row.raw, 0)
  const wire = rows.reduce((n, row) => n + row.wire, 0)
  console.log(`TOTAL\t\t${raw}\t${wire}\t\t\t${formatPct(ratio(raw, wire))}`)
}

describe('full proxy matrix against Harness frontend dist', { timeout: 120_000 }, () => {
  it('fetches every dist file through the proxy and records real sizes', async (t) => {
    const dist = findFrontendDist()
    if (dist === undefined) {
      t.skip('dsh-web-frontend dist not found')
      return
    }
    const files = new Map<string, { body: Buffer, type: string }>()
    for (const full of walkFiles(dist)) {
      const pathname = `/${relative(dist, full).split('\\').join('/')}`
      files.set(pathname, { body: readFileSync(full), type: mimeFor(full) })
    }
    assert.ok(files.size >= 20, `expected a real dist, got ${files.size} files`)

    const { proxy, cookie } = await startProxyOverFiles(files)
    const rows: MatrixRow[] = []
    for (const [pathname, entry] of files) {
      rows.push(await measurePath(proxy.port, cookie, pathname, entry.body, entry.type))
    }
    rows.sort((a, b) => b.raw - a.raw)
    printRows(`dist files (${rows.length})`, rows)

    const mismatches = rows.filter(row => row.gzipApplied !== row.expectedGzip)
    assert.deepEqual(mismatches.map(row => row.path), [], 'gzip apply/skip must match shouldGzipResponse')

    const grew = rows.filter(row => row.gzipApplied && row.wire >= row.raw)
    assert.deepEqual(grew.map(row => row.path), [], 'gzip must not run when it would not shrink the body')

    for (const row of rows) {
      if (isHashedStaticAssetPath(row.path)) {
        assert.equal(row.cacheImmutable, true, row.path)
      } else {
        assert.equal(row.cacheImmutable, false, row.path)
      }
    }

    const firstLoad = ['/index.html', ...[...files.keys()].filter(path => /^\/assets\/(index|vendor)-/.test(path))]
    const firstRows = rows.filter(row => firstLoad.includes(row.path))
    printRows('first-load shell + hashed index/vendor', firstRows)
    const firstRaw = firstRows.reduce((n, row) => n + row.raw, 0)
    const firstWire = firstRows.reduce((n, row) => n + row.wire, 0)
    const firstSaved = ratio(firstRaw, firstWire)
    console.log(`first-load saved ${formatPct(firstSaved)} (${firstRaw} -> ${firstWire})`)
    if (firstSaved < 0.10) {
      assert.fail(`first-load gzip saved only ${formatPct(firstSaved)}; default-on gzip would be self-deception`)
    }

    const byExt = new Map<string, MatrixRow[]>()
    for (const row of rows) {
      const ext = extname(row.path) || '(none)'
      const list = byExt.get(ext) ?? []
      list.push(row)
      byExt.set(ext, list)
    }
    console.log('\n=== by extension ===')
    for (const [ext, list] of [...byExt.entries()].sort((a, b) => b[1].reduce((n, r) => n + r.raw, 0) - a[1].reduce((n, r) => n + r.raw, 0))) {
      const raw = list.reduce((n, row) => n + row.raw, 0)
      const wire = list.reduce((n, row) => n + row.wire, 0)
      const gzipped = list.filter(row => row.gzipApplied).length
      console.log(`${ext}\tfiles=${list.length}\tgzipped=${gzipped}\traw=${raw}\twire=${wire}\tsaved=${formatPct(ratio(raw, wire))}`)
    }
  })
})

describe('JSON size sweep through the proxy', () => {
  it('shows the 1 KB floor is the point where gzip stops growing the body', async () => {
    const sizes = [12, 64, 200, 512, 1023, 1024, 2048, 8192, 65_536]
    const files = new Map<string, { body: Buffer, type: string }>()
    for (const size of sizes) {
      const payload = { pad: 'n'.repeat(Math.max(0, size - 12)), n: size }
      let body = Buffer.from(`${JSON.stringify(payload)}\n`)
      if (body.length < size) body = Buffer.concat([body, Buffer.alloc(size - body.length, 0x20)])
      if (body.length > size) body = body.subarray(0, size)
      files.set(`/api/json-${size}`, { body, type: 'application/json; charset=utf-8' })
    }
    const { proxy, cookie } = await startProxyOverFiles(files)
    const rows: MatrixRow[] = []
    for (const size of sizes) {
      const pathname = `/api/json-${size}`
      const entry = files.get(pathname)!
      rows.push(await measurePath(proxy.port, cookie, pathname, entry.body, entry.type))
    }
    printRows('JSON size sweep', rows)
    for (const row of rows) {
      assert.equal(row.gzipApplied, row.expectedGzip, row.path)
      assert.equal(row.cacheImmutable, false, row.path)
      if (row.raw < MIN_GZIP_BODY_BYTES) {
        assert.equal(row.gzipApplied, false)
      }
    }
    const justBelow = rows.find(row => row.raw === 1023)
    const justAbove = rows.find(row => row.raw === 1024)
    assert.ok(justBelow && justAbove)
    assert.equal(justBelow.gzipApplied, false)
    assert.equal(justAbove.gzipApplied, true)
    if (justAbove.saved < 0) {
      assert.fail(`1024-byte JSON gzip grew the body (${justAbove.raw} -> ${justAbove.wire}); raise the floor`)
    }
  })
})

describe('gate pages are not gzipped today', () => {
  it('measures login/wait/home as actually served, vs gzipSync potential', async () => {
    const backend = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    await new Promise<void>((resolve, reject) => {
      backend.once('error', reject)
      backend.listen(0, '127.0.0.1', resolve)
    })
    cleanups.push(() => new Promise<void>(resolve => backend.close(() => resolve())))
    const token = generateAccessToken()
    const proxy = await listenProxy({
      listenHost: '127.0.0.1',
      listenPort: 0,
      backendHost: '127.0.0.1',
      backendPort: portOf(backend),
      accessToken: token,
      cookieName: 'session',
      controlPrefix: '/dsh-reverse-proxy',
      maxRequestBytes: 4096,
      upstreamTimeoutMs: 2_000,
      loginDelayMs: 0,
      approvalMode: true,
    })
    cleanups.push(proxy.close)

    const login = await httpRaw({
      port: proxy.port,
      path: '/_dsh_reverse_proxy/login',
      headers: { 'accept-encoding': 'gzip' },
    })
    assert.equal(login.status, 200)
    assert.equal(login.headers['content-encoding'], undefined)
    const loginRaw = login.body.length
    const loginGz = gzipSync(login.body, { level: 6 }).length
    console.log(`gate login actual ${loginRaw} gzipSync ${loginGz} potential ${formatPct(ratio(loginRaw, loginGz))} encoding=${login.headers['content-encoding'] ?? 'none'}`)

    const generated = {
      login: Buffer.from(loginPage('zh', '')),
      wait: Buffer.from(waitPage('zh', 'sess', 'iPhone')),
      home: Buffer.from(homePage('zh', {
        host: 'example.trycloudflare.com',
        label: 'iPhone',
        createdAt: Date.now(),
        sessionMaxAgeSeconds: 2592000,
        approvalMode: false,
      })),
    }
    for (const [name, buf] of Object.entries(generated)) {
      const gz = gzipSync(buf, { level: 6 }).length
      console.log(`gate ${name} generated ${buf.length} gzipSync ${gz} potential ${formatPct(ratio(buf.length, gz))} floor=${buf.length >= MIN_GZIP_BODY_BYTES}`)
    }
    assert.ok(loginRaw > 1000)
    assert.equal(login.headers['content-encoding'], undefined, 'sendHtml path does not gzip; do not claim it does')
  })
})
