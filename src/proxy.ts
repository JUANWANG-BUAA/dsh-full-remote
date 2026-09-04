/**
 * proxy — the authenticated local reverse-proxy server.
 *
 * One Node http.Server in front of the DeepSeek Harness Web backend:
 * login gate (token + per-device session), optional approval wait pages,
 * header sanitization, stream-level body limits, and full WebSocket/SSE
 * upgrade forwarding with both-end teardown on close.
 *
 * All user-facing copy is delegated to pages.ts; session state lives in the
 * caller-supplied session store (defaults to an in-memory one).
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse, type ClientRequest } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { Duplex } from 'node:stream'
import { createGzip } from 'node:zlib'
import { parseCookies, safeEqual } from './security.ts'
import { createSessionStore, encodeSessionCookie, sessionCookie, SessionCapacityError } from './sessions.ts'
import { readBody, sendHtml, pathnameOf, rewriteLoopbackAuthority } from './http-util.ts'
import {
  applyGzipResponseHeaders,
  gzipDecisionFromUpstream,
  maybeSetHashedAssetCacheControl,
} from './proxy-compress.ts'
import {
  cookieIsSecure,
  effectiveRemoteAddress,
  forwardHeaders,
  sanitizeResponseHeaders,
  sanitizeUpgradeResponseHeaders,
  type ProxyHeaders,
} from './proxy-headers.ts'
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_HEADERS_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from './limits.ts'
export { effectiveRemoteAddress, forwardHeaders, sanitizeResponseHeaders, sanitizeUpgradeResponseHeaders } from './proxy-headers.ts'
import {
  HOME_PATH,
  HOME_RENAME_PATH,
  HEALTHZ_PATH,
  LOGIN_COPY,
  LOGIN_PATH,
  LOGOUT_PATH,
  homePage,
  loginLocale,
  loginPage,
  parseWaitPath,
  waitPage,
  waitPagePath,
} from './pages.ts'

/** Per-IP failed-login tracker surface. */
interface LoginTracker {
  check(ip: string, now?: number): number
  reserve(ip: string, now?: number): number
  fail(ip: string, now?: number): void
  success(ip: string): void
  prune(now?: number): void
}

/** The bound proxy server handle returned to the runtime. */
export interface ProxyServer {
  host: string
  port: number
  close: () => Promise<void>
  closeSession: (sessionId: string) => void
}

/** Minimal host-side auth surface added by Harness 0.1.2. */
export interface BackendBrowserAuth {
  authenticatedUrl(baseUrl: string): string
}

/** Input needed to mint the internal Harness browser-session cookie. */
export interface BootstrapUpstreamCookieOptions {
  backendHost: string
  backendPort: number
  auth: BackendBrowserAuth
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
  /** First-byte wait for host command POSTs such as `/api/commands/execute`. Defaults to the same 5-minute window as `requestTimeoutMs`. */
  commandTimeoutMs?: number
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
  inviteStore?: {
    consume: (code: string, ip?: string) => { ok: boolean, retry?: boolean, sessionId?: string }
    bindSession?: (code: string, sessionId: string) => void
  }
  /** Static boolean, or a per-request probe so a tunnel can toggle trust without restarting the proxy. */
  trustForwardedProto?: boolean | (() => boolean)
  /** When truthy and the direct peer is loopback, derive the remote client IP from the rightmost X-Forwarded-For value for CIDR / rate limiting / audit. Only enable behind a trusted local tunnel/edge. Static boolean or per-request probe. */
  trustForwardedFor?: boolean | (() => boolean)
  /** Trust Cloudflare's proprietary client-IP header from a trusted loopback Cloudflare connector. Kept separate from generic XFF trust because other tunnel providers can relay a client-supplied CF header unchanged. */
  trustCloudflareConnectingIp?: boolean | (() => boolean)
  /** Display-only: shown on the device home page as part of the security posture. */
  approvalMode?: boolean
  log?: (entry: { method: string | undefined, path: string, status: number, remote: string }) => void
  /** Gzip compressible HTTP responses when the client advertises gzip. Default true. */
  compressResponses?: boolean
  /** Add immutable Cache-Control on hashed /assets/* 200s with no upstream cache header. Default true. */
  cacheHashedAssets?: boolean
  /** Browser-session cookie for Harness 0.1.2+; omitted on older Harness builds. */
  upstreamCookie?: string
}

