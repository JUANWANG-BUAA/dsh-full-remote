/**
 * proxy — the authenticated local reverse-proxy server.
 *
 * One Node http.Server in front of the DeepSeek Harness Web backend:
 * login gate (token + per-device session), optional approval wait pages,
 * header sanitization, stream-level body limits, and full WebSocket/SSE
 * upgrade forwarding with both-end teardown on close.
 *
 * All user-facing copy is delegated to pages.js; session state lives in the
 * caller-supplied session store (defaults to an in-memory one).
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse, type ClientRequest } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { isIP } from 'node:net'
import type { Duplex } from 'node:stream'
import { parseCookies, safeEqual } from './security.ts'
import { createSessionStore, encodeSessionCookie } from './sessions.ts'
import { normalizeRemoteIp } from './cidr.ts'
import { isLoopbackHost, readBody, sendHtml, pathnameOf, rewriteLoopbackAuthority } from './http-util.ts'
import { LOGIN_COPY, LOGIN_PATH, loginLocale, loginPage, waitPage } from './pages.ts'

/** Response header bag the proxy relays between client and upstream. */
type ProxyHeaders = Record<string, string | string[] | number | undefined>

/** Per-IP failed-login tracker surface. */
interface LoginTracker {
  check(ip: string, now?: number): number
  fail(ip: string, now?: number): void
  success(ip: string): void
  prune(now?: number): void
}

/** The bound proxy server handle returned to the runtime. */
export interface ProxyServer {
  host: string
  port: number
  close: () => Promise<void>
}

/** Caller-supplied configuration for listenProxy. */
export interface ProxySpec {
  listenHost: string
  listenPort: number
  backendHost: string
  backendPort: number
  accessToken: string
  cookieName: string
  controlPrefix: string
  maxRequestBytes: number
  upstreamTimeoutMs: number
  /** Session TTL; optional when a `sessionStore` is supplied (defaults to the store's own default). */
  sessionMaxAgeSeconds?: number
  maxHeaderSizeBytes?: number
  requestTimeoutMs?: number
  headersTimeoutMs?: number
  keepAliveTimeoutMs?: number
  loginDelayMs?: number
  loginMaxAttempts?: number
  loginLockoutMs?: number
  upgradeMaxAttempts?: number
  upgradeLockoutMs?: number
  sessionStore?: ReturnType<typeof createSessionStore>
  ipAllowed?: (address: string) => boolean
  audit?: (event: string, fields?: Record<string, unknown>) => void
  tls?: boolean | { key: string | Buffer, cert: string | Buffer }
  inviteStore?: { consume: (code: string) => boolean }
  trustForwardedProto?: boolean
  /** When true and the direct peer is loopback, use the first X-Forwarded-For value as the remote client IP for CIDR / rate limiting / audit. Only enable behind a trusted local tunnel/edge. */
  trustForwardedFor?: boolean
  log?: (entry: { method: string | undefined, path: string, status: number, remote: string }) => void
}

