import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { IncomingHttpHeaders } from 'node:http'
import type { ProxyHeaders } from '../src/proxy-headers.ts'
import {
  createStaticResponseCache,
  isCacheableStaticResponse,
  staticCacheRequestKey,
  staticResponseTtlMs,
  type CachedStaticResponse,
} from '../src/static-cache.ts'

function response(text = 'body', headers: ProxyHeaders = {}): CachedStaticResponse {
  return { status: 200, headers, body: Buffer.from(text) }
}

function entryBytes(key: string, value: CachedStaticResponse, sessionId: string): number {
  return value.body.length + Buffer.byteLength(JSON.stringify(value.headers))
    + Buffer.byteLength(key) + Buffer.byteLength(sessionId) + (value.receivedAt === undefined ? 0 : 16)
}

const asset = '/assets/index-AbCd1234.js'
function requestKey(headers: IncomingHttpHeaders = {}, url = asset, sessionId = 'device-a') {
  return staticCacheRequestKey({ method: 'GET', url, headers }, sessionId)
}

describe('static response memory cache', () => {
  it('starts empty; copies on both insertion and every read, including header arrays', () => {
    const cache = createStaticResponseCache()
    assert.deepEqual(cache.stats(), { entries: 0, bytes: 0 })
    assert.equal(cache.get('missing'), undefined)
    const original = response('body', { vary: ['Accept-Encoding'], 'content-length': 4, unset: undefined })
    const size = entryBytes('key', original, 'session')
    cache.put('key', original, 'session')
    original.body.fill(0)
    ;(original.headers.vary as string[]).push('Cookie')
    original.headers.added = 'not cached'
    const first = cache.get('key')!
    assert.equal(first.body.toString(), 'body')
    assert.deepEqual(first.headers, { vary: ['Accept-Encoding'], 'content-length': 4, unset: undefined })
    first.body.fill(1)
    ;(first.headers.vary as string[])[0] = 'Cookie'
    Reflect.set(first.headers, 'extra', 'not cached')
    const second = cache.get('key')!
    assert.equal(second.body.toString(), 'body')
    assert.deepEqual(second.headers, { vary: ['Accept-Encoding'], 'content-length': 4, unset: undefined })
    assert.notEqual(first, second)
    assert.deepEqual(cache.stats(), { entries: 1, bytes: size })
    const stats = cache.stats()
    stats.bytes = 0
    assert.equal(cache.stats().bytes, size)
  })

  it('preserves receivedAt without header leakage or external mutation, charging 16 bytes', () => {
    const value = { ...response(), receivedAt: 500 }
    const size = entryBytes('key', value, 'session')
    const cache = createStaticResponseCache({ maxBytes: size, maxEntryBytes: size, now: () => 1000 })
    cache.put('key', value, 'session')
    value.receivedAt = 700
    const cached = cache.get('key')!
    assert.equal(cached.receivedAt, 500)
    assert.equal(cached.headers.receivedAt, undefined)
    cached.receivedAt = 900
    assert.equal(cache.get('key')?.receivedAt, 500)
    assert.deepEqual(cache.stats(), { entries: 1, bytes: size })
    const tooSmall = createStaticResponseCache({ maxBytes: size - 1, now: () => 1000 })
    tooSmall.put('key', { ...value, receivedAt: 500 }, 'session')
    assert.deepEqual(tooSmall.stats(), { entries: 0, bytes: 0 })
  })

  it('rejects invalid or future receivedAt metadata without replacing old entries', () => {
    const cache = createStaticResponseCache({ now: () => 1000 })
    cache.put('key', { ...response('old'), receivedAt: 0 }, 'session')
    for (const receivedAt of [NaN, Infinity, -1, 0.5, 1001, Number.MAX_SAFE_INTEGER + 1]) {
      cache.put('key', { ...response('new'), receivedAt }, 'session')
      assert.equal(cache.get('key')?.receivedAt, 0)
      assert.equal(cache.get('key')?.body.toString(), 'old')
    }
    cache.put('legacy', response(), 'session')
    assert.equal(Object.hasOwn(cache.get('legacy')!, 'receivedAt'), false)
  })

  it('evicts least recently used entries, touching on reads and replacement', () => {
    const cache = createStaticResponseCache({ maxEntries: 2 })
    cache.put('a', response(), 'one')
    cache.put('b', response(), 'one')
    cache.get('a')
    cache.put('c', response(), 'two')
    assert.equal(cache.get('b'), undefined)
    assert.ok(cache.get('a'))
    cache.put('c', response('replacement'), 'two')
    cache.put('d', response(), 'two')
    assert.equal(cache.get('a'), undefined)
    assert.equal(cache.get('c')?.body.toString(), 'replacement')
    assert.equal(cache.stats().entries, 2)
  })

  it('accounts UTF-8 body, serialized headers, key and session; honors exact byte cap', () => {
    const value = response('世界', { title: '图片', vary: ['Accept-Encoding'] })
    const size = entryBytes('键', value, '设备')
    const cache = createStaticResponseCache({ maxBytes: size, maxEntryBytes: size })
    cache.put('键', value, '设备')
    assert.deepEqual(cache.stats(), { entries: 1, bytes: size })
    const tooSmall = createStaticResponseCache({ maxBytes: size - 1 })
    tooSmall.put('键', value, '设备')
    assert.deepEqual(tooSmall.stats(), { entries: 0, bytes: 0 })
  })

  it('evicts as many LRU entries as byte pressure requires, without exceeding caps', () => {
    const value = response('x')
    const size = entryBytes('a', value, 's')
    const cache = createStaticResponseCache({ maxBytes: size * 3, maxEntryBytes: size * 3 })
    for (const key of ['a', 'b', 'c']) cache.put(key, value, 's')
    cache.get('a')
    cache.put('d', response('x'.repeat(size + 1)), 's')
    assert.equal(cache.get('b'), undefined)
    assert.equal(cache.get('c'), undefined)
    assert.ok(cache.get('a'))
    assert.ok(cache.get('d'))
    assert.ok(cache.stats().bytes <= size * 3)
  })

  it('oversized writes preserve old entry, LRU order, ownership and expiry', () => {
    let time = 0
    const cache = createStaticResponseCache({ maxEntries: 2, maxEntryBytes: 20, ttlMs: 10, now: () => time })
    cache.put('a', response('old'), 's')
    cache.put('b', response(), 's')
    const before = cache.stats()
    cache.put('a', response('x'.repeat(30)), 'different')
    cache.put('huge', response('', { big: 'x'.repeat(30) }), 's')
    assert.deepEqual(cache.stats(), before)
    cache.deleteSession('different')
    time = 9
    assert.equal(cache.get('a')?.body.toString(), 'old')
    time = 10
    assert.equal(cache.get('a'), undefined)
    cache.put('a', response('old'), 's')
    cache.put('b', response(), 's')
    cache.put('a', response('x'.repeat(30)), 's')
    cache.put('c', response(), 's')
    assert.equal(cache.get('a'), undefined)
  })

  it('rejects replacements exceeding global byte cap even if per-entry cap is larger', () => {
    const cache = createStaticResponseCache({ maxBytes: 12, maxEntryBytes: 100 })
    cache.put('a', response('old'), 's')
    const before = cache.stats()
    cache.put('a', response('x'.repeat(20)), 's')
    assert.deepEqual(cache.stats(), before)
    assert.equal(cache.get('a')?.body.toString(), 'old')
  })

  it('expires at default five minutes; LRU reads do not extend TTL', () => {
    let time = 0
    const cache = createStaticResponseCache({ now: () => time })
    cache.put('a', response(), 's')
    time = 299_999
    assert.ok(cache.get('a'))
    time = 300_000
    assert.equal(cache.get('a'), undefined)
    assert.deepEqual(cache.stats(), { entries: 0, bytes: 0 })
  })

  it('supports downward-only TTL overrides, zero TTL invalidation and lazy sweeping', () => {
    let time = 0
    const cache = createStaticResponseCache({ ttlMs: 100, now: () => time })
    cache.put('short', response(), 's', 5)
    cache.put('long', response(), 's', 999)
    time = 5
    assert.equal(cache.get('short'), undefined)
    assert.ok(cache.get('long'))
    cache.put('zero', response(), 's')
    cache.put('zero', response(), 's', 0)
    assert.equal(cache.get('zero'), undefined)
    time = 100
    assert.deepEqual(cache.stats(), { entries: 0, bytes: 0 })
    cache.put('fresh', response(), 's')
    time = 200
    cache.put('new', response(), 's')
    assert.equal(cache.stats().entries, 1)
  })

  it('replacements reset TTL/accounting and transfer session ownership', () => {
    let time = 0
    const cache = createStaticResponseCache({ ttlMs: 10, now: () => time })
    cache.put('a', response('old'), 'first')
    time = 9
    const value = response('new body', { title: 'new' })
    cache.put('a', value, 'second')
    cache.deleteSession('first')
    time = 10
    assert.equal(cache.get('a')?.body.toString(), 'new body')
    assert.deepEqual(cache.stats(), { entries: 1, bytes: entryBytes('a', value, 'second') })
    time = 19
    assert.equal(cache.get('a'), undefined)
  })

  it('invalidates all variants for just one session synchronously and clears accounting', () => {
    const cache = createStaticResponseCache()
    for (const encoding of ['gzip', 'br', 'identity']) {
      cache.put('a-' + encoding, response(encoding), 'a')
      cache.put('b-' + encoding, response(encoding), 'b')
    }
    cache.deleteSession('missing')
    cache.deleteSession('a')
    assert.equal(cache.stats().entries, 3)
    for (const encoding of ['gzip', 'br', 'identity']) {
      assert.equal(cache.get('a-' + encoding), undefined)
      assert.equal(cache.get('b-' + encoding)?.body.toString(), encoding)
    }
    cache.clear()
    cache.clear()
    assert.deepEqual(cache.stats(), { entries: 0, bytes: 0 })
    cache.put('new', response(), 'a')
    assert.equal(cache.stats().entries, 1)
  })

  it('enforces default 128-entry, 1 MiB-entry and 8 MiB-total limits', () => {
    const countLimited = createStaticResponseCache()
    for (let index = 0; index < 129; index++) countLimited.put(String(index), response(), 's')
    assert.equal(countLimited.stats().entries, 128)
    assert.equal(countLimited.get('0'), undefined)
    assert.ok(countLimited.get('128'))
    const byteLimited = createStaticResponseCache()
    byteLimited.put('oversized', response('x'.repeat(1024 * 1024)), 's')
    assert.equal(byteLimited.stats().entries, 0)
    const value = response('x'.repeat(1024 * 1024 - 128))
    for (let index = 0; index < 9; index++) byteLimited.put(String(index), value, 's')
    assert.equal(byteLimited.stats().entries, 8)
    assert.equal(byteLimited.get('0'), undefined)
    assert.ok(byteLimited.get('8'))
    assert.ok(byteLimited.stats().bytes <= 8 * 1024 * 1024)
  })

  it('validates options, supports zero limits, and ignores invalid per-entry lifetimes', () => {
    for (const option of ['maxBytes', 'maxEntryBytes', 'maxEntries', 'ttlMs']) {
      for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => createStaticResponseCache({ [option]: invalid }), RangeError)
      }
      const disabled = createStaticResponseCache({ [option]: 0 })
      disabled.put('a', response(), 's')
      assert.deepEqual(disabled.stats(), { entries: 0, bytes: 0 })
    }
    const cache = createStaticResponseCache()
    cache.put('a', response('old'), 's')
    for (const invalid of [-1, 0.5, NaN, Infinity]) cache.put('a', response('new'), 's', invalid)
    assert.equal(cache.get('a')?.body.toString(), 'old')
  })
})

