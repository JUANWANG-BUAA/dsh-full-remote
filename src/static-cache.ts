import type { IncomingHttpHeaders } from 'node:http'
import type { ProxyHeaders } from './proxy-headers.ts'

const DEFAULT_TTL_MS = 300_000

export interface CachedStaticResponse {
  status: 200
  headers: ProxyHeaders
  body: Buffer
  /** Upstream header receipt time (epoch milliseconds), for downstream Age. */
  receivedAt?: number
}

export interface StaticResponseCacheOptions {
  maxBytes?: number
  maxEntryBytes?: number
  maxEntries?: number
  ttlMs?: number
  now?: () => number
}

export interface StaticResponseCache {
  get(key: string): CachedStaticResponse | undefined
  /** ttlMs may shorten, but never extend, the configured lifetime. */
  put(key: string, response: CachedStaticResponse, sessionId: string, ttlMs?: number): void
  deleteSession(sessionId: string): void
  clear(): void
  stats(): { entries: number, bytes: number }
}

interface CacheEntry {
  response: CachedStaticResponse
  sessionId: string
  expiresAt: number
  bytes: number
}

function cloneResponse(response: CachedStaticResponse): CachedStaticResponse {
  return {
    status: 200,
    headers: Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [
      name, Array.isArray(value) ? [...value] : value,
    ])),
    body: Buffer.from(response.body),
    ...(response.receivedAt === undefined ? {} : { receivedAt: response.receivedAt }),
  }
}

function limit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(
    name + ' must be a nonnegative safe integer',
  )
  return value
}

/**
 * Bounded, synchronous memory-only LRU. No timers, I/O or shared-device scope.
 * Byte accounting is body + UTF-8 JSON.stringify(headers) + key + sessionId
 * plus 16 bytes when receivedAt metadata is present;
 * it bounds retained payload, not JavaScript object/Map allocator overhead.
 * Oversized writes are no-ops (including replacement); zero TTL deletes an old
 * entry. Reads touch LRU without renewing TTL. Expiry is swept on get/put/stats.
 * The caller must authorize first, use session-scoped keys, and invalidate a
 * session on revocation. A hash-looking filename is NOT a security guarantee.
 */
export function createStaticResponseCache(options: StaticResponseCacheOptions = {}): StaticResponseCache {
  const maxBytes = limit(options.maxBytes ?? 8 * 1024 * 1024, 'maxBytes')
  const maxEntryBytes = limit(options.maxEntryBytes ?? 1024 * 1024, 'maxEntryBytes')
  const maxEntries = limit(options.maxEntries ?? 128, 'maxEntries')
  const ttlMs = limit(options.ttlMs ?? DEFAULT_TTL_MS, 'ttlMs')
  const now = options.now ?? Date.now
  const entries = new Map<string, CacheEntry>()
  let bytes = 0

  function remove(key: string): void {
    const entry = entries.get(key)
    if (entry === undefined) return
    entries.delete(key)
    bytes -= entry.bytes
  }

  function expire(time: number): void {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= time) remove(key)
    }
  }

  return {
    get(key) {
      expire(now())
      const entry = entries.get(key)
      if (entry === undefined) return undefined
      entries.delete(key)
      entries.set(key, entry)
      return cloneResponse(entry.response)
    },
    put(key, response, sessionId, entryTtlMs) {
      const time = now()
      expire(time)
      if (entryTtlMs !== undefined && (!Number.isSafeInteger(entryTtlMs) || entryTtlMs < 0)) return
      if (response.receivedAt !== undefined && (!Number.isSafeInteger(response.receivedAt)
        || response.receivedAt < 0 || response.receivedAt > time)) return
      const lifetime = Math.min(ttlMs, entryTtlMs ?? ttlMs)
      if (lifetime === 0) {
        remove(key)
        return
      }
      if (maxEntries === 0 || response.status !== 200) return
      const size = response.body.length + Buffer.byteLength(JSON.stringify(response.headers))
        + Buffer.byteLength(key) + Buffer.byteLength(sessionId) + (response.receivedAt === undefined ? 0 : 16)
      if (size > maxEntryBytes || size > maxBytes) return
      const copy = cloneResponse(response)
      remove(key)
      while (entries.size >= maxEntries || bytes + size > maxBytes) {
        const oldest = entries.keys().next()
        if (oldest.done) break
        remove(oldest.value)
      }
      entries.set(key, { response: copy, sessionId, expiresAt: time + lifetime, bytes: size })
      bytes += size
    },
    deleteSession(sessionId) {
      // Synchronous iteration completes before another JS callback can observe it.
      for (const [key, entry] of entries) {
        if (entry.sessionId === sessionId) remove(key)
      }
    },
    clear() {
      entries.clear()
      bytes = 0
    },
    stats() {
      expire(now())
      return { entries: entries.size, bytes }
    },
  }
}

