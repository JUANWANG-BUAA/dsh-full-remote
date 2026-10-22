import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MIN_GZIP_BODY_BYTES,
  acceptsGzip,
  applyContentEncodingResponseHeaders,
  applyGzipResponseHeaders,
  encodingQ,
  gzipDecisionFromUpstream,
  mergeAcceptEncodingVary,
  selectContentEncoding,
  shouldCompressResponse,
  shouldGzipResponse,
} from '../src/proxy-compress.ts'
import type { CompressionDecisionInput } from '../src/proxy-compress.ts'
import type { ProxyHeaders } from '../src/proxy-headers.ts'

const base: CompressionDecisionInput = {
  compressEnabled: true,
  contentType: 'application/json',
  contentLength: 4096,
  acceptEncoding: 'br, gzip',
}

describe('strict Accept-Encoding helpers', () => {
  it('accepts RFC qvalues, OWS, casing and header arrays', () => {
    for (const [raw, expected] of [['0', 0], ['0.', 0], ['0.001', 0.001], ['0.75', 0.75], ['1', 1], ['1.', 1], ['1.000', 1]] as const) {
      assert.equal(encodingQ('gzip;q=' + raw, 'gzip'), expected, raw)
    }
    assert.equal(encodingQ(['deflate', ' GZIP ; Q = 0.500 ', 'BR'], 'GZip'), 0.5)
    assert.equal(acceptsGzip(['br;q=0', 'gzip;q=1']), true)
    assert.equal(encodingQ('gzip', 'br'), undefined)
    assert.equal(encodingQ('', 'gzip'), undefined)
    assert.equal(encodingQ([], 'gzip'), undefined)
  })

  it('rejects malformed, out-of-range, repeated and non-q parameters', () => {
    for (const suffix of ['q', 'q=', 'q=2', 'q=1.001', 'q=-1', 'q=+1', 'q=.5', 'q=01', 'q=0.1234', 'q=1.0000', 'q=1e0', 'q=0x1', 'q=NaN', 'q=Infinity', 'q="0.5"', 'q=0.5=ignored', 'q=0;q=1', 'level=1', 'q=1;level=1', '']) {
      const header = 'gzip;' + suffix
      assert.equal(encodingQ(header, 'gzip'), 0, header)
      assert.equal(acceptsGzip(header), false, header)
      assert.equal(selectContentEncoding(header + ', *;q=1, br;q=0'), undefined, header)
    }
    assert.equal(encodingQ('g zip;q=1', 'gzip'), undefined)
  })

  it('gives explicit declarations priority over wildcard, including q=0', () => {
    assert.equal(encodingQ('*;q=1, gzip;q=0', 'gzip'), 0)
    assert.equal(encodingQ('gzip;q=0, *;q=1', 'gzip'), 0)
    assert.equal(encodingQ('*;q=0.7', 'br'), 0.7)
    assert.equal(encodingQ('*;q=0, gzip;q=0.6', 'gzip'), 0.6)
    assert.equal(encodingQ('gzip;q=bad, *;q=1', 'gzip'), 0)
  })

  it('does not let conflicting duplicate headers undo a refusal', () => {
    for (const values of [['gzip;q=0', 'gzip'], ['gzip', 'gzip;q=0'], ['gzip;q=bad', 'gzip']]) {
      assert.equal(acceptsGzip(values), false)
      assert.equal(selectContentEncoding(values), undefined)
    }
    assert.equal(encodingQ(['gzip;q=0.8', 'gzip;q=0.4'], 'gzip'), 0.4)
  })

  it('selects by q, prefers br on ties and honors explicit identity preference', () => {
    const cases: Array<[string | string[] | undefined, 'br' | 'gzip' | undefined]> = [
      [undefined, undefined], ['', undefined], [[], undefined], ['deflate', undefined],
      ['gzip', 'gzip'], ['br', 'br'], ['gzip, br', 'br'], ['br, gzip', 'br'],
      ['br;q=0.2, gzip;q=0.8', 'gzip'], ['br;q=0.8, gzip;q=0.2', 'br'],
      [['gzip;q=0.5', 'br;q=0.5'], 'br'], ['gzip;q=0, br;q=0', undefined],
      ['*', 'br'], ['*;q=0', undefined], ['*;q=0.5, br;q=0', 'gzip'],
      ['*;q=0, br;q=0.5', 'br'], ['gzip;q=0.2, *;q=0.8', 'br'],
      ['br;q=0.4, gzip;q=0.5, identity;q=0.6', undefined],
      ['br;q=0.5, gzip;q=0.5, identity;q=0.5', 'br'],
      ['gzip;q=0.5, identity;q=0', 'gzip'], ['identity;q=0, *;q=0', undefined],
      ['gzip;q=0.4, identity;q=bad', 'gzip'],
    ]
    for (const [header, expected] of cases) assert.equal(selectContentEncoding(header), expected, JSON.stringify(header))
  })
})