/** ProxySpec after listenProxy resolves defaults and internal helpers. */
type RuntimeSpec = Omit<ProxySpec, 'trustForwardedProto' | 'trustForwardedFor' | 'trustCloudflareConnectingIp'> & {
  tls: boolean
  /** Normalized probes, evaluated per request. */
  trustForwardedProto: () => boolean
  trustForwardedFor: () => boolean
  trustCloudflareConnectingIp: () => boolean
  rewriteAuthority: string
  trackUpstream: (up: ClientRequest | Duplex) => void
  loginTracker: LoginTracker
  sessionStore: ReturnType<typeof createSessionStore>
  /** Resolved (never undefined) so the login cookie always gets a numeric Max-Age. */
  sessionMaxAgeSeconds: number
  trackSession: (sessionId: string, close: () => void) => () => void
  closeSessionConnections: (sessionId: string) => void
  compressResponses: boolean
  cacheHashedAssets: boolean
}

const LOGIN_FAILURE_DELAY_MS = 250
const MAX_TRACKED_LOGIN_IPS = 4096
/** Mirrors the createSessionStore default so a caller that omits
 *  sessionMaxAgeSeconds still gets a valid cookie Max-Age. */
const DEFAULT_SESSION_MAX_AGE_SECONDS = 30 * 24 * 3600

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
  /** @type {Map<string, { failures: number, inFlight: number, firstFailure: number, lockedUntil?: number }>} */
  const buckets = new Map<string, { failures: number, inFlight: number, firstFailure: number, lockedUntil?: number }>()
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
    /** Reserve one attempt before reading a body or awaiting the delay. */
    reserve(ip: string, now = Date.now()) {
      const existing = buckets.get(ip)
      const bucket = existing === undefined || now - existing.firstFailure > lockoutMs
        ? { failures: 0, inFlight: 0, firstFailure: now }
        : existing
      if (bucket.lockedUntil !== undefined && bucket.lockedUntil > now) {
        return Math.ceil((bucket.lockedUntil - now) / 1000)
      }
      if (bucket.failures + bucket.inFlight >= maxAttempts) {
        bucket.lockedUntil = now + lockoutMs
        buckets.set(ip, bucket)
        return Math.ceil(lockoutMs / 1000)
      }
      bucket.inFlight += 1
      buckets.set(ip, bucket)
      return 0
    },
    fail(ip: string, now = Date.now()) {
      const bucket = buckets.get(ip)
      if (bucket === undefined || now - bucket.firstFailure > lockoutMs) {
        buckets.set(ip, { failures: 1, inFlight: 0, firstFailure: now })
        return
      }
      bucket.inFlight = Math.max(0, bucket.inFlight - 1)
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

function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  extra: Record<string, string | number> = {},
) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...extra,
  })
  res.end(body)
}

function redirect(res: ServerResponse, location: string, extra: Record<string, string | number | string[]> = {}) {
  res.writeHead(303, { location, 'cache-control': 'no-store', ...extra })
  res.end()
}

/**
 * Deadline for establishing TCP to the loopback Harness backend.
 * Cleared as soon as the socket is connected (including keep-alive reuse).
 * Must not cover body transfer: Harness buffers `/api` JSON (vision images)
 * before it writes response headers, and a phone tunnel can take longer than
 * `upstreamTimeoutMs` to push those bytes.
 */
function armUpstreamConnectTimeout(up: ClientRequest, timeoutMs: number): () => void {
  const timer = setTimeout(() => {
    up.destroy(new Error('upstream timeout'))
  }, timeoutMs)
  timer.unref()
  const clear = () => { clearTimeout(timer) }
  up.once('socket', (socket) => {
    if (!socket.connecting) {
      clear()
      return
    }
    socket.once('connect', clear)
    socket.once('error', clear)
  })
  up.once('error', clear)
  up.once('response', clear)
  return clear
}

/**
 * Host command POSTs are long-running by design in Harness: `/compact` and
 * similar handlers can take much longer than the default 15s first-byte
 * transport deadline before the backend writes a response header. Those
 * requests get the longer `commandTimeoutMs` first-byte window.
 */
