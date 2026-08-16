/**
 * security — credential primitives.
 *
 * Token generation, constant-time comparison, and cookie parsing. HTML
 * escaping lives in http-util.js (it is output plumbing, not a secret).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const TOKEN_BYTES = 24

/** Generate a URL-safe access token with enough entropy for public tunnels. */
export function generateAccessToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/** Compare secrets without leaking a useful length or prefix timing signal. */
export function safeEqual(actual: string, expected: string) {
  const left = Buffer.from(String(actual))
  const right = Buffer.from(String(expected))
  if (left.length !== right.length) {
    timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest())
    return false
  }
  return timingSafeEqual(left, right)
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {}
  for (const field of String(header ?? '').split(';')) {
    const at = field.indexOf('=')
    if (at < 1) continue
    const key = field.slice(0, at).trim()
    const value = field.slice(at + 1).trim()
    if (key.length > 0) cookies[key] = value
  }
  return cookies
}

