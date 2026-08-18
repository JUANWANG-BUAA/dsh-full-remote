/**
 * sessions — per-device session store.
 *
 * Owns the device credential lifecycle (login/validate/approve/revoke,
 * expiry, cap eviction, persistence shapes) plus the User-Agent label
 * derivation. Pure in-memory and synchronous: the host persists via
 * serialize()/hydrate() and the onChange callback.
 */
import { createHash, randomBytes } from 'node:crypto'
import { safeEqual } from './security.ts'

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

/** One in-memory device session record. */
export interface SessionRecord {
  id: string
  secretHash: string
  label: string
  status: 'active' | 'pending' | 'rejected'
  createdAt: number
  lastSeenAt: number
  /** Remote IP at login; undefined for records persisted before IPs were tracked. */
  createdIp?: string
  /** Remote IP of the most recent validated request. */
  lastSeenIp?: string
}

export function newSessionSecret() {
  return randomBytes(SECRET_BYTES).toString('base64url')
}

export function newSessionId() {
  return randomBytes(ID_BYTES).toString('base64url')
}

function validSessionIp(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : undefined
}

export function hashSessionSecret(secret: string) {
  return createHash('sha256').update(`dsh-reverse-proxy/session-secret/v1\0${secret}`).digest('base64url')
}

export function encodeSessionCookie(id: string, secret: string) {
  return `${id}.${secret}`
}