function isCommandExecutePath(url: string | undefined): boolean {
  return pathnameOf(url) === '/api/commands/execute'
}

function inboundMethodHasBody(method: string | undefined): boolean {
  const verb = (method ?? 'GET').toUpperCase()
  return verb !== 'GET' && verb !== 'HEAD'
}

/** After the client finishes a POST body, wait this long for upstream headers. */
function armUpstreamFirstByteTimeout(
  up: ClientRequest,
  timeoutMs: number,
  alreadyResponded: () => boolean,
): () => void {
  if (alreadyResponded()) return () => {}
  const timer = setTimeout(() => {
    up.destroy(new Error('upstream timeout'))
  }, timeoutMs)
  timer.unref()
  const clear = () => { clearTimeout(timer) }
  up.once('response', clear)
  up.once('error', clear)
  up.once('close', clear)
  return clear
}

function pipeUpstreamBody(incoming: IncomingMessage, res: ServerResponse, gzip: boolean) {
  if (!gzip) {
    incoming.on('error', () => {
      if (!res.destroyed) res.destroy()
    })
    incoming.pipe(res)
    return
  }
  const gzipStream = createGzip({ level: 6 })
  incoming.on('error', () => {
    gzipStream.destroy()
    if (!res.destroyed) res.destroy()
  })
  gzipStream.on('error', () => {
    incoming.destroy()
    if (!res.destroyed) res.destroy()
  })
  incoming.pipe(gzipStream).pipe(res)
}

/**
 * Exchange Harness's process launch token for its browser-session cookie.
 * Harness 0.1.2 authenticates the Web index and every `/api` request with
 * this cookie, while older releases simply have no `authenticatedUrl` method
 * and therefore never call this compatibility path.
 */
export function bootstrapUpstreamCookie(options: BootstrapUpstreamCookieOptions): Promise<string> {
  const authority = rewriteLoopbackAuthority(options.backendPort)
  let launchUrl: URL
  try {
    launchUrl = new URL(options.auth.authenticatedUrl(`http://${authority}`))
  } catch (error) {
    return Promise.reject(new Error('reverse-proxy: Harness returned an invalid authenticated URL', { cause: error }))
  }
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: options.backendHost,
      port: options.backendPort,
      method: 'GET',
      path: `${launchUrl.pathname}${launchUrl.search}`,
      headers: {
        host: authority,
        connection: 'close',
      },
    }, (response) => {
      const setCookies = response.headers['set-cookie'] ?? []
      const cookie = setCookies.find(value => value.includes('='))?.split(';', 1)[0]
      const status = response.statusCode ?? 0
      response.once('end', () => {
        if (status >= 300 && status < 400 && cookie !== undefined) {
          resolve(cookie)
          return
        }
        reject(new Error(`reverse-proxy: Harness browser-session exchange failed with HTTP ${String(status)}`))
      })
      response.resume()
    })
    request.once('error', reject)
    request.end()
  })
}