function headerValues(headers: ProxyHeaders, name: string): string[] {
  return Object.entries(headers)
    .filter(([key]) => key.toLowerCase() === name)
    .flatMap(([, value]) => value === undefined ? [] : Array.isArray(value) ? value : [String(value)])
}

function hasHeader(headers: ProxyHeaders, name: string): boolean {
  return Object.keys(headers).some(key => key.toLowerCase() === name)
}

/** Split directives without interpreting commas inside quoted extension values. */
function directives(values: string[]): Array<{ name: string, value?: string }> | undefined {
  const raw = values.join(',')
  const parts: string[] = []
  let start = 0
  let quoted = false
  let escaped = false
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]
    if (escaped) escaped = false
    else if (quoted && char === '\\') escaped = true
    else if (char === '"') quoted = !quoted
    else if (char === ',' && !quoted) {
      parts.push(raw.slice(start, index))
      start = index + 1
    }
  }
  if (quoted || escaped) return undefined
  parts.push(raw.slice(start))
  return parts.filter(part => part.trim() !== '').map(part => {
    const equal = part.indexOf('=')
    return {
      name: (equal < 0 ? part : part.slice(0, equal)).trim().toLowerCase(),
      value: equal < 0 ? undefined : part.slice(equal + 1).trim().replace(/^"(.*)"$/, '$1'),
    }
  })
}

function forbidsCaching(headers: ProxyHeaders, response: boolean): boolean {
  const parsed = directives(headerValues(headers, 'cache-control'))
  if (parsed === undefined) return true
  return parsed.some(({ name, value }) => name === 'no-store' || name === 'no-cache'
    || (response && name === 'must-revalidate')
    || (name === 'max-age' && (value === undefined || !/^\d+$/.test(value) || Number(value) === 0)))
}

/** Strict delta-seconds; reject numeric syntax/overflow rather than coercing it. */
function deltaMilliseconds(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  const milliseconds = Number(value) * 1000
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined
}

/** IMF-fixdate only; obsolete/noncanonical/normalized-invalid dates fail closed. */
function httpDate(value: string): number | undefined {
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toUTCString() === value
    ? milliseconds : undefined
}

/**
 * Remaining upstream freshness, capped to five minutes. Read RAW headers before
 * adding proxy Cache-Control. max-age takes precedence over Expires; both Age
 * and apparent age from Date reduce freshness (using the larger, not their sum).
 * With neither explicit lifetime, the conservative local default is reduced by
 * that age too. Malformed/ambiguous metadata returns zero, never a fallback TTL.
 * No request/response timestamp pair is available: callers must also subtract
 * time spent buffering/encoding before storing this TTL, or recompute at put.
 */
export function staticResponseTtlMs(headers: ProxyHeaders, now = Date.now()): number {
  if (!Number.isSafeInteger(now) || now < 0 || forbidsCaching(headers, true)) return 0
  const parsed = directives(headerValues(headers, 'cache-control'))
  if (parsed === undefined) return 0
  const maxAges = parsed.filter(part => part.name === 'max-age')
    .map(part => deltaMilliseconds(part.value))
  if (maxAges.some(value => value === undefined) || new Set(maxAges).size > 1) return 0

  const ages = headerValues(headers, 'age')
  if (hasHeader(headers, 'age') && ages.length !== 1) return 0
  const age = ages.length === 0 ? 0 : deltaMilliseconds(ages[0])
  if (age === undefined) return 0

  const dates = headerValues(headers, 'date')
  if (hasHeader(headers, 'date') && dates.length !== 1) return 0
  const date = dates.length === 0 ? now : httpDate(dates[0])
  if (date === undefined) return 0

  const expiries = headerValues(headers, 'expires')
  if (hasHeader(headers, 'expires') && expiries.length !== 1) return 0
  const expires = expiries.length === 0 ? undefined : httpDate(expiries[0])
  if (expiries.length !== 0 && expires === undefined) return 0
  const lifetime = maxAges[0] ?? (expires === undefined ? DEFAULT_TTL_MS : expires - date)
  const currentAge = Math.max(age, now - date, 0)
  return Math.max(0, Math.min(DEFAULT_TTL_MS, lifetime - currentAge))
}

