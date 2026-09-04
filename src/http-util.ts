/**
 * http-util — shared HTTP plumbing for the host control surface and the
 * proxy server.
 *
 * Path parsing, bounded body reads, JSON/HTML responses, HTML escaping, and
 * listen-address formatting. Host and proxy share one copy so response
 * semantics and authority formatting cannot drift apart.
 */
import { networkInterfaces } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isLoopbackHost, isWildcardHost } from './hosts.ts'

export { isLoopbackHost, isWildcardHost }

/** Coerce unknown thrown values to Error for loggers. */
export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** Bracket IPv6 literals so `host:port` is a legal authority. */
export function formatAuthority(host: string, port: number) {
  const hostname = String(host ?? '')
  const authorityHost = hostname.includes(':') && !hostname.startsWith('[')
    ? `[${hostname}]`
    : hostname
  return `${authorityHost}:${port}`
}

export function formatHttpUrl(host: string, port: number, scheme = 'http') {
  return `${scheme}://${formatAuthority(host, port)}`
}

/** Host/Origin rewrite target: always a loopback literal, never `backendHost`. */
export function rewriteLoopbackAuthority(port: number) {
  return formatAuthority('127.0.0.1', port)
}

/**
 * Self-loop: same port, and the listen address would accept the backend.
 * Wildcard listen includes every interface (including the backend);
 * two loopback spellings of the same port also collide.
 */
export function isSelfLoop(
  listenHost: string,
  listenPort: number,
  backendHost: string,
  backendPort: number,
) {
  if (Number(listenPort) !== Number(backendPort)) return false
  if (listenHost === backendHost) return true
  if (isWildcardHost(listenHost)) return true
  if (isWildcardHost(backendHost) && isLoopbackHost(listenHost)) return true
  return isLoopbackHost(listenHost) && isLoopbackHost(backendHost)
}

/** First non-internal IPv4, else loopback. Used as the copyable tunnel target. */
export function firstReachableIPv4() {
  try {
    for (const addrs of Object.values(networkInterfaces() ?? {})) {
      for (const addr of addrs ?? []) {
        const ipv4 = addr.family === 'IPv4' || (addr.family as string | number) === 4
        if (ipv4 && !addr.internal) return addr.address
      }
    }
  } catch {
    // Sandboxes and locked-down containers can refuse this syscall.
  }
  return '127.0.0.1'
}

/** Bind host → a host a client can actually connect to. */
export function publishHost(boundHost: string) {
  return isWildcardHost(boundHost) ? firstReachableIPv4() : boundHost
}

/** Bind host → every address worth listing on the panel. */
export function reachableHosts(boundHost: string): string[] {
  if (!isWildcardHost(boundHost)) return [boundHost]
  const hosts = ['127.0.0.1']
  if (boundHost === '::' || boundHost === '::0' || boundHost === '[::]') hosts.push('::1')
  const lan = firstReachableIPv4()
  if (!hosts.includes(lan)) hosts.push(lan)
  return hosts
}

/** Parse the pathname of a request URL; malformed input degrades to '/'. */
export function pathnameOf(url: string | undefined) {
  try {
    return new URL(url ?? '/', 'http://x').pathname
  } catch {
    return '/'
  }
}

/**
 * Read a request body with a hard byte cap. Once the stream exceeds the
 * limit the promise rejects with 'body-too-large' and the remainder is
 * drained (never buffered) instead of destroying the socket, so the caller's
 * 400/413 still reaches the client. An endless dump is bounded by the
 * server-level request timeout, not by buffering.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit maximum accepted body size in bytes
 * @returns {Promise<Buffer>}
 */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let overLimit = false
    req.on('data', (chunk: Buffer) => {
      if (overLimit) return
      size += chunk.length
      if (size > limit) {
        overLimit = true
        chunks.length = 0
        reject(new Error('body-too-large'))
        // Discard the rest of the body so the error response can flush past
        // TCP backpressure instead of stalling behind an unread socket.
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Read a bounded JSON body; rejects on overflow or malformed JSON. */
export async function readJson(req: IncomingMessage, limit = 1024) {
  const body = await readBody(req, limit)
  return JSON.parse(body.toString('utf8'))
}

/** Send a JSON response with cache/sniffing hardening. */
export function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

/**
 * Send an HTML response with the project's baseline security headers.
 * `extra` may override any header (the wait page widens the CSP on purpose).
 */
export function sendHtml(res: ServerResponse, status: number, body: string, extra = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    ...extra,
  })
  res.end(body)
}

/** Escape user-influenced text before it lands inside HTML. */
export function escapeHtml(value: unknown) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
