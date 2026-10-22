/**
 * proxy-compress — response compression and hashed-asset cache-control decisions.
 *
 * Pure header/path predicates used by the reverse proxy. Streaming gzip itself
 * stays in proxy.ts so this module can be unit-tested without sockets.
 *
 * Gzip is only for compressible HTTP bodies. SSE, WebSocket upgrades, already
 * encoded bodies, fonts, raster images (PNG/JPEG/WebP/GIF used by vision
 * attachments), and tiny payloads are out of scope; those decisions
 * are asserted by tests against measured sizes, not claimed ratios.
 */
import type { ProxyHeaders } from './proxy-headers.ts'

/** Below this, gzip's framing often makes the body larger (measured in tests). */
export const MIN_GZIP_BODY_BYTES = 1024

const COMPRESSIBLE_MEDIA = new Set([
  'text/html',
  'text/css',
  'text/plain',
  'text/javascript',
  'text/xml',
  'application/javascript',
  'application/json',
  'application/xml',
  'application/manifest+json',
  'application/xhtml+xml',
  'image/svg+xml',
])

function firstHeader(value: string | string[] | number | undefined): string | undefined {
  if (value === undefined) return undefined
  const text = Array.isArray(value) ? value[0] : String(value)
  return text === '' ? undefined : text
}

function mediaType(contentType: string | string[] | number | undefined): string {
  const raw = firstHeader(contentType)
  if (raw === undefined) return ''
  return raw.split(';', 1)[0].trim().toLowerCase()
}

function parseQ(params: string[]): number {
  if (params.length === 0) return 1
  // A coding has at most one weight, not arbitrary extension parameters. Fail
  // closed rather than letting Number accept signs, exponents, hex or >3 digits.
  if (params.length !== 1) return 0
  const match = /^q[ \t]*=[ \t]*(0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/i.exec(params[0].trim())
  return match === null ? 0 : Number(match[1])
}

function encodingPreferences(acceptEncoding: string | string[] | undefined): Map<string, number> {
  const raw = Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : acceptEncoding
  const preferences = new Map<string, number>()
  for (const part of (raw ?? '').split(',')) {
    const [coding, ...params] = part.trim().split(';')
    const token = coding.trim().toLowerCase()
    if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(token)) continue
    const q = parseQ(params)
    // Conflicting duplicate declarations are ambiguous: a refusal must not be
    // undone by header order (including values in different header array rows).
    preferences.set(token, Math.min(preferences.get(token) ?? 1, q))
  }
  return preferences
}

/**
 * RFC 9110 content-coding q-value. Missing name falls back to `*`.
 * `undefined` means the client did not advertise that coding at all.
 */
export function encodingQ(
  acceptEncoding: string | string[] | undefined,
  name: string,
): number | undefined {
  const preferences = encodingPreferences(acceptEncoding)
  return preferences.get(name.trim().toLowerCase()) ?? preferences.get('*')
}

export function acceptsGzip(acceptEncoding: string | string[] | undefined): boolean {
  return (encodingQ(acceptEncoding, 'gzip') ?? 0) > 0
}

export type ContentEncoding = 'br' | 'gzip'

/**
 * Negotiate supported codings only when advertised, explicitly or by wildcard.
 * Higher q wins; Brotli wins ties. An explicit, strictly higher identity weight
 * wins over compression; implicit identity acceptance is not a preference.
 * undefined also covers "none acceptable"; deciding on HTTP 406 is the caller's
 * responsibility. The caller must separately check shouldCompressResponse.
 */
export function selectContentEncoding(acceptEncoding: string | string[] | undefined): ContentEncoding | undefined {
  const preferences = encodingPreferences(acceptEncoding)
  const br = preferences.get('br') ?? preferences.get('*') ?? 0
  const gzip = preferences.get('gzip') ?? preferences.get('*') ?? 0
  const best = Math.max(br, gzip)
  if (best === 0 || (preferences.get('identity') ?? 0) > best) return undefined
  return br >= gzip ? 'br' : 'gzip'
}

export function isCompressibleMediaType(contentType: string | string[] | number | undefined): boolean {
  const type = mediaType(contentType)
  if (type === '' || type === 'text/event-stream') return false
  if (COMPRESSIBLE_MEDIA.has(type)) return true
  return type.endsWith('+json') || type.endsWith('+xml')
}