function proxyRequest(req: IncomingMessage, res: ServerResponse, spec: RuntimeSpec, sessionId: string) {
  const contentLength = Number(req.headers['content-length'] ?? 0)
  if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > spec.maxRequestBytes) {
    drainRequest(req)
    sendText(res, 413, 'request too large\n', { connection: 'close' })
    return
  }
  const up = httpRequest({
    hostname: spec.backendHost,
    port: spec.backendPort,
    path: req.url,
    method: req.method,
    headers: forwardHeaders(req, spec.rewriteAuthority, {
      tls: spec.tls === true,
      trustForwardedProto: spec.trustForwardedProto(),
      forwardedFor: effectiveRemoteAddress(req, spec),
      upstreamCookie: spec.upstreamCookie,
    }),
  }, (incoming) => {
    clearConnectTimeout()
    const status = incoming.statusCode ?? 502
    const responseHeaders = sanitizeResponseHeaders(incoming.headers)
    maybeSetHashedAssetCacheControl(
      responseHeaders,
      pathnameOf(req.url),
      status,
      spec.cacheHashedAssets,
    )
    const gzip = gzipDecisionFromUpstream(req, { statusCode: status, headers: responseHeaders }, spec.compressResponses)
    if (gzip) applyGzipResponseHeaders(responseHeaders)
    res.writeHead(status, responseHeaders)
    pipeUpstreamBody(incoming, res, gzip)
  })
  spec.trackUpstream?.(up)
  const releaseSession = spec.trackSession(sessionId, () => {
    up.destroy()
    if (!res.destroyed) res.destroy()
  })
  res.once('close', releaseSession)
  up.once('close', releaseSession)
  const clearConnectTimeout = armUpstreamConnectTimeout(up, spec.upstreamTimeoutMs)
  up.on('error', () => {
    clearConnectTimeout()
    if (!res.headersSent) {
      sendText(res, 502, 'bad gateway\n')
    } else {
      res.destroy()
    }
  })
  // Enforce the byte limit on the stream itself: a chunked upload declares no
  // content-length, so the header check above cannot see its real size.
  let received = 0
  let overflow = false
  req.on('data', (chunk) => {
    if (overflow) return
    received += chunk.length
    if (received > spec.maxRequestBytes) {
      overflow = true
      // The upstream request is dead from here on; disarm its connect timer
      // so it cannot fire a second destroy up to upstreamTimeoutMs later.
      clearConnectTimeout()
      req.unpipe(up)
      // Drain the remainder so the 413 below can flush past TCP backpressure
      // instead of stalling behind a full socket buffer the client cannot
      // finish writing into. Draining is cheap: the guard above short-circuits.
      drainRequest(req)
      up.destroy()
      if (!res.headersSent) {
        sendText(res, 413, 'request too large\n', { connection: 'close' })
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
  if (inboundMethodHasBody(req.method)) {
    req.once('end', () => {
      if (overflow || res.headersSent) return
      const firstByteTimeoutMs = isCommandExecutePath(req.url)
        ? (spec.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS)
        : spec.upstreamTimeoutMs
      armUpstreamFirstByteTimeout(up, firstByteTimeoutMs, () => res.headersSent)
    })
  }
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
  let reserved = false
  try {
    const remote = effectiveRemoteAddress(req, spec)
    if (spec.ipAllowed !== undefined && !spec.ipAllowed(remote)) {
      drainRequest(req)
      spec.audit?.('login.denied', { reason: 'cidr', remote })
      sendText(res, 403, 'forbidden\n')
      return
    }
    const retryAfter = spec.loginTracker.reserve(remote)
    if (retryAfter > 0) {
      drainRequest(req)
      spec.audit?.('login.locked', { remote, retryAfter })
      sendText(res, 429, 'too many attempts\n', { 'retry-after': String(retryAfter) })
      return
    }
    reserved = true
    const form = new URLSearchParams((await readBody(req, 4096)).toString('utf8'))
    const delayMs = spec.loginDelayMs ?? LOGIN_FAILURE_DELAY_MS
    // Equal delay on both success and failure so lockout-window guessing
    // cannot classify tokens by response timing alone.
    await new Promise(resolve => setTimeout(resolve, delayMs))
    const inviteCode = form.get('invite') ?? ''
    const usedInvite = inviteCode !== ''
    // remote = effectiveRemoteAddress: under an active tunnel this is the
    // real client IP, which the retry grace matches against.
    const consumed = usedInvite ? spec.inviteStore?.consume(inviteCode, remote) : undefined
    const authed = usedInvite
      ? consumed?.ok === true
      : safeEqual(form.get('token') ?? '', spec.accessToken)
    if (!authed) {
      spec.loginTracker.fail(remote)
      reserved = false
      spec.loginTracker.prune()
      spec.audit?.('login.fail', { remote, via: usedInvite ? 'invite' : 'token' })
      const failCopy = usedInvite
        ? (LOGIN_COPY[locale] ?? LOGIN_COPY.zh).invalidInvite
        : (LOGIN_COPY[locale] ?? LOGIN_COPY.zh).invalidToken
      sendHtml(res, 401, loginPage(locale, failCopy), GATE_PAGE_HEADERS)
      return
    }
    spec.loginTracker.success(remote)
    reserved = false
    let session
    if (usedInvite && consumed?.retry === true) {
      session = consumed.sessionId !== undefined
        ? spec.sessionStore.reissue(consumed.sessionId, remote)
        : undefined
      if (session === undefined) {
        spec.audit?.('login.fail', { remote, via: 'invite', reason: 'retry-session-gone' })
        sendHtml(res, 401, loginPage(locale, (LOGIN_COPY[locale] ?? LOGIN_COPY.zh).invalidInvite), GATE_PAGE_HEADERS)
        return
      }
    } else {
      try {
        session = spec.sessionStore.login({ userAgent: req.headers['user-agent'], ip: remote })
      } catch (error) {
        if (!(error instanceof SessionCapacityError)) throw error
        spec.audit?.('login.fail', { remote, via: 'token', reason: 'session-capacity' })
        sendText(res, 429, 'too many devices\n', { 'retry-after': '10' })
        return
      }
      if (usedInvite) spec.inviteStore?.bindSession?.(inviteCode, session.id)
    }
    spec.audit?.('login.ok', {
      remote,
      sessionId: session.id,
      status: session.status,
      via: usedInvite ? 'invite' : 'token',
      ...(consumed?.retry === true ? { retry: true } : {}),
    })
    const secure = cookieIsSecure(req, spec)
    redirect(res, session.status === 'pending'
      ? waitPagePath(session.id)
      : form.get('next') === 'home' ? HOME_PATH : '/', {
      'set-cookie': sessionCookie(spec.cookieName, encodeSessionCookie(session.id, session.secret), {
        maxAgeSeconds: spec.sessionMaxAgeSeconds,
        secure,
      }),
      'referrer-policy': 'no-referrer',
    })
  } catch {
    if (reserved) spec.loginTracker.fail(effectiveRemoteAddress(req, spec))
    sendHtml(res, 400, loginPage(locale, LOGIN_COPY[locale].invalidRequest), GATE_PAGE_HEADERS)
  }
}

function handleWaitRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  spec: RuntimeSpec,
  path: string,
  cookie: string | undefined,
): boolean {
  const wait = parseWaitPath(path)
  if (wait === undefined || req.method !== 'GET') return false
  const session = spec.sessionStore.pending(cookie, wait.id)
  if (wait.kind === 'status') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(`${JSON.stringify({ status: session?.status ?? 'unknown' })}\n`)
    return true
  }
  if (session === undefined) {
    redirect(res, LOGIN_PATH)
    return true
  }
  if (session.status === 'active') {
    redirect(res, '/')
    return true
  }
  sendHtml(res, 200, waitPage(loginLocale(req), session.id, session.label), GATE_PAGE_HEADERS)
  return true
}

async function handleDevicePages(
  req: IncomingMessage,
  res: ServerResponse,
  spec: RuntimeSpec,
  path: string,
  cookie: string | undefined,
): Promise<boolean> {
  if (path === HOME_PATH && req.method === 'GET') {
    const session = spec.sessionStore.validate(cookie, effectiveRemoteAddress(req, spec))
    if (session === undefined) {
      drainRequest(req)
      redirect(res, LOGIN_PATH)
      return true
    }
    sendHtml(res, 200, homePage(loginLocale(req), {
      host: req.headers.host ?? '',
      label: session.label,
      ...(session.createdIp !== undefined ? { createdIp: session.createdIp } : {}),
      createdAt: session.createdAt,
      sessionMaxAgeSeconds: spec.sessionMaxAgeSeconds,
      approvalMode: spec.approvalMode === true,
    }), GATE_PAGE_HEADERS)
    return true
  }
  if (path === HOME_RENAME_PATH && req.method === 'POST') {
    const remote = effectiveRemoteAddress(req, spec)
    const session = spec.sessionStore.validate(cookie, remote)
    if (session === undefined) {
      drainRequest(req)
      redirect(res, LOGIN_PATH)
      return true
    }
    try {
      const form = new URLSearchParams((await readBody(req, 4096)).toString('utf8'))
      if (spec.sessionStore.rename(session.id, form.get('label') ?? undefined)) {
        spec.audit?.('session.rename', { remote, sessionId: session.id, self: true })
      }
    } catch {
      drainRequest(req)
    }
    redirect(res, HOME_PATH)
    return true
  }
  if (path === LOGOUT_PATH && req.method === 'POST') {
    const remote = effectiveRemoteAddress(req, spec)
    const session = spec.sessionStore.validate(cookie, remote)
    if (session !== undefined) {
      spec.sessionStore.revoke(session.id)
      spec.closeSessionConnections(session.id)
      spec.audit?.('session.logout', { remote, sessionId: session.id })
    } else {
      drainRequest(req)
    }
    // Expire the cookie even when the session was already gone: a stale
    // cookie should never survive an explicit sign-out. Repeat Secure when
    // the original login cookie had it, or an HTTPS browser keeps the old one.
    redirect(res, LOGIN_PATH, {
      'set-cookie': sessionCookie(spec.cookieName, '', {
        maxAgeSeconds: 0,
        secure: cookieIsSecure(req, spec),
      }),
      'referrer-policy': 'no-referrer',
    })
    return true
  }
  return false
}

/**
 * Start an authenticated reverse proxy suitable for any external tunnel.
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
  const sessionConnections = new Map<string, Set<() => void>>()
  const trackSession = (sessionId: string, close: () => void) => {
    const connections = sessionConnections.get(sessionId) ?? new Set<() => void>()
    connections.add(close)
    sessionConnections.set(sessionId, connections)
    return () => {
      connections.delete(close)
      if (connections.size === 0) sessionConnections.delete(sessionId)
    }
  }
  const closeSessionConnections = (sessionId: string) => {
    const connections = sessionConnections.get(sessionId)
    if (connections === undefined) return
    sessionConnections.delete(sessionId)
    for (const close of connections) close()
  }
  const trackUpstream = (up: ClientRequest | Duplex) => {
    upstreamSockets.add(up)
    up.once('close', () => upstreamSockets.delete(up))
  }
  const runtimeSpec: RuntimeSpec = {
    ...spec,
    tls: tlsEnabled,
    trustForwardedProto: typeof spec.trustForwardedProto === 'function'
      ? spec.trustForwardedProto
      : () => spec.trustForwardedProto === true,
    trustForwardedFor: typeof spec.trustForwardedFor === 'function'
      ? spec.trustForwardedFor
      : () => spec.trustForwardedFor === true,
    trustCloudflareConnectingIp: typeof spec.trustCloudflareConnectingIp === 'function'
      ? spec.trustCloudflareConnectingIp
      : () => spec.trustCloudflareConnectingIp === true,
    rewriteAuthority,
    trackUpstream,
    loginTracker: createLoginTracker(spec),
    sessionStore: spec.sessionStore ?? createSessionStore({ maxAgeSeconds: spec.sessionMaxAgeSeconds }),
    sessionMaxAgeSeconds: spec.sessionMaxAgeSeconds ?? DEFAULT_SESSION_MAX_AGE_SECONDS,
    trackSession,
    closeSessionConnections,
    compressResponses: spec.compressResponses !== false,
    cacheHashedAssets: spec.cacheHashedAssets !== false,
  }
  const upgradeTracker = createLoginTracker({
    loginMaxAttempts: spec.upgradeMaxAttempts ?? 10,
    loginLockoutMs: spec.upgradeLockoutMs ?? 300_000,
  })
  const denyCidr = (req: IncomingMessage, res: ServerResponse): boolean => {
    const remote = effectiveRemoteAddress(req, runtimeSpec)
    if (spec.ipAllowed === undefined || spec.ipAllowed(remote)) return false
    spec.audit?.('access.denied', { reason: 'cidr', remote, path: pathnameOf(req.url) })
    drainRequest(req)
    sendText(res, 403, 'forbidden\n')
    return true
  }
  const logRequest = spec.log === undefined ? undefined : (req: IncomingMessage, res: ServerResponse) => {
    res.once('finish', () => {
      spec.log!({ method: req.method, path: pathnameOf(req.url), status: res.statusCode, remote: effectiveRemoteAddress(req, runtimeSpec) })
    })
  }
  const onRequest = async (req: IncomingMessage, res: ServerResponse) => {
    logRequest?.(req, res)
    const path = pathnameOf(req.url)
    const cookie = parseCookies(req.headers.cookie)[spec.cookieName]
    // healthz sits behind the CIDR gate so a public probe cannot map the
    // listener when an allowlist is configured.
    if (denyCidr(req, res)) return
    if (path === HEALTHZ_PATH) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end('{"ok":true}\n')
      return
    }
    if (path === LOGIN_PATH) {
      await handleLogin(req, res, runtimeSpec)
      return
    }
    if (handleWaitRoutes(req, res, runtimeSpec, path, cookie)) return
    if (await handleDevicePages(req, res, runtimeSpec, path, cookie)) return
    if (path.startsWith(spec.controlPrefix)) {
      drainRequest(req)
      sendText(res, 403, 'forbidden\n')
      return
    }
    const session = runtimeSpec.sessionStore.validate(cookie, effectiveRemoteAddress(req, runtimeSpec))
    if (session === undefined) {
      drainRequest(req)
      if (req.method === 'GET' || req.method === 'HEAD') {
        redirect(res, LOGIN_PATH)
      } else {
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end('{"error":"authentication-required"}\n')
      }
      return
    }
    proxyRequest(req, res, runtimeSpec, session.id)
  }

  const serverOptions = {
    maxHeaderSize: spec.maxHeaderSizeBytes ?? 16 * 1024,
    // Bound hung clients; 0 previously left keep-alive sockets forever.
    // Node requires requestTimeout >= headersTimeout, so never let a user
    // configured headersTimeout exceed the effective request timeout.
    requestTimeout: Math.max(spec.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, spec.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS),
    headersTimeout: spec.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS,
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
      spec.audit?.('access.denied', { reason: 'cidr', remote: upgradeRemote, path: pathnameOf(req.url), upgrade: true })
      return
    }
    const upgradeRetryAfter = upgradeTracker.check(upgradeRemote)
    if (upgradeRetryAfter > 0) {
      denySocket(socket, '429 Too Many Requests', 'too many requests\n')
      spec.audit?.('upgrade.locked', { remote: upgradeRemote, retryAfter: upgradeRetryAfter, path: pathnameOf(req.url), upgrade: true })
      return
    }
    const path = pathnameOf(req.url)
    const cookie = parseCookies(req.headers.cookie)[spec.cookieName]
    const session = runtimeSpec.sessionStore.validate(cookie, upgradeRemote)
    if (path.startsWith(spec.controlPrefix) || session === undefined) {
      upgradeTracker.fail(upgradeRemote)
      upgradeTracker.prune()
      denySocket(socket, '401 Unauthorized')
      spec.audit?.('access.denied', { reason: 'auth', remote: upgradeRemote, path: pathnameOf(req.url), upgrade: true })
      spec.log?.({ method: req.method, path: pathnameOf(req.url), status: 401, remote: upgradeRemote })
      return
    }
    const headers = forwardHeaders(req, rewriteAuthority, {
      tls: tlsEnabled,
      trustForwardedProto: runtimeSpec.trustForwardedProto(),
      forwardedFor: upgradeRemote,
      upstreamCookie: runtimeSpec.upstreamCookie,
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
    const releaseSession = session === undefined
      ? undefined
      : runtimeSpec.trackSession(session.id, () => {
          socket.destroy()
          up.destroy()
        })
    if (releaseSession !== undefined) socket.once('close', releaseSession)
    up.setTimeout(spec.upstreamTimeoutMs, () => { up.destroy() })
    up.on('upgrade', (upRes, upSocket, upHead) => {
      // After a successful upgrade Node detaches the socket from the request,
      // so req.destroy() would leave it open — track the socket itself too.
      trackUpstream(upSocket)
      upgradeTracker.success(upgradeRemote)
      spec.audit?.('ws.open', { remote: upgradeRemote, path: pathnameOf(req.url), status: upRes.statusCode ?? 101 })
      spec.log?.({ method: req.method, path: pathnameOf(req.url), status: upRes.statusCode ?? 101, remote: upgradeRemote })
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
      spec.audit?.('ws.reject', { remote: upgradeRemote, path: pathnameOf(req.url), status: upRes.statusCode ?? 502 })
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
        closeSession: closeSessionConnections,
        close: () => new Promise<void>((done, closeReject) => {
          // Idempotent: runtime rollback paths may race a second close.
          if (closed) {
            done()
            return
          }
          closed = true
          sessionConnections.clear()
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