/** ProxySpec after listenProxy resolves defaults and internal helpers. */
type RuntimeSpec = ProxySpec & {
  tls: boolean
  trustForwardedProto: boolean
  trustForwardedFor: boolean
  rewriteAuthority: string
  trackUpstream: (up: ClientRequest | Duplex) => void
  loginTracker: LoginTracker
  sessionStore: ReturnType<typeof createSessionStore>
  /** Resolved (never undefined) so the login cookie always gets a numeric Max-Age. */
  sessionMaxAgeSeconds: number
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
const SPOOFABLE_FORWARDING = new Set([
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-real-ip',
  'x-dsh-reverse-proxy',
])
/**
 * The proxy's own session cookie never reaches the backend: the backend
 * cannot set cookies for the remote browser anyway (upstream `set-cookie`
 * is stripped), so forwarding it only risks credential confusion.
 */
const INTERNAL_HEADERS = new Set(['cookie', 'referer', 'referrer'])
const LOGIN_FAILURE_DELAY_MS = 250
const MAX_TRACKED_LOGIN_IPS = 4096
/** Mirrors the createSessionStore default so a caller that omits
 *  sessionMaxAgeSeconds still gets a valid cookie Max-Age. */
const DEFAULT_SESSION_MAX_AGE_SECONDS = 30 * 24 * 3600

/**
 * The last address in an X-Forwarded-For list. Empty/missing becomes undefined.
 *
 * Using the rightmost value is safer than the leftmost: a client can prepend
 * arbitrary values, but only the trusted edge can append the address it
 * actually saw. (Cloudflare-style `CF-Connecting-IP` is handled separately.)
 */
function lastForwardedIp(value: string | string[] | undefined): string | undefined {
  const text = Array.isArray(value) ? value[value.length - 1] : value
  const parts = String(text ?? '').split(',').map(part => part.trim()).filter(Boolean)
  const last = parts[parts.length - 1]
  return last === undefined || last === '' ? undefined : last
}

/** First value of a single-valued forwarding header such as CF-Connecting-IP. */
function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const text = Array.isArray(value) ? value[0] : value
  const first = String(text ?? '').split(',')[0]?.trim()
  return first === '' ? undefined : first
}

/**
 * A forwarded value is an edge claim, so only a literal, non-loopback IP is
 * accepted. `CF-Connecting-IP` is sanitized by Cloudflare's edge, but on any
 * other tunnel (ngrok/frp/SSH) the remote client can inject it themselves:
 * trusting a spoofed `127.0.0.1` would bypass the CIDR allowlist (loopback
 * is always allowed) and merge the attacker into the loopback rate-limit
 * bucket. Malformed or loopback values fall through to the next source.
 */
function trustedForwardedIp(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const ip = normalizeRemoteIp(value)
  if (isIP(ip) === 0 || isLoopbackHost(ip)) return undefined
  return ip
}

/**
 * The client IP used for CIDR checks, login rate limiting, audit and logs.
 *
 * A local tunnel (cloudflared/ngrok/frp/SSH) connects from 127.0.0.1, so the
 * socket address is not the real remote user. When the operator explicitly
 * enables `trustForwardedFor` AND the immediate peer is loopback, we trust:
 *
 * 1. `CF-Connecting-IP` when present (Cloudflare-style edge);
 * 2. otherwise the rightmost `X-Forwarded-For` value, which is the address
 *    appended by the trusted edge rather than a client-controlled prefix.
 *
 * Direct non-loopback peers are never trusted with a spoofable header.
 */
export function effectiveRemoteAddress(req: IncomingMessage, spec: RuntimeSpec): string {
  const direct = req.socket.remoteAddress ?? ''
  if (spec.trustForwardedFor === true && isLoopbackHost(direct)) {
    const cf = trustedForwardedIp(firstHeaderValue(req.headers['cf-connecting-ip']))
    if (cf !== undefined) return cf
    const forwarded = trustedForwardedIp(lastForwardedIp(req.headers['x-forwarded-for']))
    if (forwarded !== undefined) return forwarded
  }
  return direct
}

/** Login / wait pages: allow the tiny auto-submit / poll scripts. */
const GATE_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
const GATE_PAGE_HEADERS = {
  'content-security-policy': GATE_PAGE_CSP,
  'referrer-policy': 'no-referrer',
}

/**
 * Per-IP failed-login tracker with a lockout window. The fixed per-attempt
 * delay alone is parallelizable; this bounds total guessing capacity per
 * source address. Memory is bounded: past the cap, expired entries are
 * swept, and under an active spoofed-source attack the oldest entry is
 * evicted so the proxy can never be driven to unbounded memory.
 * @param {{ loginMaxAttempts?: number, loginLockoutMs?: number }} spec
 */
