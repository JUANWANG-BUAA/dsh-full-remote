import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSessionStore,
  decodeSessionCookie,
  deviceLabel,
  encodeSessionCookie,
  hashSessionSecret,
  newSessionId,
  newSessionSecret,
} from '../src/sessions.js'

describe('session primitives', () => {
  it('round-trips cookie encoding and hashes secrets', () => {
    const id = newSessionId()
    const secret = newSessionSecret()
    const cookie = encodeSessionCookie(id, secret)
    assert.deepEqual(decodeSessionCookie(cookie), { id, secret })
    assert.equal(decodeSessionCookie('malformed'), undefined)
    assert.equal(decodeSessionCookie(''), undefined)
    assert.equal(decodeSessionCookie('onlyid.'), undefined)
    assert.equal(decodeSessionCookie('.onlysecret'), undefined)
    assert.equal(hashSessionSecret(secret).length, 43)
  })

  it('derives readable labels from User-Agent strings', () => {
    assert.equal(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Chrome/126.0 Safari/537.36'), 'Chrome on macOS')
    assert.equal(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5) Safari/604.1'), 'Safari on iOS')
    assert.equal(deviceLabel('Mozilla/5.0 (Linux; Android 14) Firefox/127.0'), 'Firefox on Android')
    assert.equal(deviceLabel('Mozilla/5.0 (Windows NT 10.0) Edg/126.0'), 'Edge on Windows')
    assert.equal(deviceLabel('curl/8.7.1'), 'Unknown device')
    assert.equal(deviceLabel(undefined), 'Unknown device')
  })
})

describe('session store', () => {
  it('approves, kicks, and expires devices independently', async () => {
    const changes = []
    const store = createSessionStore({ maxAgeSeconds: 3600, onChange: () => changes.push(true) })
    const a = store.login({ userAgent: 'Chrome/126' })
    const b = store.login({ userAgent: 'Safari/604' })
    const cookieA = encodeSessionCookie(a.id, a.secret)
    const cookieB = encodeSessionCookie(b.id, b.secret)
    assert.equal(store.list().length, 2)
    assert.equal(store.validate(cookieA)?.id, a.id)

    assert.equal(store.revoke(b.id), true)
    assert.equal(store.revoke(b.id), false)
    assert.equal(store.validate(cookieB), undefined)
    assert.equal(store.validate(cookieA)?.id, a.id)
    assert.equal(store.list().length, 1)
    assert.equal(changes.length > 0, true)
  })

  it('keeps approval mode pending until approved, then rejected devices cannot advance', () => {
    const store = createSessionStore({ approvalRequired: true })
    const session = store.login({ userAgent: 'Chrome/126' })
    assert.equal(session.status, 'pending')
    const cookie = encodeSessionCookie(session.id, session.secret)

    // Pending sessions never pass the auth gate.
    assert.equal(store.validate(cookie), undefined)
    // The wait-page resolver sees them regardless of status.
    assert.equal(store.pending(cookie, session.id)?.status, 'pending')
    assert.equal(store.pending(cookie, 'other-id'), undefined)

    assert.equal(store.approve(session.id), true)
    assert.equal(store.approve(session.id), false)
    assert.equal(store.validate(cookie)?.status, 'active')

    const other = store.login({ userAgent: 'Safari/604' })
    assert.equal(store.revoke(other.id), true)
    assert.equal(store.validate(encodeSessionCookie(other.id, other.secret)), undefined)
  })

  it('evicts the stalest session past the cap', () => {
    const store = createSessionStore({ maxSessions: 2, maxAgeSeconds: 3600 })
    const first = store.login({ userAgent: 'Mozilla/5.0 (Macintosh) Chrome/126' })
    const second = store.login({ userAgent: 'Mozilla/5.0 (Macintosh) Safari/604' })
    const third = store.login({ userAgent: 'Mozilla/5.0 (Windows NT 10.0) Firefox/127' })
    assert.equal(store.list().length, 2)
    // The first device (oldest lastSeen) was evicted.
    assert.equal(store.validate(encodeSessionCookie(first.id, first.secret)), undefined)
    assert.equal(store.list().some(s => s.id === third.id), true)
    assert.equal(store.list().some(s => s.id === second.id), true)
  })

  it('expires sessions by age', async () => {
    const store = createSessionStore({ maxAgeSeconds: 0.05 })
    const session = store.login({ userAgent: 'Chrome/126' })
    const cookie = encodeSessionCookie(session.id, session.secret)
    assert.notEqual(store.validate(cookie), undefined)
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(store.validate(cookie), undefined)
    assert.equal(store.list().length, 0)
  })

  it('hydrates persisted data and drops malformed entries', () => {
    const store = createSessionStore({ maxSessions: 4 })
    const good = store.login({ userAgent: 'Chrome/126' })
    const serialized = store.serialize()
    store.hydrate([
      ...serialized,
      { id: 'bad', secretHash: 'x' }, // missing fields
      { id: 'x', secretHash: 'y', label: 42, status: 'active', createdAt: 0, lastSeenAt: 0 },
      { id: 'z', secretHash: 'y', label: 'ok', status: 'weird', createdAt: 0, lastSeenAt: 0 },
      null,
    ])
    const restored = store.list()
    assert.equal(restored.length, 1)
    assert.equal(restored[0].id, good.id)
    assert.equal(store.validate(encodeSessionCookie(good.id, good.secret))?.id, good.id)
  })

  it('clear() invalidates every device', () => {
    const store = createSessionStore()
    const session = store.login({ userAgent: 'Chrome/126' })
    store.clear()
    assert.equal(store.validate(encodeSessionCookie(session.id, session.secret)), undefined)
    assert.equal(store.list().length, 0)
  })
})