describe('shared compression eligibility', () => {
  it('is independent of encoding negotiation and keeps the gzip API compatible', () => {
    assert.equal(shouldCompressResponse({ ...base, acceptEncoding: undefined }), true)
    assert.equal(shouldGzipResponse(base), true)
    assert.equal(shouldGzipResponse({ ...base, acceptEncoding: 'br' }), false)
    assert.equal(shouldGzipResponse({ ...base, acceptEncoding: 'gzip;q=0.2, identity;q=0.8' }), false)
    assert.equal(shouldGzipResponse({ ...base, acceptEncoding: 'gzip;q=0.2' }), true)
    assert.equal(shouldGzipResponse({ ...base, acceptEncoding: 'gzip;q=2' }), false)
  })

  it('shares exclusions for disabled, tiny, bodyless, partial, SSE, WS and noncompressible bodies', () => {
    const exclusions: Partial<CompressionDecisionInput>[] = [
      { compressEnabled: false }, { method: 'head' }, { method: 'CONNECT' },
      ...[101, 199, 204, 205, 206, 304].map(status => ({ status })),
      { upgrade: 'websocket' }, { upgrade: ['', 'websocket'] }, { contentLength: MIN_GZIP_BODY_BYTES - 1 },
      ...['text/event-stream; charset=utf-8', 'font/woff2', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/octet-stream', undefined].map(contentType => ({ contentType })),
    ]
    for (const exclusion of exclusions) {
      assert.equal(shouldCompressResponse({ ...base, ...exclusion }), false, JSON.stringify(exclusion))
      assert.equal(shouldGzipResponse({ ...base, ...exclusion }), false, JSON.stringify(exclusion))
    }
    assert.equal(shouldCompressResponse({ ...base, contentLength: MIN_GZIP_BODY_BYTES }), true)
    assert.equal(shouldCompressResponse({ ...base, contentLength: undefined }), true)
    assert.equal(shouldCompressResponse({ ...base, contentType: ['application/problem+json; charset=utf-8'] }), true)
  })

  it('never double compresses, including encodings in subsequent header array rows', () => {
    for (const contentEncoding of ['gzip', 'br', 'deflate', 'identity, gzip', ['identity', 'br'], ['', 'gzip']]) {
      assert.equal(shouldCompressResponse({ ...base, contentEncoding }), false)
    }
    for (const contentEncoding of [undefined, '', [], 'identity', ['identity', 'IDENTITY']]) {
      assert.equal(shouldCompressResponse({ ...base, contentEncoding }), true)
    }
  })

  it('honors no-transform in either cache-control, including arrays and case variants', () => {
    for (const value of ['no-transform', 'private, NO-TRANSFORM', ['max-age=0', ' no-transform '], 'no-transform=ignored']) {
      assert.equal(shouldCompressResponse({ ...base, requestCacheControl: value }), false)
      assert.equal(shouldCompressResponse({ ...base, responseCacheControl: value }), false)
      assert.equal(shouldGzipResponse({ ...base, responseCacheControl: value }), false)
    }
    for (const value of ['private', 'x-no-transform', 'extension="no-transform"', 'extension="a, no-transform, b"']) {
      assert.equal(shouldCompressResponse({ ...base, responseCacheControl: value }), true, value)
    }
  })

  it('passes no-transform and upgrade through the legacy upstream adapter', () => {
    const incoming = { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Content-Length': 4096 } }
    const req = { headers: { 'accept-encoding': ['br', 'gzip'] } }
    assert.equal(gzipDecisionFromUpstream(req, incoming, true), true)
    assert.equal(gzipDecisionFromUpstream({ headers: { ...req.headers, 'cache-control': ['private', 'no-transform'] } }, incoming, true), false)
    assert.equal(gzipDecisionFromUpstream(req, { ...incoming, headers: { ...incoming.headers, 'Cache-Control': 'NO-TRANSFORM' } }, true), false)
    assert.equal(gzipDecisionFromUpstream({ headers: { ...req.headers, upgrade: 'websocket' } }, incoming, true), false)
  })
})

describe('encoding response metadata helpers', () => {
  it('merges array Vary and duplicates case-insensitively, idempotently', () => {
    const headers: ProxyHeaders = { Vary: ['Origin, accept-encoding', 'Accept-Encoding'], vary: 'origin, Cookie' }
    mergeAcceptEncodingVary(headers)
    assert.deepEqual(headers, { Vary: 'Origin, accept-encoding, Cookie' })
    mergeAcceptEncodingVary(headers)
    assert.deepEqual(headers, { Vary: 'Origin, accept-encoding, Cookie' })
    const empty: ProxyHeaders = {}
    mergeAcceptEncodingVary(empty)
    assert.equal(empty.vary, 'Accept-Encoding')
  })

  it('leaves Vary star as star rather than adding misleading field names', () => {
    const headers: ProxyHeaders = { Vary: ['Origin', '*'] }
    mergeAcceptEncodingVary(headers)
    assert.deepEqual(headers, { Vary: '*' })
  })

  it('clears stale body integrity and length metadata and weakens strong ETags for both codings', () => {
    for (const encoding of ['br', 'gzip'] as const) {
      const headers: ProxyHeaders = {
        'Content-Length': 4096, 'content-length': 4096,
        'Content-Encoding': 'identity', ETag: '"original"',
        'Content-MD5': 'old', Digest: 'old', 'Content-Digest': 'old',
        'content-type': 'application/json', 'cache-control': 'private', Vary: 'Origin',
      }
      applyContentEncodingResponseHeaders(headers, encoding)
      assert.deepEqual(headers, {
        'content-encoding': encoding, ETag: 'W/"original"',
        'content-type': 'application/json', 'cache-control': 'private', Vary: 'Origin, Accept-Encoding',
      })
    }
  })

  it('preserves weak ETags and the legacy gzip header wrapper', () => {
    const headers: ProxyHeaders = { etag: 'W/"original"', vary: '*' }
    applyGzipResponseHeaders(headers)
    assert.deepEqual(headers, { etag: 'W/"original"', vary: '*', 'content-encoding': 'gzip' })
  })
})