function createLoginTracker(spec: { loginMaxAttempts?: number, loginLockoutMs?: number }): LoginTracker {
  const maxAttempts = spec.loginMaxAttempts ?? 5
  const lockoutMs = spec.loginLockoutMs ?? 300_000
  /** @type {Map<string, { failures: number, firstFailure: number, lockedUntil?: number }>} */
  const buckets = new Map<string, { failures: number, firstFailure: number, lockedUntil?: number }>()
  const sweepExpired = (now: number) => {
    for (const [ip, bucket] of buckets) {
      if (bucket.lockedUntil !== undefined && bucket.lockedUntil <= now) buckets.delete(ip)
      else if (now - bucket.firstFailure > lockoutMs) buckets.delete(ip)
    }
  }
  return {
    /** @returns {number} seconds the client must wait; 0 means allowed. */
    check(ip: string, now = Date.now()) {
      const bucket = buckets.get(ip)
      if (bucket?.lockedUntil !== undefined) {
        if (bucket.lockedUntil > now) return Math.ceil((bucket.lockedUntil - now) / 1000)
        buckets.delete(ip)
      }
      return 0
    },
    fail(ip: string, now = Date.now()) {
      const bucket = buckets.get(ip)
      if (bucket === undefined || now - bucket.firstFailure > lockoutMs) {
        buckets.set(ip, { failures: 1, firstFailure: now })
        return
      }
      bucket.failures += 1
      if (bucket.failures >= maxAttempts) bucket.lockedUntil = now + lockoutMs
    },
    success(ip: string) {
      buckets.delete(ip)
    },
    prune(now = Date.now()) {
      if (buckets.size <= MAX_TRACKED_LOGIN_IPS) return
      sweepExpired(now)
      if (buckets.size <= MAX_TRACKED_LOGIN_IPS) return
      let oldest
      for (const entry of buckets) {
        if (oldest === undefined || entry[1].firstFailure < oldest[1].firstFailure) oldest = entry
      }
      if (oldest !== undefined) buckets.delete(oldest[0])
    },
  }
}

export function forwardHeaders(req: IncomingMessage, backendHost: string, options: { tls?: boolean, trustForwardedProto?: boolean, forwardedFor?: string } = {}) {
  const headers: Record<string, string | string[] | undefined> = {}
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase()
    if (value === undefined || value === null || lower === 'host' || HOP_BY_HOP.has(lower) || SPOOFABLE_FORWARDING.has(lower) || INTERNAL_HEADERS.has(lower)) continue
    headers[lower] = value as string | string[]
  }
  const sourceHost = req.headers.host ?? ''
  const remote = req.socket.remoteAddress ?? ''
  // Prefer the proxy's own TLS; only trust inbound x-forwarded-proto when the
  // operator opted into a trusted edge (trustForwardedProto).
  const forwardedHttps = options.trustForwardedProto === true
    && req.headers['x-forwarded-proto'] === 'https'
  const proto = options.tls === true || forwardedHttps ? 'https' : 'http'
  headers.host = backendHost
  headers.origin = `http://${backendHost}`
  // Same-origin after Host/Origin rewrite. Upstream Caddy snippets often
  // normalize this; without it a split front/API deploy can 403 privileged
  // methods even when Host looks like loopback.
  headers['sec-fetch-site'] = 'same-origin'
  headers['x-forwarded-for'] = options.forwardedFor ?? remote
  headers['x-forwarded-host'] = sourceHost
  headers['x-forwarded-proto'] = proto
  headers['x-dsh-reverse-proxy'] = '1'
  return headers
}

/** Drop hop-by-hop and set-cookie before relaying an upstream response. */
export function sanitizeResponseHeaders(headers: ProxyHeaders | undefined) {
  const out: Record<string, string | string[] | number | undefined> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    const lower = key.toLowerCase()
    if (value === undefined || value === null || lower === 'set-cookie' || HOP_BY_HOP.has(lower)) continue
    out[key] = value as string | string[] | number
  }
  return out
}