function declaredLength(contentLength: string | string[] | number | undefined): number | undefined {
  const raw = firstHeader(contentLength)
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

function alreadyEncoded(contentEncoding: string | string[] | number | undefined): boolean {
  const raw = Array.isArray(contentEncoding) ? contentEncoding.join(',') : firstHeader(contentEncoding)
  if (raw === undefined) return false
  const tokens = raw.split(',').map(part => part.trim().toLowerCase()).filter(Boolean)
  return tokens.some(token => token !== 'identity')
}

function hasNoTransform(cacheControl: string | string[] | number | undefined): boolean {
  const raw = Array.isArray(cacheControl) ? cacheControl.join(',') : String(cacheControl ?? '')
  // Commas inside extension values are not directive boundaries.
  let quoted = false
  let escaped = false
  let start = 0
  for (let index = 0; index <= raw.length; index++) {
    const char = raw[index]
    if (escaped) escaped = false
    else if (quoted && char === '\\') escaped = true
    else if (char === '"') quoted = !quoted
    else if ((char === ',' && !quoted) || index === raw.length) {
      const directive = raw.slice(start, index).split('=', 1)[0].trim().toLowerCase()
      if (directive === 'no-transform') return true
      start = index + 1
    }
  }
  return false
}

export interface GzipDecisionInput {
  compressEnabled: boolean
  method?: string
  status?: number
  acceptEncoding?: string | string[]
  contentType?: string | string[] | number
  contentEncoding?: string | string[] | number
  contentLength?: string | string[] | number
  requestCacheControl?: string | string[] | number
  responseCacheControl?: string | string[] | number
  upgrade?: string | string[] | number
}

/** The existing input shape is shared by both compression algorithms. */
export type CompressionDecisionInput = GzipDecisionInput

/** Shared body eligibility; encoding negotiation is deliberately separate. */
export function shouldCompressResponse(input: CompressionDecisionInput): boolean {
  if (input.compressEnabled !== true) return false
  const method = (input.method ?? 'GET').toUpperCase()
  if (method === 'HEAD' || method === 'CONNECT') return false
  const status = input.status ?? 200
  if (status < 200 || status === 204 || status === 205 || status === 206 || status === 304) return false
  const upgrade = Array.isArray(input.upgrade) ? input.upgrade.join(',') : firstHeader(input.upgrade)
  if (upgrade !== undefined && upgrade.trim() !== '') return false
  if (hasNoTransform(input.requestCacheControl) || hasNoTransform(input.responseCacheControl)) return false
  if (alreadyEncoded(input.contentEncoding)) return false
  if (!isCompressibleMediaType(input.contentType)) return false
  const length = declaredLength(input.contentLength)
  if (length !== undefined && length < MIN_GZIP_BODY_BYTES) return false
  return true
}

/** Gzip-only compatibility entry point; Brotli advertisement does not disable gzip. */
export function shouldGzipResponse(input: GzipDecisionInput): boolean {
  if (!shouldCompressResponse(input)) return false
  const preferences = encodingPreferences(input.acceptEncoding)
  const gzip = preferences.get('gzip') ?? preferences.get('*') ?? 0
  return gzip > 0 && (preferences.get('identity') ?? 0) <= gzip
}

function headerKey(headers: ProxyHeaders, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return key
  }
  return undefined
}

function readHeader(headers: ProxyHeaders, name: string): string | string[] | number | undefined {
  const key = headerKey(headers, name)
  return key === undefined ? undefined : headers[key]
}

function deleteHeader(headers: ProxyHeaders, name: string) {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) delete headers[key]
  }
}

/** Also call for identity variants whenever a response can be negotiated. */
export function mergeAcceptEncodingVary(headers: ProxyHeaders) {
  const varyKey = headerKey(headers, 'vary')
  const parts = Object.entries(headers)
    .filter(([key]) => key.toLowerCase() === 'vary')
    .flatMap(([, value]) => Array.isArray(value) ? value : [String(value ?? '')])
    .flatMap(value => value.split(','))
    .map(part => part.trim())
    .filter(Boolean)
  const unique = parts.filter((part, index) => parts.findIndex(value => value.toLowerCase() === part.toLowerCase()) === index)
  if (!unique.some(part => part.toLowerCase() === 'accept-encoding')) unique.push('Accept-Encoding')
  deleteHeader(headers, 'vary')
  headers[varyKey ?? 'vary'] = unique.includes('*') ? '*' : unique.join(', ')
}

/** Update representation metadata after transforming the upstream body. */
export function applyContentEncodingResponseHeaders(headers: ProxyHeaders, encoding: ContentEncoding) {
  deleteHeader(headers, 'content-length')
  deleteHeader(headers, 'content-encoding')
  headers['content-encoding'] = encoding
  for (const name of ['content-md5', 'digest', 'content-digest']) deleteHeader(headers, name)
  const etagKey = headerKey(headers, 'etag')
  const etag = etagKey === undefined ? undefined : headers[etagKey]
  if (etagKey !== undefined && typeof etag === 'string' && etag.startsWith('"')) headers[etagKey] = 'W/' + etag
  mergeAcceptEncodingVary(headers)
}

/** Gzip-only compatibility wrapper. */
export function applyGzipResponseHeaders(headers: ProxyHeaders) {
  applyContentEncodingResponseHeaders(headers, 'gzip')
}

/**
 * Vite hashed filenames: `name-` + 8-char hash + extension, under `/assets/`.
 * `preview-desktop.png` (7-char suffix) and `/index.html` do not match.
 */
export function isHashedStaticAssetPath(pathname: string): boolean {
  return /^\/assets\/(?:[^/]+\/)*[^/]+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/.test(pathname)
}

export function hasCacheControl(headers: ProxyHeaders): boolean {
  return headerKey(headers, 'cache-control') !== undefined
}

/**
 * Long-cache hashed `/assets/*` GETs. Never overrides an upstream Cache-Control,
 * never caches errors, never touches `/api` or HTML shells.
 */
export function maybeSetHashedAssetCacheControl(
  headers: ProxyHeaders,
  pathname: string,
  status: number,
  enabled: boolean,
) {
  if (enabled !== true || status !== 200) return
  if (!isHashedStaticAssetPath(pathname)) return
  if (hasCacheControl(headers)) return
  headers['cache-control'] = 'public, max-age=31536000, immutable'
}

export function gzipDecisionFromUpstream(
  req: { method?: string, headers: { 'accept-encoding'?: string | string[], 'cache-control'?: string | string[], upgrade?: string | string[] } },
  incoming: { statusCode?: number, headers: ProxyHeaders },
  compressEnabled: boolean,
): boolean {
  return shouldGzipResponse({
    compressEnabled,
    method: req.method,
    status: incoming.statusCode,
    acceptEncoding: req.headers['accept-encoding'],
    requestCacheControl: req.headers['cache-control'],
    responseCacheControl: readHeader(incoming.headers, 'cache-control'),
    upgrade: req.headers.upgrade,
    contentType: readHeader(incoming.headers, 'content-type'),
    contentEncoding: readHeader(incoming.headers, 'content-encoding'),
    contentLength: readHeader(incoming.headers, 'content-length'),
  })
}
