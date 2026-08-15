import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const TOKEN_BYTES = 24

/** Generate a URL-safe access token with enough entropy for public tunnels. */
export function generateAccessToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/** Derive the cookie value without storing a second credential. */
export function sessionValue(token) {
  return createHash('sha256').update(`dsh-reverse-proxy/session/v1\0${token}`).digest('base64url')
}

/** Compare secrets without leaking a useful length or prefix timing signal. */
export function safeEqual(actual, expected) {
  const left = Buffer.from(String(actual))
  const right = Buffer.from(String(expected))
  if (left.length !== right.length) {
    timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest())
    return false
  }
  return timingSafeEqual(left, right)
}

export function parseCookies(header) {
  const cookies = {}
  for (const field of String(header ?? '').split(';')) {
    const at = field.indexOf('=')
    if (at < 1) continue
    const key = field.slice(0, at).trim()
    const value = field.slice(at + 1).trim()
    if (key.length > 0) cookies[key] = value
  }
  return cookies
}

export function isAuthenticated(req, token, cookieName) {
  return safeEqual(parseCookies(req.headers.cookie)[cookieName] ?? '', sessionValue(token))
}

export function sessionCookie(token, cookieName, secure = false) {
  return [
    `${cookieName}=${sessionValue(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=2592000',
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ')
}
