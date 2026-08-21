/**
 * proxy-compress — response gzip and hashed-asset cache-control decisions.
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
  for (const param of params) {
    const [key, rawValue] = param.trim().split('=', 2)
    if (key.trim().toLowerCase() !== 'q') continue
    const q = Number(rawValue)
    return Number.isFinite(q) ? q : 0
  }
  return 1
}

/**
 * RFC 9110 content-coding q-value. Missing name falls back to `*`.
 * `undefined` means the client did not advertise that coding at all.
 */
export function encodingQ(
  acceptEncoding: string | string[] | undefined,
  name: string,
): number | undefined {
  const raw = Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : acceptEncoding
  if (raw === undefined || raw.trim() === '') return undefined
  const wanted = name.toLowerCase()
  let named: number | undefined
  let star: number | undefined
  for (const part of raw.split(',')) {
    const [coding, ...params] = part.trim().split(';')
    const token = coding.trim().toLowerCase()
    if (token === '') continue
    const q = parseQ(params)
    if (token === wanted) named = q
    else if (token === '*') star = q
  }
  return named ?? star
}

export function acceptsGzip(acceptEncoding: string | string[] | undefined): boolean {
  return (encodingQ(acceptEncoding, 'gzip') ?? 0) > 0
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
  const raw = firstHeader(contentEncoding)
  if (raw === undefined) return false
  const tokens = raw.split(',').map(part => part.trim().toLowerCase()).filter(Boolean)
  return tokens.some(token => token !== 'identity')
}

export interface GzipDecisionInput {
  compressEnabled: boolean
  method?: string
  status?: number
  acceptEncoding?: string | string[]
  contentType?: string | string[] | number
  contentEncoding?: string | string[] | number
  contentLength?: string | string[] | number
}

/** Whether the proxy should wrap this upstream HTTP response in gzip. */
export function shouldGzipResponse(input: GzipDecisionInput): boolean {
  if (input.compressEnabled !== true) return false
  const method = (input.method ?? 'GET').toUpperCase()
  if (method === 'HEAD' || method === 'CONNECT') return false
  const status = input.status ?? 200
  if (status < 200 || status === 204 || status === 206 || status === 304) return false
  if (!acceptsGzip(input.acceptEncoding)) return false
  if (alreadyEncoded(input.contentEncoding)) return false
  if (!isCompressibleMediaType(input.contentType)) return false
  const length = declaredLength(input.contentLength)
  if (length !== undefined && length < MIN_GZIP_BODY_BYTES) return false
  return true
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
  const key = headerKey(headers, name)
  if (key !== undefined) delete headers[key]
}

/** Strip Content-Length, set Content-Encoding: gzip, merge Vary. */
export function applyGzipResponseHeaders(headers: ProxyHeaders) {
  deleteHeader(headers, 'content-length')
  headers['content-encoding'] = 'gzip'
  const varyKey = headerKey(headers, 'vary')
  const vary = varyKey === undefined ? undefined : headers[varyKey]
  const parts = (Array.isArray(vary) ? vary.join(',') : String(vary ?? ''))
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
  if (!parts.some(part => part.toLowerCase() === 'accept-encoding')) parts.push('Accept-Encoding')
  headers[varyKey ?? 'vary'] = parts.join(', ')
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
  req: { method?: string, headers: { 'accept-encoding'?: string | string[] } },
  incoming: { statusCode?: number, headers: ProxyHeaders },
  compressEnabled: boolean,
): boolean {
  return shouldGzipResponse({
    compressEnabled,
    method: req.method,
    status: incoming.statusCode,
    acceptEncoding: req.headers['accept-encoding'],
    contentType: readHeader(incoming.headers, 'content-type'),
    contentEncoding: readHeader(incoming.headers, 'content-encoding'),
    contentLength: readHeader(incoming.headers, 'content-length'),
  })
}
