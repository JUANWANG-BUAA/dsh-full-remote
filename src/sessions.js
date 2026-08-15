import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Per-device session store for the reverse proxy.
 *
 * Every device that logs in with the access token gets its OWN session
 * credential: an id + a random 192-bit secret held only in that device's
 * cookie. The state file stores only the secret's hash, so revoking one
 * device never affects the others and the master access token stays out of
 * the cookies entirely.
 *
 * The store is deliberately synchronous in-memory: the host owns
 * persistence and passes hydrate()/serialize() data around; every mutation
 * that matters is surfaced through the onChange callback (the host
 * debounces state writes).
 */

const ID_BYTES = 16
const SECRET_BYTES = 24

export function newSessionSecret() {
  return randomBytes(SECRET_BYTES).toString('base64url')
}

export function newSessionId() {
  return randomBytes(ID_BYTES).toString('base64url')
}

export function hashSessionSecret(secret) {
  return createHash('sha256').update(`dsh-reverse-proxy/session-secret/v1\0${secret}`).digest('base64url')
}

export function encodeSessionCookie(id, secret) {
  return `${id}.${secret}`
}

/** Split a cookie value; returns undefined for malformed input. */
export function decodeSessionCookie(value) {
  const text = String(value ?? '')
  const at = text.indexOf('.')
  if (at < 1 || at === text.length - 1) return undefined
  return { id: text.slice(0, at), secret: text.slice(at + 1) }
}

function safeEqual(actual, expected) {
  const left = Buffer.from(String(actual))
  const right = Buffer.from(String(expected))
  if (left.length !== right.length) {
    timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest())
    return false
  }
  return timingSafeEqual(left, right)
}

const BROWSERS = [
  [/Edg\//, 'Edge'],
  [/OPR\/|\bOpera\b/i, 'Opera'],
  [/Firefox\//, 'Firefox'],
  [/Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
]
const OSES = [
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Windows NT/, 'Windows'],
  [/Linux/, 'Linux'],
]

/** Derive a short human label from a User-Agent string. */
export function deviceLabel(userAgent, fallback = 'Unknown device') {
  const ua = String(userAgent ?? '').slice(0, 256)
  if (ua === '') return fallback
  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1]
  const os = OSES.find(([pattern]) => pattern.test(ua))?.[1]
  if (browser === undefined && os === undefined) return fallback
  return `${browser ?? 'Browser'} on ${os ?? 'unknown OS'}`
}

/**
 * @param {{
 *   maxSessions?: number,
 *   maxAgeSeconds?: number,
 *   approvalRequired?: boolean,
 *   onChange?: () => void,
 * }} options
 */
export function createSessionStore(options = {}) {
  const maxSessions = options.maxSessions ?? 16
  const maxAgeSeconds = options.maxAgeSeconds ?? 30 * 24 * 3600
  const approvalRequired = options.approvalRequired === true
  const onChange = options.onChange
  const maxAgeMs = maxAgeSeconds * 1000
  /** @type {Map<string, { id: string, secretHash: string, label: string, status: 'active'|'pending', createdAt: number, lastSeenAt: number }>} */
  const sessions = new Map()

  const changed = () => { onChange?.() }

  const sweep = (now = Date.now()) => {
    for (const [id, session] of sessions) {
      if (now - session.lastSeenAt > maxAgeMs) sessions.delete(id)
    }
  }

  /** Evict the entry with the oldest lastSeenAt, never the protected id. */
  const evictOldest = (exceptId) => {
    let oldest
    for (const entry of sessions) {
      if (entry[0] === exceptId) continue
      if (oldest === undefined || entry[1].lastSeenAt < oldest[1].lastSeenAt) oldest = entry
    }
    if (oldest !== undefined) sessions.delete(oldest[0])
  }

  const publicShape = session => ({
    id: session.id,
    label: session.label,
    status: session.status,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
  })

  const touch = (session, now = Date.now()) => {
    // Throttle: lastSeen is persisted and displayed, not an audit trail.
    if (now - session.lastSeenAt > 60_000) {
      session.lastSeenAt = now
      changed()
    }
  }

  const find = (cookieValue) => {
    const decoded = decodeSessionCookie(cookieValue)
    if (decoded === undefined) return undefined
    const session = sessions.get(decoded.id)
    if (session === undefined) return undefined
    if (!safeEqual(hashSessionSecret(decoded.secret), session.secretHash)) return undefined
    return session
  }

  return {
    /** Login a new device after the access token already checked out. */
    login({ userAgent }) {
      const now = Date.now()
      sweep(now)
      const secret = newSessionSecret()
      const id = newSessionId()
      const record = {
        id,
        secretHash: hashSessionSecret(secret),
        label: deviceLabel(userAgent),
        status: approvalRequired ? 'pending' : 'active',
        createdAt: now,
        lastSeenAt: now,
      }
      sessions.set(id, record)
      // Cap is a soft bound: evict the stalest OTHER session; when the store
      // only contains the newcomer (impossible under cap but safe anyway),
      // the eviction is skipped and the cap recovers on the next mutation.
      while (sessions.size > maxSessions) {
        const before = sessions.size
        evictOldest(id)
        if (sessions.size === before) break
      }
      changed()
      return { id, secret, status: record.status, label: record.label }
    },

    /** Validate a device cookie; undefined when unknown, revoked, or expired. */
    validate(cookieValue) {
      const session = find(cookieValue)
      if (session === undefined) return undefined
      if (Date.now() - session.lastSeenAt > maxAgeMs) {
        sessions.delete(session.id)
        changed()
        return undefined
      }
      if (session.status !== 'active') return undefined
      touch(session)
      return publicShape(session)
    },

    /** Resolve a session regardless of status (wait-page status endpoint). */
    pending(cookieValue, id) {
      const decoded = decodeSessionCookie(cookieValue)
      if (decoded === undefined || decoded.id !== id) return undefined
      return find(cookieValue)
    },

    list() {
      sweep()
      return [...sessions.values()].map(publicShape).sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    },

    revoke(id) {
      const existed = sessions.delete(id)
      if (existed) changed()
      return existed
    },

    approve(id) {
      const session = sessions.get(id)
      if (session === undefined || session.status !== 'pending') return false
      session.status = 'active'
      session.lastSeenAt = Date.now()
      changed()
      return true
    },

    /** Invalidate every device (token rotation, disable). */
    clear() {
      if (sessions.size > 0) {
        sessions.clear()
        changed()
      }
    },

    /** Rebuild the store from persisted data; malformed entries are dropped. */
    hydrate(data) {
      sessions.clear()
      const list = Array.isArray(data) ? data : []
      for (const raw of list.slice(0, maxSessions)) {
        if (typeof raw?.id !== 'string' || typeof raw?.secretHash !== 'string') continue
        if (typeof raw?.label !== 'string' || raw.label.length > 128) continue
        if (raw.status !== 'active' && raw.status !== 'pending') continue
        if (!Number.isFinite(raw.createdAt) || !Number.isFinite(raw.lastSeenAt)) continue
        sessions.set(raw.id, {
          id: raw.id,
          secretHash: raw.secretHash,
          label: raw.label,
          status: raw.status,
          createdAt: raw.createdAt,
          lastSeenAt: raw.lastSeenAt,
        })
      }
    },

    serialize() {
      sweep()
      return [...sessions.values()].map(session => ({
        id: session.id,
        secretHash: session.secretHash,
        label: session.label,
        status: session.status,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
      }))
    },
  }
}
