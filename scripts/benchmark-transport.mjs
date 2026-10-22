/** Reproducible local HTTP benchmark: immutable Git baseline vs working tree. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { cpus, release, platform, arch } from 'node:os'
import { join, resolve, extname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { gunzipSync, brotliDecompressSync, gzipSync, brotliCompressSync, constants } from 'node:zlib'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const base = process.env.BENCH_BASE ?? '0d4b48c883'
const rounds = Number(process.env.BENCH_ROUNDS ?? 15)
const repeats = Number(process.env.BENCH_REPEATS ?? 10)
assert.ok(Number.isSafeInteger(rounds) && rounds >= 3 && rounds <= 100)
assert.ok(Number.isSafeInteger(repeats) && repeats >= 1 && repeats <= 100)
const dist = process.env.DSH_WEB_FRONTEND_DIST ?? '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist'
const output = join(root, 'output/benchmarks')
mkdirSync(output, { recursive: true })
const run = mkdtempSync(join(output, 'transport-'))
const baseline = join(run, 'baseline')
mkdirSync(baseline)
const revision = execFileSync('git', ['rev-parse', base], { cwd: root, encoding: 'utf8' }).trim()
execFileSync('tar', ['-x', '-C', baseline], { input: execFileSync('git', ['archive', revision, 'src'], { cwd: root }) })
const before = await import(pathToFileURL(join(baseline, 'src/proxy.ts')).href)
const after = await import(pathToFileURL(join(root, 'src/proxy.ts')).href)
const html = readFileSync(join(dist, 'index.html'))
const assetPaths = [...new Set([...html.toString().matchAll(/(?:src|href)="\.?(\/assets\/[^"?]+\.(?:js|css))"/g)].map(match => match[1]))]
assert.ok(assetPaths.length >= 4, 'expected index HTML to reference four real entry assets')
const hash = buffer => createHash('sha256').update(buffer).digest('hex')
const files = new Map(['/index.html', ...assetPaths].map(path => {
  const body = readFileSync(join(dist, path.slice(1)))
  return [path, { body, etag: '"' + hash(body) + '"', type: extname(path) === '.js' ? 'text/javascript' : extname(path) === '.css' ? 'text/css' : 'text/html' }]
}))
const controlPath = '/api/benchmark.json'
const controlBody = Buffer.from(JSON.stringify(Array.from({ length: 80 }, (_, i) => ({ id: i, title: 'Synthetic uncached session ' + i, running: i % 3 === 0, updatedAt: 1700000000000 + i }))))
files.set(controlPath, { body: controlBody, etag: '"' + hash(controlBody) + '"', type: 'application/json' })
const quantile = (values, q) => [...values].sort((a,b) => a-b)[Math.ceil(values.length*q)-1]
const summary = values => ({ median: quantile(values, .5), p95: quantile(values, .95), min: Math.min(...values), max: Math.max(...values) })
let upstream = { requests: 0, bodyBytes: 0, connections: 0 }
const backend = createServer((req, res) => {
  const entry = files.get(new URL(req.url, 'http://local').pathname)
  upstream.requests++
  if (!entry) { res.writeHead(404); res.end(); return }
  const condition = req.headers['if-none-match']
  const matched = condition && condition.split(',').some(tag => tag.trim().replace(/^W\//, '') === entry.etag)
  if (matched) { res.writeHead(304, { etag: entry.etag }); res.end(); return }
  upstream.bodyBytes += entry.body.length
  res.writeHead(200, { 'content-type': entry.type, 'content-length': entry.body.length, etag: entry.etag })
  res.end(entry.body)
})
backend.on('connection', () => upstream.connections++)
await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve))
const serverPort = backend.address().port
const proxies = []
async function raw(port, path, headers = {}, method = 'GET', body) {
  const started = performance.now()
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers, method, agent: false }, res => {
      const socket = res.socket
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.once('error', reject)
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), ms: performance.now()-started,
        responseHttpBytes: socket.bytesRead, requestHttpBytes: socket.bytesWritten }))
    })
    req.once('error', reject)
    req.end(body)
  })
}
async function start(module) {
  const proxy = await module.listenProxy({ listenHost: '127.0.0.1', listenPort: 0, backendHost: '127.0.0.1', backendPort: serverPort,
    accessToken: 'isolated-benchmark-only', cookieName: 'bench', controlPrefix: '/dsh-reverse-proxy', maxRequestBytes: 1048576, upstreamTimeoutMs: 3000, loginDelayMs: 0 })
  proxies.push(proxy)
  return proxy
}
async function login(proxy) {
  const res = await raw(proxy.port, '/_dsh_reverse_proxy/login', { 'content-type': 'application/x-www-form-urlencoded' }, 'POST', 'token=isolated-benchmark-only')
  assert.equal(res.status, 303)
  return res.headers['set-cookie'][0].split(';')[0]
}
function empty() { return { requests: 0, bodyBytes: 0, responseHttpBytes: 0, requestHttpBytes: 0, ms: 0, networkMs: 0, responseMs: [], statuses: {}, encodings: {}, upstreamRequests: 0, upstreamBodyBytes: 0, upstreamConnections: 0 } }
async function phase(proxy, cookie, paths, encoding, iterations, validators) {
  const metric = empty()
  const start = { ...upstream }
  const tags = {}
  const begin = performance.now()
  for (let i=0; i<iterations; i++) for (const path of paths) {
    const res = await raw(proxy.port, path, { cookie, 'accept-encoding': encoding, ...(validators ? { 'if-none-match': validators[path] } : {}) })
    assert.equal(res.status, validators ? 304 : 200)
    if (res.status === 200) {
      const decoded = res.headers['content-encoding'] === 'gzip' ? gunzipSync(res.body) : res.headers['content-encoding'] === 'br' ? brotliDecompressSync(res.body) : res.body
      assert.deepEqual(decoded, files.get(path).body)
    } else assert.equal(res.body.length, 0)
    metric.requests++
    metric.bodyBytes += res.body.length
    metric.responseHttpBytes += res.responseHttpBytes
    metric.requestHttpBytes += res.requestHttpBytes
    metric.networkMs += res.ms
    metric.responseMs.push(res.ms)
    metric.statuses[res.status] = (metric.statuses[res.status] ?? 0)+1
    const codec = res.headers['content-encoding'] ?? 'identity'
    metric.encodings[codec] = (metric.encodings[codec] ?? 0)+1
    if (res.headers.etag) tags[path] = res.headers.etag
  }
  metric.ms = performance.now()-begin
  metric.upstreamRequests = upstream.requests-start.requests
  metric.upstreamBodyBytes = upstream.bodyBytes-start.bodyBytes
  metric.upstreamConnections = upstream.connections-start.connections
  return { metric, tags }
}
const samples = []
try {
  const old = await start(before)
  const current = await start(after)
  const variants = [ { name: 'baseline-browser', proxy: old, encoding: 'gzip, deflate, br' },
    { name: 'current-gzip', proxy: current, encoding: 'gzip' }, { name: 'current-browser', proxy: current, encoding: 'gzip, deflate, br' } ]
  // Each sample uses a new authenticated device: no retained variant from another sample.
  // Two warm-up paired rounds are recorded separately, never included in summaries.
  for (let round=-2; round<rounds; round++) {
    const rotation = ((round % variants.length) + variants.length) % variants.length
    const rotated = [...variants.slice(rotation), ...variants.slice(0, rotation)]
    const order = round % 2 === 0 ? rotated : [...rotated].reverse()
    for (const variant of order) {
      const cookie = await login(variant.proxy)
      const cold = await phase(variant.proxy, cookie, ['/index.html', ...assetPaths], variant.encoding, 1)
      const warm = await phase(variant.proxy, cookie, assetPaths, variant.encoding, repeats)
      const conditional = await phase(variant.proxy, cookie, assetPaths, variant.encoding, repeats, warm.tags)
      const dynamic = await phase(variant.proxy, cookie, [controlPath], variant.encoding, repeats)
      assert.equal(dynamic.metric.upstreamRequests, repeats, 'dynamic API must never enter static cache')
      assert.equal(cold.metric.upstreamRequests, assetPaths.length + 1, 'cold means new device, not retained cache')
      assert.equal(warm.metric.upstreamRequests, variant.name.startsWith('current') ? 0 : assetPaths.length * repeats, 'warm hit must avoid upstream')
      assert.equal(conditional.metric.upstreamRequests, variant.name.startsWith('current') ? 0 : assetPaths.length * repeats)
      assert.equal(conditional.metric.bodyBytes, 0, 'both versions already support bodyless conditional responses')
      assert.equal(warm.metric.encodings[variant.name === 'current-browser' ? 'br' : 'gzip'], assetPaths.length * repeats)
      samples.push({ round, variant: variant.name, cold: cold.metric, warm: warm.metric, conditional: conditional.metric, dynamic: dynamic.metric })
    }
  }
  const compression = []
  for (const [path, file] of files) {
    if (path.endsWith('.html')) continue
    const times = { gzip: [], br: [] }
    let gzipBytes=0, brBytes=0
    for (let i=-3; i<20; i++) for (const codec of (i%2===0?['gzip','br']:['br','gzip'])) {
      const begin=performance.now()
      const encoded=codec==='gzip'?gzipSync(file.body,{level:6}):brotliCompressSync(file.body,{params:{[constants.BROTLI_PARAM_QUALITY]:4}})
      const elapsed=performance.now()-begin
      if(i>=0)times[codec].push(elapsed)
      if(codec==='gzip')gzipBytes=encoded.length; else brBytes=encoded.length
    }
    compression.push({path,rawBytes:file.body.length,gzipBytes,brBytes,gzipMs:summary(times.gzip),brMs:summary(times.br)})
  }
  const aggregates = {}
  for (const variant of variants) {
    aggregates[variant.name] = {}
    for (const name of ['cold','warm','conditional','dynamic']) {
      const rows = samples.filter(s=>s.round>=0&&s.variant===variant.name).map(s=>s[name])
      const sums = Object.fromEntries(['requests','bodyBytes','responseHttpBytes','requestHttpBytes','upstreamRequests','upstreamBodyBytes','upstreamConnections'].map(key=>[key,rows.reduce((sum,row)=>sum+row[key],0)]))
      aggregates[variant.name][name]={...sums,pairedRoundMs:summary(rows.map(row=>row.ms)),pairedNetworkMs:summary(rows.map(row=>row.networkMs)),responseMs:summary(rows.flatMap(row=>row.responseMs))}
    }
  }
  const result={schemaVersion:1,createdAt:new Date().toISOString(),baselineRevision:revision,node:process.version,os:{platform:platform(),release:release(),arch:arch(),cpu:cpus()[0]?.model},rounds,repeats,
    methodology:{network:'loopback HTTP/1.1, no TLS/tunnel/mobile radio',client:'agent:false, fresh downstream TCP per request; no browser cache, no concurrent requests',cold:'new authenticated device each round, index+4 entry assets fetched sequentially, not LCP',warm:'same device/URL/encoding, four entry assets repeated',conditional:'same asset cache with validators; backend implements weak ETag comparison on both versions',dynamic:'synthetic JSON API negative control, all requests must reach upstream on both versions',timing:'wall time including raw HTTP reading and decoding assertions; two warm-up rounds excluded; three variant order rotated and reversed across rounds',bytes:'actual socket bytesRead/bytesWritten per fresh HTTP connection; excludes TCP/IP/TLS framing',baselineSource:'git archive, unmodified source; working tree does not replace gzip baseline with uncompressed proxy',compression:'20 sync encodes per codec/file after 3 warmups, alternating order; time isolated from HTTP'},
    assets:[...files].map(([path,entry])=>({path,bytes:entry.body.length,sha256:hash(entry.body)})),sourceHashes:{baselineProxy:hash(readFileSync(join(baseline,'src/proxy.ts'))),currentProxy:hash(readFileSync(join(root,'src/proxy.ts'))),currentCompression:hash(readFileSync(join(root,'src/proxy-compress.ts'))),currentStaticCache:hash(readFileSync(join(root,'src/static-cache.ts'))),currentSessions:hash(readFileSync(join(root,'src/sessions.ts')))},aggregates,compression,samples}
  writeFileSync(join(run,'results.json'),JSON.stringify(result,null,2)+'\n')
  writeFileSync(join(output,'transport.json'),JSON.stringify(result,null,2)+'\n')
  console.log(JSON.stringify({result:join(output,'transport.json'),aggregates,compression},null,2))
} finally {
  for(const proxy of proxies)await proxy.close()
  backend.closeAllConnections()
  await new Promise(resolve=>backend.close(resolve))
}
