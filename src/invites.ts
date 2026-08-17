/**
 * invites — short-lived one-time login codes for phone QR / invite links.
 *
 * The master access token never appears in the invite URL. Each code is
 * single-use and expires; rotating the token clears every outstanding invite.
 */
import { randomBytes } from 'node:crypto'

const CODE_BYTES = 18
const DEFAULT_TTL_MS = 15 * 60_000
const DEFAULT_MAX_PENDING = 32
/** Same-IP retry grace after a successful consume. A flaky tunnel can drop
 *  the login redirect after the code was already consumed; the browser then
 *  re-POSTs the same code. Without a grace the retry would deadlock into the
 *  token form even though the first attempt actually signed in. */
const DEFAULT_RETRY_GRACE_MS = 60_000

export type InviteConsume =
  | { ok: false }
  | { ok: true, retry: false }
  | { ok: true, retry: true, sessionId?: string }

type InviteEntry = {
  expiresAt: number
  usedAt?: number
  usedIp?: string
  sessionId?: string
}

export function createInviteStore(options: { ttlMs?: number, maxPending?: number, retryGraceMs?: number } = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING
  const retryGraceMs = options.retryGraceMs ?? DEFAULT_RETRY_GRACE_MS
  const codes = new Map<string, InviteEntry>()

  const prune = (now = Date.now()) => {
    for (const [code, entry] of codes) {
      if (entry.expiresAt <= now) codes.delete(code)
    }
    while (codes.size > maxPending) {
      const oldest = codes.keys().next().value
      if (oldest === undefined) break
      codes.delete(oldest)
    }
  }

  return {
    /**
     * Mint a fresh one-time code. Returns the plaintext code (store only
     * expiry — codes are high-entropy and never persisted to disk).
     */
    issue() {
      prune()
      const code = randomBytes(CODE_BYTES).toString('base64url')
      codes.set(code, { expiresAt: Date.now() + ttlMs })
      return code
    },

    /**
     * Consume a code. The first consume marks the code used and records the
     * client IP; a repeat consume from the SAME IP inside the retry grace
     * window is treated as a legitimate browser retry (ok + retry) so a
     * lost redirect cannot deadlock the phone into the token form. Any other
     * reuse is rejected and the code is forgotten.
     */
    consume(code: string, ip?: string, now = Date.now()): InviteConsume {
      const key = String(code ?? '')
      if (key === '') return { ok: false }
      const entry = codes.get(key)
      if (entry === undefined) return { ok: false }
      if (entry.expiresAt <= now) {
        codes.delete(key)
        return { ok: false }
      }
      if (entry.usedAt === undefined) {
        entry.usedAt = now
        entry.usedIp = ip === undefined || ip === '' ? undefined : ip
        return { ok: true, retry: false }
      }
      // Retry grace: same client, shortly after the first use. Codes used
      // without a client IP (callers that never knew one) get no grace.
      if (
        ip !== undefined && ip !== '' &&
        entry.usedIp !== undefined && entry.usedIp === ip &&
        now - entry.usedAt <= retryGraceMs
      ) {
        return { ok: true, retry: true, sessionId: entry.sessionId }
      }
      codes.delete(key)
      return { ok: false }
    },

    /** Remember the device session minted on first consume so a retry can reuse it. */
    bindSession(code: string, sessionId: string) {
      const entry = codes.get(code)
      if (entry === undefined || entry.usedAt === undefined) return
      entry.sessionId = sessionId
    },

    clear() {
      codes.clear()
    },

    /** Test helper / diagnostics. */
    size() {
      prune()
      return codes.size
    },
  }
}