describe('static request key admission', () => {
  it('accepts only GET hashed assets with a strict static extension allowlist', () => {
    for (const extension of ['js', 'mjs', 'css', 'svg', 'woff2', 'woff', 'ttf', 'otf', 'eot', 'png', 'jpg', 'jpeg', 'webp', 'ico', 'gif', 'avif', 'bmp', 'wasm']) {
      assert.ok(requestKey({}, '/assets/nested/name.1234abcd.' + extension), extension)
    }
    for (const url of ['/', '/api/assets/app-1234abcd.js', '/assets/main.js', '/assets/app-abc.js', '/assets/app-1234abcd.html', '/assets/app-1234abcd.json', '/assets/app-1234abcd.js.map', '/assets/app-1234abcd.txt', '/assets/../assets/app-1234abcd.js', '/assets/%61pp-1234abcd.js', '//assets/app-1234abcd.js', 'https://example.com' + asset, asset + '#x', asset + ' ', '/assets/./app-1234abcd.js']) {
      assert.equal(requestKey({}, url), undefined, url)
    }
    for (const method of ['POST', 'HEAD', 'OPTIONS', 'get', undefined]) {
      assert.equal(staticCacheRequestKey({ method, url: asset, headers: {} }, 's'), undefined)
    }
    assert.equal(staticCacheRequestKey({ method: 'GET', headers: {} }, 's'), undefined)
    assert.equal(requestKey({}, asset, ''), undefined)
  })

  it('keys exact full query, session and raw encoding values without normalizing q-values', () => {
    const keys = [
      requestKey(), requestKey({}, asset, 'device-b'), requestKey({}, asset + '?v=1'),
      requestKey({}, asset + '?v=2'), requestKey({ 'accept-encoding': 'gzip, br' }),
      requestKey({ 'accept-encoding': 'br, gzip' }), requestKey({ 'accept-encoding': 'gzip;q=0.5, br' }),
      requestKey({ 'Accept-Encoding': ['gzip', 'br'] }), requestKey({ 'accept-encoding': '' }),
    ]
    assert.equal(new Set(keys).size, keys.length)
    assert.ok(keys.every(key => key !== undefined))
    assert.equal(requestKey({ 'Accept-Encoding': 'gzip' }), requestKey({ 'accept-encoding': 'gzip' }))
    assert.notEqual(requestKey({}, asset + '?a=1&b=2'), requestKey({}, asset + '?b=2&a=1'))
    assert.notEqual(requestKey({}, asset + '?v=%31'), requestKey({}, asset + '?v=1'))
    assert.notEqual(requestKey({}, asset + '?v=a', 'b|c'), requestKey({}, asset + '?v=a|b', 'c'))
  })

  it('rejects sensitive query names, including URL-encoded and mixed-case variants', () => {
    for (const query of ['token=x', 'access_token=x', 'Invite=x', 'inviteCode=x', 'search=x', 'searchTerm=x', 'q=x', 'query=x', 'auth=x', 'sessionId=x', 'api_key=x', 'code=x', '%74oken=x', 'v=1&ToKeN=x']) {
      assert.equal(requestKey({}, asset + '?' + query), undefined, query)
    }
    assert.ok(requestKey({}, asset + '?v=token-looking-value&lang=zh'))
  })

  it('bypasses range, auth, forcing cache directives and all other If-* preconditions', () => {
    const denied: IncomingHttpHeaders[] = [
      { range: 'bytes=0-1' }, { Range: '' }, { authorization: 'Bearer x' },
      { upgrade: 'websocket' }, { Upgrade: '' }, { 'transfer-encoding': 'chunked' },
      { 'content-length': '1' }, { 'content-length': 'invalid' }, { 'content-length': '-0' },
      { 'Content-Length': ['0', '1'] }, { 'content-length': undefined },
      { 'cache-control': 'no-transform' }, { 'cache-control': 'public, NO-TRANSFORM' },
      { 'proxy-authorization': 'Basic x' }, { 'if-match': '*' }, { 'if-unmodified-since': 'date' },
      { 'if-range': 'tag' }, { 'If-Unknown': '' }, { 'cache-control': 'no-store' },
      { 'cache-control': 'public, NO-CACHE="field"' }, { 'cache-control': 'max-age=0' },
      { 'cache-control': 'max-age = "000"' }, { 'Cache-Control': ['max-age=3', 'no-cache'] },
      { 'cache-control': 'max-age=invalid' }, { pragma: 'No-Cache' },
      { 'cache-control': 'extension="unterminated' },
      { 'Cache-Control': 'public', 'cache-control': 'no-cache' },
    ]
    for (const headers of denied) assert.equal(requestKey(headers), undefined, JSON.stringify(headers))
    for (const headers of [
      { 'if-none-match': '"tag"' }, { 'if-modified-since': 'Wed, 01 Jan 2025 00:00:00 GMT' },
      { 'cache-control': 'max-age=60' }, { 'cache-control': 'extension="a,no-cache"' },
      { pragma: 'extension' }, { 'content-length': '0' },
    ]) assert.equal(requestKey(headers), requestKey())
  })
})