const STATIC_PATH = /^\/assets\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*[.-][A-Za-z0-9_-]{8,}\.(?:js|mjs|css|svg|woff2?|ttf|otf|eot|png|jpe?g|webp|ico|gif|avif|bmp|wasm)$/
const SENSITIVE_QUERY_NAMES = new Set(['q', 'query', 'auth', 'authorization', 'password', 'secret', 'session', 'sessionid', 'apikey', 'accesskey', 'code'])

/**
 * Conservative admission, not proof that upstream content is public. Only call
 * after device authentication. Full raw URL and Accept-Encoding are keyed;
 * validators are deliberately left to the proxy's conditional response logic.
 */
export function staticCacheRequestKey(
  req: { method?: string, url?: string, headers: IncomingHttpHeaders },
  sessionId: string,
): string | undefined {
  if (req.method !== 'GET' || !req.url || !sessionId) return undefined
  // Origin-form only; reject encoded/ambiguous paths rather than normalizing them.
  const pathname = req.url.split('?', 1)[0]
  if (!STATIC_PATH.test(pathname) || /[\s#\\]/.test(req.url)) return undefined
  const query = req.url.indexOf('?')
  if (query >= 0) {
    for (const name of new URLSearchParams(req.url.slice(query + 1)).keys()) {
      const normalized = name.toLowerCase().replace(/[-_.]/g, '')
      if (/token|invite|search/.test(normalized) || SENSITIVE_QUERY_NAMES.has(normalized)) return undefined
    }
  }
  for (const name of Object.keys(req.headers).map(name => name.toLowerCase())) {
    if (['range', 'authorization', 'proxy-authorization', 'upgrade', 'transfer-encoding'].includes(name)) return undefined
    if (name.startsWith('if-') && name !== 'if-none-match' && name !== 'if-modified-since') return undefined
  }
  const lengths = headerValues(req.headers, 'content-length')
  if (hasHeader(req.headers, 'content-length') && (lengths.length !== 1 || !/^0+$/.test(lengths[0]))) return undefined
  if (forbidsCaching(req.headers, false)) return undefined
  const cacheControl = directives(headerValues(req.headers, 'cache-control'))
  if (cacheControl?.some(part => part.name === 'no-transform')) return undefined
  const pragma = directives(headerValues(req.headers, 'pragma'))
  if (pragma === undefined || pragma.some(part => part.name === 'no-cache')) return undefined
  return JSON.stringify([sessionId, req.url, headerValues(req.headers, 'accept-encoding')])
}

const STATIC_MEDIA_TYPES = new Set([
  'text/css', 'text/javascript', 'application/javascript', 'application/x-javascript',
  'image/svg+xml', 'image/png', 'image/jpeg', 'image/webp', 'image/x-icon',
  'image/vnd.microsoft.icon', 'image/gif', 'image/avif', 'image/bmp',
  'font/woff', 'font/woff2', 'font/ttf', 'font/otf', 'application/font-woff',
  'application/x-font-woff', 'application/x-font-ttf', 'application/x-font-opentype',
  'application/vnd.ms-fontobject', 'application/wasm', 'application/octet-stream',
])

/**
 * Only use after staticCacheRequestKey admitted a strict hashed static path:
 * octet-stream is necessary for upstream font servers, not a generic API MIME.
 * Pass RAW upstream headers before Set-Cookie/Vary stripping or rewriting.
 */
export function isCacheableStaticResponse(headers: ProxyHeaders, status: number): boolean {
  if (status !== 200 || hasHeader(headers, 'set-cookie') || forbidsCaching(headers, true)) return false
  // Content-Range must never enter a full-representation cache, even on a bad 200.
  if (hasHeader(headers, 'content-range')) return false
  const vary = headerValues(headers, 'vary').flatMap(value => value.split(','))
  if (vary.some(value => value.trim() !== '' && value.trim().toLowerCase() !== 'accept-encoding')) return false
  const types = headerValues(headers, 'content-type')
  if (types.length !== 1) return false
  return STATIC_MEDIA_TYPES.has(types[0].split(';', 1)[0].trim().toLowerCase())
}
