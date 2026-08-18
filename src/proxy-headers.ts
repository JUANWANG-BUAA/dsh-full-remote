import { isIP } from 'node:net'
import type { IncomingMessage } from 'node:http'
import { normalizeRemoteIp } from './cidr.ts'
import { isLoopbackHost } from './hosts.ts'

/** Response/request header bag accepted by Node's HTTP APIs. */
export type ProxyHeaders = Record<string, string | string[] | number | undefined>

export interface ForwardingRuntime {
  trustForwardedFor(): boolean
  trustCloudflareConnectingIp?(): boolean
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
])

function connectionTokens(headers: ProxyHeaders | Record<string, string | string[] | undefined> | undefined) {
  const tokens = new Set<string>(['proxy-connection'])
  const connection = headers?.connection
  const values = Array.isArray(connection) ? connection : [connection]
  for (const value of values) {
    for (const token of String(value ?? '').split(',')) {
      const normalized = token.trim().toLowerCase()
      if (normalized !== '') tokens.add(normalized)
    }
  }
  return tokens
}
const SPOOFABLE_FORWARDING = new Set([
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-real-ip',
  'x-dsh-reverse-proxy',
])
const INTERNAL_HEADERS = new Set(['cookie', 'referer', 'referrer'])

function csvHeaderPart(value: string | string[] | undefined, pick: 'first' | 'last'): string | undefined {
  const text = Array.isArray(value)
    ? (pick === 'last' ? value[value.length - 1] : value[0])
    : value
  const parts = String(text ?? '').split(',').map(part => part.trim()).filter(Boolean)
  const chosen = pick === 'last' ? parts[parts.length - 1] : parts[0]
  return chosen === undefined || chosen === '' ? undefined : chosen
}

function lastForwardedIp(value: string | string[] | undefined) {
  return csvHeaderPart(value, 'last')
}

function firstHeaderValue(value: string | string[] | undefined) {
  return csvHeaderPart(value, 'first')
}

function trustedForwardedIp(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const ip = normalizeRemoteIp(value)
  if (isIP(ip) === 0 || isLoopbackHost(ip)) return undefined
  return ip
}

/** Resolve the client address only from explicitly trusted loopback edges. */
export function effectiveRemoteAddress(req: IncomingMessage, spec: ForwardingRuntime): string {
  const direct = req.socket.remoteAddress ?? ''
  if (spec.trustForwardedFor() && isLoopbackHost(direct)) {
    if (spec.trustCloudflareConnectingIp?.() === true) {
      const cf = trustedForwardedIp(firstHeaderValue(req.headers['cf-connecting-ip']))
      if (cf !== undefined) return cf
    }
    const forwarded = trustedForwardedIp(lastForwardedIp(req.headers['x-forwarded-for']))
    if (forwarded !== undefined) return forwarded
  }
  return direct
}

export function requestIsHttps(req: IncomingMessage, tls: boolean, trustForwardedProto: boolean) {
  return tls === true || (
    trustForwardedProto
    && isLoopbackHost(req.socket.remoteAddress ?? '')
    && firstHeaderValue(req.headers['x-forwarded-proto'])?.toLowerCase() === 'https'
  )
}

export function cookieIsSecure(req: IncomingMessage, spec: { tls: boolean, trustForwardedProto(): boolean }) {
  return requestIsHttps(req, spec.tls === true, spec.trustForwardedProto())
}

export function forwardHeaders(req: IncomingMessage, backendHost: string, options: { tls?: boolean, trustForwardedProto?: boolean, forwardedFor?: string } = {}) {
  const headers: Record<string, string | string[] | undefined> = {}
  const nominated = connectionTokens(req.headers)
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase()
    if (value === undefined || value === null || lower === 'host' || nominated.has(lower) || HOP_BY_HOP.has(lower) || SPOOFABLE_FORWARDING.has(lower) || INTERNAL_HEADERS.has(lower)) continue
    headers[lower] = value as string | string[]
  }
  const sourceHost = req.headers.host ?? ''
  const remote = req.socket.remoteAddress ?? ''
  const proto = requestIsHttps(req, options.tls === true, options.trustForwardedProto === true) ? 'https' : 'http'
  headers.host = backendHost
  headers.origin = `http://${backendHost}`
  headers['sec-fetch-site'] = 'same-origin'
  headers['x-forwarded-for'] = options.forwardedFor ?? remote
  headers['x-forwarded-host'] = sourceHost
  headers['x-forwarded-proto'] = proto
  headers['x-dsh-reverse-proxy'] = '1'
  return headers
}

function sanitizeHeaders(headers: ProxyHeaders | undefined, keep: ReadonlySet<string> = new Set()) {
  const out: Record<string, string | string[] | number | undefined> = {}
  const nominated = connectionTokens(headers)
  for (const [key, value] of Object.entries(headers ?? {})) {
    const lower = key.toLowerCase()
    if (value === undefined || value === null || lower === 'set-cookie') continue
    if (nominated.has(lower) && !keep.has(lower)) continue
    if (HOP_BY_HOP.has(lower) && !keep.has(lower)) continue
    out[key] = value as string | string[] | number
  }
  return out
}

/** Drop hop-by-hop and set-cookie before relaying an upstream response. */
export function sanitizeResponseHeaders(headers: ProxyHeaders | undefined) {
  return sanitizeHeaders(headers)
}

/** Preserve only Connection/Upgrade for a WebSocket 101 response. */
export function sanitizeUpgradeResponseHeaders(headers: ProxyHeaders | undefined) {
  return sanitizeHeaders(headers, new Set(['connection', 'upgrade']))
}