/**
 * WebSocket 101 still needs Connection/Upgrade; strip Set-Cookie and the
 * other hop-by-hop fields the HTTP path already drops.
 */
export function sanitizeUpgradeResponseHeaders(headers: ProxyHeaders | undefined) {
  const out: Record<string, string | string[] | number | undefined> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    const lower = key.toLowerCase()
    if (value === undefined || value === null || lower === 'set-cookie') continue
    if (HOP_BY_HOP.has(lower) && lower !== 'connection' && lower !== 'upgrade') continue
    out[key] = value as string | string[] | number
  }
  return out
}

function writeRawHead(socket: Duplex, statusCode: number, statusMessage: string, headers: ProxyHeaders) {
  const lines = [`HTTP/1.1 ${statusCode} ${statusMessage}`]
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${key}: ${item}`)
    } else if (value !== undefined) {
      lines.push(`${key}: ${value}`)
    }
  }
  socket.write(`${lines.join('\r\n')}\r\n\r\n`)
}

function denySocket(socket: Duplex, status = '403 Forbidden', body = 'forbidden\n') {
  socket.write(`HTTP/1.1 ${status}\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n${body}`)
  socket.destroy()
}

function drainRequest(req: IncomingMessage) {
  req.resume()
}

function proxyRequest(req: IncomingMessage, res: ServerResponse, spec: RuntimeSpec) {
  const contentLength = Number(req.headers['content-length'] ?? 0)
  if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > spec.maxRequestBytes) {
    drainRequest(req)
    res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
    res.end('request too large\n')
    return
  }
  const up = httpRequest({
    hostname: spec.backendHost,
    port: spec.backendPort,
    path: req.url,
    method: req.method,
    headers: forwardHeaders(req, spec.rewriteAuthority, {
      tls: spec.tls === true,
      trustForwardedProto: spec.trustForwardedProto === true,
      forwardedFor: effectiveRemoteAddress(req, spec),
    }),
  }, (incoming) => {
    clearTimeout(connectTimer)
    const responseHeaders = sanitizeResponseHeaders(incoming.headers)
    res.writeHead(incoming.statusCode ?? 502, responseHeaders)
    // If the upstream response stream fails mid-body, tear down the client
    // response instead of leaving it hanging.
    incoming.on('error', () => {
      if (!res.destroyed) res.destroy()
    })
    incoming.pipe(res)
  })
  spec.trackUpstream?.(up)
  const connectTimer = setTimeout(() => {
    up.destroy(new Error('upstream timeout'))
  }, spec.upstreamTimeoutMs)
  connectTimer.unref()
  up.on('error', () => {
    clearTimeout(connectTimer)
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('bad gateway\n')
    } else {
      res.destroy()
    }
  })
  // Enforce the byte limit on the stream itself: a chunked upload declares no
  // content-length, so the header check above cannot see its real size.
  let received = 0
  let overflow = false
  req.on('data', (chunk) => {
    received += chunk.length
    if (!overflow && received > spec.maxRequestBytes) {
      overflow = true
      // The upstream request is dead from here on; disarm its connect timer
      // so it cannot fire a second destroy up to upstreamTimeoutMs later.
      clearTimeout(connectTimer)
      req.unpipe(up)
      up.destroy()
      if (!res.headersSent) {
        res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
        res.end('request too large\n')
      } else {
        res.destroy()
      }
    }
  })
  // Destroy upstream only when the client abandons the exchange. `req`
  // 'close' also fires after a normal body end — that must not kill a
  // still-streaming upstream response.
  const abortUpstream = () => { up.destroy() }
  req.once('error', abortUpstream)
  req.once('aborted', abortUpstream)
  res.once('close', () => {
    if (!res.writableEnded) abortUpstream()
  })
  req.pipe(up)
}

async function handleLogin(req: IncomingMessage, res: ServerResponse, spec: RuntimeSpec) {
  const locale = loginLocale(req)
  if (req.method === 'GET') {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const queryInvite = url.searchParams.get('invite') ?? ''
    sendHtml(res, 200, loginPage(locale, '', { invite: queryInvite }), GATE_PAGE_HEADERS)
    return
  }
  if (req.method !== 'POST') {
    drainRequest(req)
    res.writeHead(405, { allow: 'GET, POST' })
    res.end()
    return
  }
  try {
    const remote = effectiveRemoteAddress(req, spec)
    if (spec.ipAllowed !== undefined && !spec.ipAllowed(remote)) {
      drainRequest(req)
      spec.audit?.('login.denied', { reason: 'cidr', remote })
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('forbidden\n')
      return
    }
    const retryAfter = spec.loginTracker.check(remote)
    if (retryAfter > 0) {
      drainRequest(req)
      spec.audit?.('login.locked', { remote, retryAfter })
      res.writeHead(429, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'retry-after': String(retryAfter),
      })
      res.end('too many attempts\n')
      return
    }
    const form = new URLSearchParams((await readBody(req, 4096)).toString('utf8'))
    const delayMs = spec.loginDelayMs ?? LOGIN_FAILURE_DELAY_MS
    // Equal delay on both success and failure so lockout-window guessing
    // cannot classify tokens by response timing alone.
    await new Promise(resolve => setTimeout(resolve, delayMs))
    const inviteCode = form.get('invite') ?? ''
    const usedInvite = inviteCode !== ''
    const authed = usedInvite
      ? spec.inviteStore?.consume(inviteCode) === true
      : safeEqual(form.get('token') ?? '', spec.accessToken)
    if (!authed) {
      spec.loginTracker.fail(remote)
      spec.loginTracker.prune()
      spec.audit?.('login.fail', { remote, via: usedInvite ? 'invite' : 'token' })
      const failCopy = usedInvite
        ? (LOGIN_COPY[locale] ?? LOGIN_COPY.zh).invalidInvite
        : (LOGIN_COPY[locale] ?? LOGIN_COPY.zh).invalidToken
      sendHtml(res, 401, loginPage(locale, failCopy), GATE_PAGE_HEADERS)
      return
    }
    spec.loginTracker.success(remote)
    const session = spec.sessionStore.login({ userAgent: req.headers['user-agent'], ip: remote })
    spec.audit?.('login.ok', {
      remote,
      sessionId: session.id,
      status: session.status,
      via: usedInvite ? 'invite' : 'token',
    })
    // Secure cookies only when this proxy terminates TLS, or when the operator
    // explicitly trusts an edge via trustForwardedProto.
    const secure = spec.tls === true
      || (spec.trustForwardedProto === true && req.headers['x-forwarded-proto'] === 'https')
    res.writeHead(303, {
      location: session.status === 'pending' ? `/_dsh_reverse_proxy/wait/${session.id}` : '/',
      'set-cookie': `${spec.cookieName}=${encodeSessionCookie(session.id, session.secret)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${spec.sessionMaxAgeSeconds}${secure ? '; Secure' : ''}`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    res.end()
  } catch {
    sendHtml(res, 400, loginPage(locale, LOGIN_COPY[locale].invalidRequest), GATE_PAGE_HEADERS)
  }
}

/**
 * Start an authenticated reverse proxy suitable for any external tunnel.
 * @param {{
 *  listenHost: string, listenPort: number, backendHost: string, backendPort: number,
 *  accessToken: string, cookieName: string, controlPrefix: string,
 *  maxRequestBytes: number, upstreamTimeoutMs: number, sessionMaxAgeSeconds: number,
 *  maxHeaderSizeBytes?: number, headersTimeoutMs?: number, keepAliveTimeoutMs?: number,
 *  loginDelayMs?: number, loginMaxAttempts?: number, loginLockoutMs?: number,
 *  sessionStore: import('./sessions.js').ReturnType<typeof import('./sessions.js').createSessionStore>,
 *  ipAllowed?: (address: string) => boolean,
 *  audit?: (event: string, fields?: Record<string, unknown>) => void,
 *  tls?: boolean | { key: string | Buffer, cert: string | Buffer },
 *  inviteStore?: { consume: (code: string) => boolean },
 *  trustForwardedProto?: boolean,
 *  trustForwardedFor?: boolean,
 *  log?: (entry: { method: string, path: string, status: number, remote: string }) => void,
 * }} spec
 * @returns {Promise<{ host: string, port: number, close: () => Promise<void> }>}
 */
export function listenProxy(spec: ProxySpec): Promise<ProxyServer> {
  // TCP still targets backendHost (even 0.0.0.0, which most kernels treat as
  // loopback). Host/Origin rewrite is a separate fact: harness's trust fence
  // only reads those headers and requires a 127/8 literal. Coupling the two
  // lets `backendHost: 0.0.0.0` silently 403 every /api call.
  const rewriteAuthority = rewriteLoopbackAuthority(spec.backendPort)
  const tlsOption = typeof spec.tls === 'object' && spec.tls !== null ? spec.tls : undefined
  const tlsEnabled = tlsOption !== undefined || spec.tls === true
  // Node's closeAllConnections() does not cover upgraded sockets (neither our
  // own client side nor our outbound upstream requests) — track both so
  // close() fully tears down WebSocket sessions.
  const upgradedSockets = new Set()
  const upstreamSockets = new Set()
  const trackUpstream = (up: ClientRequest | Duplex) => {
    upstreamSockets.add(up)
    up.once('close', () => upstreamSockets.delete(up))
  }
  const runtimeSpec = {
    ...spec,
    tls: tlsEnabled,
    trustForwardedProto: spec.trustForwardedProto === true,
    trustForwardedFor: spec.trustForwardedFor === true,
    rewriteAuthority,
    trackUpstream,
    loginTracker: createLoginTracker(spec),
    sessionStore: spec.sessionStore ?? createSessionStore({ maxAgeSeconds: spec.sessionMaxAgeSeconds }),
    sessionMaxAgeSeconds: spec.sessionMaxAgeSeconds ?? DEFAULT_SESSION_MAX_AGE_SECONDS,
  }
  const upgradeTracker = createLoginTracker({
    loginMaxAttempts: spec.upgradeMaxAttempts ?? 10,
    loginLockoutMs: spec.upgradeLockoutMs ?? 300_000,
  })
  const denyCidr = (req: IncomingMessage, res: ServerResponse): boolean => {
    const remote = effectiveRemoteAddress(req, runtimeSpec)
    if (spec.ipAllowed === undefined || spec.ipAllowed(remote)) return false
    spec.audit?.('access.denied', { reason: 'cidr', remote, path: req.url ?? '/' })
    drainRequest(req)
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end('forbidden\n')
    return true
  }
  const logRequest = spec.log === undefined ? undefined : (req: IncomingMessage, res: ServerResponse) => {
    res.once('finish', () => {
      spec.log!({ method: req.method, path: req.url ?? '/', status: res.statusCode, remote: effectiveRemoteAddress(req, runtimeSpec) })
    })
  }
  const onRequest = async (req: IncomingMessage, res: ServerResponse) => {
    logRequest?.(req, res)
    const path = pathnameOf(req.url)
    const cookie = parseCookies(req.headers.cookie)[spec.cookieName]
    // healthz sits behind the CIDR gate so a public probe cannot map the
    // listener when an allowlist is configured.
    if (denyCidr(req, res)) return
    if (path === '/_dsh_reverse_proxy/healthz') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end('{"ok":true}\n')
      return
    }
    if (path === LOGIN_PATH) {
      await handleLogin(req, res, runtimeSpec)
      return
    }
    const waitStatus = path.match(/^\/_dsh_reverse_proxy\/wait\/([^/]+)\/status$/)
    if (waitStatus !== null && req.method === 'GET') {
      const session = runtimeSpec.sessionStore.pending(cookie, waitStatus[1])
      const body = session === undefined
        ? '{"status":"unknown"}\n'
        : `{"status":"${session.status}"}\n`
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
      return
    }
    const waitPageMatch = path.match(/^\/_dsh_reverse_proxy\/wait\/([^/]+)$/)
    if (waitPageMatch !== null && req.method === 'GET') {
      const session = runtimeSpec.sessionStore.pending(cookie, waitPageMatch[1])
      if (session === undefined) {
        res.writeHead(303, { location: LOGIN_PATH, 'cache-control': 'no-store' })
        res.end()
        return
      }
      if (session.status === 'active') {
        res.writeHead(303, { location: '/', 'cache-control': 'no-store' })
        res.end()
        return
      }
      sendHtml(res, 200, waitPage(loginLocale(req), session.id, session.label), GATE_PAGE_HEADERS)
      return
    }
    if (path.startsWith(spec.controlPrefix)) {
      drainRequest(req)
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('forbidden\n')
      return
    }
    if (runtimeSpec.sessionStore.validate(cookie, effectiveRemoteAddress(req, runtimeSpec)) === undefined) {
      drainRequest(req)
      if (req.method === 'GET' || req.method === 'HEAD') {
        res.writeHead(303, { location: LOGIN_PATH, 'cache-control': 'no-store' })
        res.end()
      } else {
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end('{"error":"authentication-required"}\n')
      }
      return
    }
    proxyRequest(req, res, runtimeSpec)
  }

  const serverOptions = {
    maxHeaderSize: spec.maxHeaderSizeBytes ?? 16 * 1024,
    // Bound hung clients; 0 previously left keep-alive sockets forever.
    // Node requires requestTimeout >= headersTimeout, so never let a user
    // configured headersTimeout exceed the effective request timeout.
    requestTimeout: Math.max(spec.requestTimeoutMs ?? 120_000, spec.headersTimeoutMs ?? 15_000),
    headersTimeout: spec.headersTimeoutMs ?? 15_000,
    keepAliveTimeout: spec.keepAliveTimeoutMs ?? 5_000,
  }
  const server = tlsOption !== undefined
    ? createHttpsServer({ ...serverOptions, key: tlsOption.key, cert: tlsOption.cert }, onRequest)
    : createServer(serverOptions, onRequest)

  server.on('upgrade', (req, socket, head) => {
    upgradedSockets.add(socket)
    socket.once('close', () => upgradedSockets.delete(socket))
    const upgradeRemote = effectiveRemoteAddress(req, runtimeSpec)
    if (spec.ipAllowed !== undefined && !spec.ipAllowed(upgradeRemote)) {
      denySocket(socket, '403 Forbidden')
      spec.audit?.('access.denied', { reason: 'cidr', remote: upgradeRemote, path: req.url ?? '/', upgrade: true })
      return
    }
    const upgradeRetryAfter = upgradeTracker.check(upgradeRemote)
    if (upgradeRetryAfter > 0) {
      denySocket(socket, '429 Too Many Requests', 'too many requests\n')
      spec.audit?.('upgrade.locked', { remote: upgradeRemote, retryAfter: upgradeRetryAfter, path: req.url ?? '/', upgrade: true })
      return
    }
    const path = pathnameOf(req.url)
    const cookie = parseCookies(req.headers.cookie)[spec.cookieName]
    if (path.startsWith(spec.controlPrefix) || runtimeSpec.sessionStore.validate(cookie, upgradeRemote) === undefined) {
      upgradeTracker.fail(upgradeRemote)
      denySocket(socket, '401 Unauthorized')
      spec.audit?.('access.denied', { reason: 'auth', remote: upgradeRemote, path: req.url ?? '/', upgrade: true })
      spec.log?.({ method: req.method, path: req.url ?? '/', status: 401, remote: upgradeRemote })
      return
    }
    const headers = forwardHeaders(req, rewriteAuthority, {
      tls: tlsEnabled,
      trustForwardedProto: spec.trustForwardedProto === true,
      forwardedFor: upgradeRemote,
    })
    headers.connection = 'Upgrade'
    headers.upgrade = req.headers.upgrade ?? 'websocket'
    const up = httpRequest({
      hostname: spec.backendHost,
      port: spec.backendPort,
      path: req.url,
      method: 'GET',
      headers,
    })
    trackUpstream(up)
    up.setTimeout(spec.upstreamTimeoutMs, () => { up.destroy() })
    up.on('upgrade', (upRes, upSocket, upHead) => {
      // After a successful upgrade Node detaches the socket from the request,
      // so req.destroy() would leave it open — track the socket itself too.
      trackUpstream(upSocket)
      upgradeTracker.success(upgradeRemote)
      spec.audit?.('ws.open', { remote: upgradeRemote, path: req.url ?? '/', status: upRes.statusCode ?? 101 })
      spec.log?.({ method: req.method, path: req.url ?? '/', status: upRes.statusCode ?? 101, remote: upgradeRemote })
      writeRawHead(
        socket,
        upRes.statusCode ?? 101,
        upRes.statusMessage ?? 'Switching Protocols',
        sanitizeUpgradeResponseHeaders(upRes.headers),
      )
      if (upHead.length > 0) socket.write(upHead)
      if (head.length > 0) upSocket.write(head)
      upSocket.pipe(socket)
      socket.pipe(upSocket)
    })
    // Upstream answered without upgrading (non-101): relay the status line
    // and close instead of leaving the client socket hanging.
    up.on('response', (upRes) => {
      spec.audit?.('ws.reject', { remote: upgradeRemote, path: req.url ?? '/', status: upRes.statusCode ?? 502 })
      // Drain the upstream response so its socket is not left hanging.
      upRes.resume()
      writeRawHead(socket, upRes.statusCode ?? 502, upRes.statusMessage ?? 'Bad Gateway', {
        ...sanitizeResponseHeaders(upRes.headers),
        Connection: 'close',
      })
      socket.destroy()
    })
    up.on('error', () => { socket.destroy() })
    socket.on('error', () => { up.destroy() })
    up.end()
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(spec.listenPort, spec.listenHost, () => {
      server.off('error', reject)
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : spec.listenPort
      let closed = false
      resolve({
        host: spec.listenHost,
        port,
        close: () => new Promise<void>((done, closeReject) => {
          // Idempotent: runtime rollback paths may race a second close.
          if (closed) {
            done()
            return
          }
          closed = true
          // Tear down live sockets first so server.close() is not waiting on
          // SSE / keep-alive / leftover upgrades. If close still hangs (a
          // half-open peer that ignore FIN), the grace timer unblocks rotate
          // and stop instead of freezing the serial gate forever.
          for (const socket of upgradedSockets) (socket as { destroy(): void }).destroy()
          for (const up of upstreamSockets) (up as { destroy(): void }).destroy()
          server.closeAllConnections?.()
          let settled = false
          const finish = (error?: Error) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (error === undefined) done()
            else closeReject(error)
          }
          const timer = setTimeout(() => {
            // Grace expired: force remaining connections again, then only
            // resolve as success when the listener is actually gone.
            for (const socket of upgradedSockets) (socket as { destroy(): void }).destroy()
            for (const up of upstreamSockets) (up as { destroy(): void }).destroy()
            server.closeAllConnections?.()
            if (server.listening) finish(new Error('close-timeout'))
            else finish()
          }, 2_000)
          timer.unref?.()
          server.close(error => finish(error ?? undefined))
        }),
      })
    })
  })
}