describe('upstream static response freshness', () => {
  const now = Date.parse('Wed, 01 Jan 2025 00:00:00 GMT')
  const date = (offset: number) => new Date(now + offset).toUTCString()

  it('defaults to five minutes and caps long explicit freshness without reading MIME', () => {
    assert.equal(staticResponseTtlMs({}, now), 300_000)
    assert.equal(staticResponseTtlMs({ 'cache-control': 'private, immutable' }, now), 300_000)
    assert.equal(staticResponseTtlMs({ 'cache-control': 'max-age=60' }, now), 60_000)
    assert.equal(staticResponseTtlMs({ 'cache-control': 'MAX-AGE = "60"' }, now), 60_000)
    assert.equal(staticResponseTtlMs({ 'cache-control': 'max-age=3600' }, now), 300_000)
    assert.equal(staticResponseTtlMs({ 'cache-control': 'max-age=3600', age: '3500' }, now), 100_000)
    assert.ok(staticResponseTtlMs({}) > 0)
  })

  it('subtracts the greater Age or apparent Date age, never sums them', () => {
    const headers = { 'cache-control': 'max-age=60', age: '10', date: date(-20_000) }
    assert.equal(staticResponseTtlMs(headers, now), 40_000)
    assert.equal(staticResponseTtlMs({ ...headers, age: '30' }, now), 30_000)
    assert.equal(staticResponseTtlMs({ ...headers, age: '60' }, now), 0)
    assert.equal(staticResponseTtlMs({ ...headers, date: date(-60_000) }, now), 0)
    assert.equal(staticResponseTtlMs({ ...headers, date: date(60_000) }, now), 50_000)
    assert.equal(staticResponseTtlMs({ date: date(-100_000) }, now), 200_000)
    assert.equal(staticResponseTtlMs({ age: '300' }, now), 0)
    assert.equal(staticResponseTtlMs({ 'cache-control': 'max-age=60', date: date(0) }, now + 123), 59_877)
  })

  it('uses Expires without max-age, respects stale dates, and gives max-age precedence', () => {
    assert.equal(staticResponseTtlMs({ date: date(-10_000), expires: date(50_000) }, now), 50_000)
    assert.equal(staticResponseTtlMs({ expires: date(50_000) }, now), 50_000)
    assert.equal(staticResponseTtlMs({ expires: date(-1_000) }, now), 0)
    assert.equal(staticResponseTtlMs({ date: date(0), expires: date(60_000), age: '20' }, now), 40_000)
    assert.equal(staticResponseTtlMs({ expires: date(600_000) }, now), 300_000)
    assert.equal(staticResponseTtlMs({ 'cache-control': 'max-age=10', expires: date(60_000) }, now), 10_000)
    assert.equal(staticResponseTtlMs({ 'cache-control': 'max-age=10', expires: date(-60_000) }, now), 10_000)
  })

  it('rejects malformed, negative, overflow, missing and conflicting max-age metadata', () => {
    for (const value of ['-1', '+60', '0.5', '1e3', 'Infinity', 'NaN', '', 'abc', '9007199254740991', '60junk']) {
      assert.equal(staticResponseTtlMs({ 'cache-control': 'max-age=' + value }, now), 0, value)
    }
    for (const control of ['max-age', 'max-age="60', 'max-age=60, max-age=61', 'max-age=60, max-age=0']) {
      assert.equal(staticResponseTtlMs({ 'cache-control': control }, now), 0, control)
    }
    assert.equal(staticResponseTtlMs({ 'cache-control': 'max-age=60, max-age="060"' }, now), 60_000)
    assert.equal(staticResponseTtlMs({ 'cache-control': 'max-age=60', 'Cache-Control': 'max-age=61' }, now), 0)
  })

  it('fails closed on invalid, duplicate or missing Age/Date/Expires values', () => {
    for (const age of ['-1', '+1', '0.5', ' 1 ', 'NaN', '1, 2', '9007199254740991']) {
      assert.equal(staticResponseTtlMs({ age }, now), 0, age)
    }
    for (const key of ['age', 'date', 'expires']) {
      for (const value of [undefined, [], ['0', '0'], 'invalid']) {
        assert.equal(staticResponseTtlMs({ [key]: value }, now), 0, key + ':' + String(value))
      }
    }
    assert.equal(staticResponseTtlMs({ Age: '0', age: '0' }, now), 0)
    for (const invalid of ['0', '2025-01-01', 'Wed, 32 Jan 2025 00:00:00 GMT', 'Thu, 01 Jan 2025 00:00:00 GMT']) {
      assert.equal(staticResponseTtlMs({ date: invalid }, now), 0, invalid)
    }
    assert.equal(staticResponseTtlMs({ 'cache-control': 'max-age=60', expires: '0' }, now), 0)
    for (const invalidNow of [NaN, Infinity, -1, 0.5]) assert.equal(staticResponseTtlMs({}, invalidNow), 0)
  })

  it('gives forbidden response directives zero TTL while allowing per-device private', () => {
    for (const control of ['no-store', 'no-cache', 'no-cache="field"', 'must-revalidate', 'max-age=0']) {
      assert.equal(staticResponseTtlMs({ 'cache-control': control }, now), 0)
    }
    assert.equal(staticResponseTtlMs({ 'cache-control': 'private, no-transform, max-age=60' }, now), 60_000)
    assert.equal(staticResponseTtlMs({ 'cache-control': 'extension="a,no-store", max-age=60' }, now), 60_000)
  })
})