/** Session Set-Cookie (login or expiry). Logout must repeat `Secure` when the original cookie had it, or HTTPS browsers keep the old cookie. */
export function sessionCookie(
  name: string,
  value: string,
  options: { maxAgeSeconds: number, secure: boolean },
) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${options.maxAgeSeconds}${options.secure ? '; Secure' : ''}`
}

/** Split a cookie value; returns undefined for malformed input. */
export function decodeSessionCookie(value: string | undefined) {
  const text = String(value ?? '')
  const at = text.indexOf('.')
  if (at < 1 || at === text.length - 1) return undefined
  return { id: text.slice(0, at), secret: text.slice(at + 1) }
}

const BROWSERS: Array<[RegExp, string]> = [
  [/Edg\//, 'Edge'],
  [/OPR\/|\bOpera\b/i, 'Opera'],
  [/Firefox\//, 'Firefox'],
  [/Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
]
const OSES: Array<[RegExp, string]> = [
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Windows NT/, 'Windows'],
  [/Linux/, 'Linux'],
]

/** Derive a short human label from a User-Agent string. */
export function deviceLabel(userAgent: string | undefined, fallback = 'Unknown device') {
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
 *   idleSeconds?: number,
 *   approvalRequired?: boolean,
 *   onChange?: () => void,
 *   now?: () => number,
 * }} options
 */
export function createSessionStore(options: {
  maxSessions?: number
  maxAgeSeconds?: number
  idleSeconds?: number
  approvalRequired?: boolean
  onChange?: () => void
  /** Testable clock seam; production defaults to Date.now. */
  now?: () => number
} = {}) {
  const maxSessions = options.maxSessions ?? 16
  const maxAgeSeconds = options.maxAgeSeconds ?? 30 * 24 * 3600
  // 0 = disabled (only absolute maxAge applies via lastSeen historically;
  // when idleSeconds > 0 it is an independent inactivity window).
  const idleSeconds = options.idleSeconds ?? 0
  const approvalRequired = options.approvalRequired === true
  const onChange = options.onChange
  const now = options.now ?? Date.now
  const maxAgeMs = maxAgeSeconds * 1000
  const idleMs = idleSeconds > 0 ? idleSeconds * 1000 : 0
  /** @type {Map<string, { id: string, secretHash: string, label: string, status: 'active'|'pending'|'rejected', createdAt: number, lastSeenAt: number }>} */
  const sessions = new Map<string, SessionRecord>()

  const changed = () => { onChange?.() }

  const expired = (session: SessionRecord, at = now()) => {
    if (at - session.createdAt > maxAgeMs) return true
    if (idleMs > 0 && at - session.lastSeenAt > idleMs) return true
    // Back-compat: when idle is unset, keep prior "maxAge from lastSeen" behaviour.
    if (idleMs === 0 && at - session.lastSeenAt > maxAgeMs) return true
    return false
  }

  const sweep = (at = now()) => {
    for (const [id, session] of sessions) {
      if (expired(session, at)) sessions.delete(id)
    }
  }

  /** Evict the entry with the oldest lastSeenAt, never the protected id. */
  const evictOldest = (exceptId: string) => {
    let oldest
    for (const entry of sessions) {
      if (entry[0] === exceptId) continue
      if (oldest === undefined || entry[1].lastSeenAt < oldest[1].lastSeenAt) oldest = entry
    }
    if (oldest !== undefined) sessions.delete(oldest[0])
  }

  const publicShape = (session: SessionRecord) => ({
    id: session.id,
    label: session.label,
    status: session.status,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    ...(session.createdIp !== undefined ? { createdIp: session.createdIp } : {}),
    ...(session.lastSeenIp !== undefined ? { lastSeenIp: session.lastSeenIp } : {}),
  })

  const touch = (session: SessionRecord, at = now()) => {
    // Idle expiry is a security boundary, so every authenticated request
    // advances it. The host already debounces persistence via onChange.
    session.lastSeenAt = at
    changed()
  }

  const find = (cookieValue: string | undefined) => {
    const decoded = decodeSessionCookie(cookieValue)
    if (decoded === undefined) return undefined
    const session = sessions.get(decoded.id)
    if (session === undefined) return undefined
    if (!safeEqual(hashSessionSecret(decoded.secret), session.secretHash)) return undefined
    return session
  }

  return {
    /** Login a new device after the access token already checked out. */
    login({ userAgent, ip }: { userAgent: string | undefined, ip?: string }) {
      const at = now()
      sweep(at)
      const secret = newSessionSecret()
      const id = newSessionId()
      const record: SessionRecord = {
        id,
        secretHash: hashSessionSecret(secret),
        label: deviceLabel(userAgent),
        status: approvalRequired ? 'pending' : 'active',
        createdAt: at,
        lastSeenAt: at,
        ...(ip !== undefined && ip !== '' ? { createdIp: ip, lastSeenIp: ip } : {}),
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

    /**
     * Re-issue a cookie for an existing device (invite retry after a lost
     * redirect). Rotates the secret so the new Set-Cookie is the only live
     * credential; status and createdAt stay put so the owner still sees one
     * device. Undefined when the session is gone, expired, or rejected.
     */
    reissue(id: string, ip?: string) {
      const at = now()
      sweep(at)
      const session = sessions.get(id)
      if (session === undefined || expired(session, at) || session.status === 'rejected') return undefined
      const secret = newSessionSecret()
      session.secretHash = hashSessionSecret(secret)
      session.lastSeenAt = at
      if (ip !== undefined && ip !== '') session.lastSeenIp = ip
      changed()
      return { id, secret, status: session.status, label: session.label }
    },

    /** Validate a device cookie; undefined when unknown, revoked, or expired. */
    validate(cookieValue: string | undefined, ip?: string) {
      const session = find(cookieValue)
      if (session === undefined) return undefined
      if (expired(session)) {
        sessions.delete(session.id)
        changed()
        return undefined
      }
      if (session.status !== 'active') return undefined
      // A changed source IP is security-relevant: record it immediately,
      // outside the lastSeen throttle.
      if (ip !== undefined && ip !== '' && session.lastSeenIp !== ip) {
        session.lastSeenIp = ip
        changed()
      }
      touch(session)
      return publicShape(session)
    },

    /** Resolve a session regardless of status (wait-page status endpoint). */
    pending(cookieValue: string | undefined, id: string) {
      const decoded = decodeSessionCookie(cookieValue)
      if (decoded === undefined || decoded.id !== id) return undefined
      const session = find(cookieValue)
      if (session === undefined) return undefined
      if (expired(session)) {
        sessions.delete(session.id)
        changed()
        return undefined
      }
      return session
    },

    list() {
      sweep()
      return [...sessions.values()]
        .filter(session => session.status !== 'rejected')
        .map(publicShape)
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    },

    revoke(id: string) {
      const session = sessions.get(id)
      if (session === undefined) return false
      // Pending devices stay briefly as `rejected` so the wait page can show
      // the rejection copy instead of a generic "expired" unknown.
      if (session.status === 'pending') {
        session.status = 'rejected'
        session.lastSeenAt = now()
        changed()
        return true
      }
      sessions.delete(id)
      changed()
      return true
    },

    approve(id: string) {
      const session = sessions.get(id)
      if (session === undefined || session.status !== 'pending') return false
      session.status = 'active'
      session.lastSeenAt = now()
      changed()
      return true
    },

    /**
     * Rename a device label (1–64 chars after trim). Returns false when the
     * id is unknown or the label is empty / too long.
     */
    rename(id: string, label: string | undefined) {
      const session = sessions.get(id)
      if (session === undefined) return false
      const next = String(label ?? '').trim()
      if (next.length === 0 || next.length > 64) return false
      if (session.label === next) return true
      session.label = next
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
    hydrate(data: unknown[] | undefined) {
      sessions.clear()
      const list = Array.isArray(data) ? data : []
      for (const raw of list.slice(0, maxSessions)) {
        const entry = raw as Partial<SessionRecord> | undefined
        if (typeof entry?.id !== 'string' || typeof entry?.secretHash !== 'string') continue
        if (typeof entry?.label !== 'string' || entry.label.length > 128) continue
        if (entry.status !== 'active' && entry.status !== 'pending') continue
        if (!Number.isFinite(entry.createdAt) || !Number.isFinite(entry.lastSeenAt)) continue
        // IP fields are optional (records from before IP tracking lack them);
        // a malformed one is dropped individually, never the whole record.
        const createdIp = validSessionIp(entry.createdIp)
        const lastSeenIp = validSessionIp(entry.lastSeenIp)
        sessions.set(entry.id, {
          id: entry.id,
          secretHash: entry.secretHash,
          label: entry.label,
          status: entry.status,
          createdAt: entry.createdAt as number,
          lastSeenAt: entry.lastSeenAt as number,
          ...(createdIp !== undefined ? { createdIp } : {}),
          ...(lastSeenIp !== undefined ? { lastSeenIp } : {}),
        })
      }
    },

    serialize() {
      sweep()
      return [...sessions.values()]
        .filter(session => session.status !== 'rejected')
        .map(session => ({
          id: session.id,
          secretHash: session.secretHash,
          label: session.label,
          status: session.status,
          createdAt: session.createdAt,
          lastSeenAt: session.lastSeenAt,
          ...(session.createdIp !== undefined ? { createdIp: session.createdIp } : {}),
          ...(session.lastSeenIp !== undefined ? { lastSeenIp: session.lastSeenIp } : {}),
        }))
    },
  }
}
