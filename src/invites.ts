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

/**
 * @param {{ ttlMs?: number, maxPending?: number }} [options]
 */
export function createInviteStore(options: { ttlMs?: number, maxPending?: number } = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING
  /** @type {Map<string, { expiresAt: number }>} */
  const codes = new Map()

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
     * Consume a code exactly once. Returns true when the code was valid and
     * not expired.
     */
    consume(code: string, now = Date.now()) {
      const key = String(code ?? '')
      if (key === '') return false
      const entry = codes.get(key)
      if (entry === undefined) return false
      codes.delete(key)
      return entry.expiresAt > now
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