describe('raw static response admission', () => {
  function cacheable(extra: ProxyHeaders = {}, status = 200) {
    return isCacheableStaticResponse({ 'content-type': 'application/javascript', ...extra }, status)
  }

  it('accepts 200 static media only (including compressed representations), permits per-device private', () => {
    for (const type of ['text/css', 'text/javascript', 'application/javascript', 'image/svg+xml', 'font/woff', 'font/woff2', 'image/png', 'image/jpeg', 'image/webp', 'image/x-icon', 'application/wasm', 'application/octet-stream']) {
      assert.ok(cacheable({ 'content-type': type }), type)
    }
    assert.ok(cacheable({ 'Content-Type': undefined }))
    assert.ok(isCacheableStaticResponse({ 'Content-Type': 'TEXT/CSS; charset=utf-8' }, 200))
    assert.ok(cacheable({ 'cache-control': 'private, max-age=60', 'content-encoding': 'br' }))
    assert.ok(cacheable({ 'cache-control': 'no-transform' }))
    assert.ok(cacheable({ 'cache-control': 'extension="a,no-cache", immutable' }))
    for (const status of [0, 101, 201, 204, 206, 301, 304, 400, 404, 500]) assert.equal(cacheable({}, status), false)
    for (const type of ['', 'text/html', 'application/xhtml+xml', 'application/json', 'application/problem+json', 'text/event-stream', 'text/plain', 'text/css, text/html']) {
      assert.equal(cacheable({ 'content-type': type }), false, type)
    }
    assert.equal(isCacheableStaticResponse({}, 200), false)
    assert.equal(cacheable({ 'content-type': ['text/css', 'application/javascript'] }), false)
    assert.equal(cacheable({ 'Content-Type': 'text/html' }), false)
  })

  it('rejects any raw Set-Cookie, content-range and no-cache/no-store/revalidation directives', () => {
    const denied: ProxyHeaders[] = [
      { 'set-cookie': ['device=secret'] }, { 'Set-Cookie': '' }, { 'set-cookie': undefined },
      { 'content-range': 'bytes 0-1/99' }, { 'cache-control': 'no-store' },
      { 'cache-control': 'public, no-cache="Set-Cookie"' }, { 'cache-control': 'must-revalidate' },
      { 'cache-control': 'max-age=0' }, { 'cache-control': 'max-age="00"' },
      { 'cache-control': ['public', 'no-store'] }, { 'Cache-Control': 'no-cache' },
      { 'cache-control': 'max-age' }, { 'cache-control': 'extension="unterminated' },
      { 'cache-control': 'public, max-age=3600, max-age=0' },
    ]
    for (const headers of denied) assert.equal(cacheable(headers), false, JSON.stringify(headers))
  })

  it('allows only Accept-Encoding Vary, checking every header casing and array row', () => {
    for (const vary of ['', 'Accept-Encoding', ' accept-encoding, ACCEPT-ENCODING ', ['Accept-Encoding', 'accept-encoding']]) {
      assert.ok(cacheable({ vary }))
    }
    for (const vary of ['*', 'Cookie', 'Authorization', 'Accept-Language', 'Accept-Encoding, User-Agent', ['Accept-Encoding', '*']]) {
      assert.equal(cacheable({ vary }), false)
    }
    assert.equal(cacheable({ vary: 'Accept-Encoding', Vary: 'Cookie' }), false)
  })
})
