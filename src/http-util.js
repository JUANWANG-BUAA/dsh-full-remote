/**
 * http-util — shared HTTP plumbing for the host control surface and the
 * proxy server.
 *
 * Everything here is a pure, dependency-free helper: path parsing, bounded
 * body reads, JSON/HTML responses, and HTML escaping. Keeping one copy means
 * the host and the proxy cannot drift apart on response semantics.
 */

/** Parse the pathname of a request URL; malformed input degrades to '/'. */
export function pathnameOf(url) {
  try {
    return new URL(url ?? '/', 'http://x').pathname
  } catch {
    return '/'
  }
}

/**
 * Read a request body with a hard byte cap. Rejects (and destroys the
 * socket) once the stream exceeds the limit, so chunked uploads cannot
 * bypass it. Rejects on parse errors for JSON callers, on 'body-too-large'
 * for everything else.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit maximum accepted body size in bytes
 * @returns {Promise<Buffer>}
 */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Read a bounded JSON body; rejects on overflow or malformed JSON. */
export async function readJson(req, limit = 1024) {
  const body = await readBody(req, limit)
  return JSON.parse(body.toString('utf8'))
}

/** Send a JSON response with cache/sniffing hardening. */
export function sendJson(res, status, body) {
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
export function sendHtml(res, status, body, extra = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    ...extra,
  })
  res.end(body)
}

/** Escape user-influenced text before it lands inside HTML. */
export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
