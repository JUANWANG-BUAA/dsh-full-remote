import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { compileCidrList, ipAllowed, normalizeRemoteIp, parseCidr } from '../src/cidr.ts'
import { createAuditLog, readAuditLog } from '../src/audit.ts'
import { qrToSvg } from '../src/qr-svg.ts'
import { probeFence } from '../src/self-check.ts'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInviteStore } from '../src/invites.ts'
import { createSessionStore, encodeSessionCookie } from '../src/sessions.ts'

/** The bound TCP port of a server that was started with `listen(0, host)`. */
function portOf(server: Server): number {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP bind')
  return address.port
}

describe('cidr allowlist', () => {
  it('parses IPv4 CIDR and bare addresses', () => {
    assert.deepEqual(parseCidr('10.0.0.0/8'), { kind: 'v4', network: 0x0a000000, prefix: 8 })
    assert.equal(parseCidr('not-an-ip'), undefined)
    assert.equal(normalizeRemoteIp('::ffff:192.168.1.5'), '192.168.1.5')
  })

  it('allows all when the list is empty, and always allows loopback', () => {
    assert.equal(ipAllowed('8.8.8.8', []), true)
    const rules = compileCidrList(['10.0.0.0/8'])
    assert.equal(ipAllowed('127.0.0.1', rules), true)
    assert.equal(ipAllowed('10.1.2.3', rules), true)
    assert.equal(ipAllowed('11.0.0.1', rules), false)
  })
})

describe('audit log', () => {
  it('appends JSONL events when enabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-audit-'))
    const path = join(dir, 'events.jsonl')
    try {
      const audit = createAuditLog({ enabled: true, path })
      await audit.record('login.ok', { remote: '1.2.3.4' })
      const text = await readFile(path, 'utf8')
      // JSON.parse is untyped by design; the record shape is asserted below.
      const line = JSON.parse(text.trim()) as { event: string, remote: string, ts: string }
      assert.equal(line.event, 'login.ok')
      assert.equal(line.remote, '1.2.3.4')
      assert.equal(typeof line.ts, 'string')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads only the tail of a large audit file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-audit-tail-'))
    const path = join(dir, 'events.jsonl')
    try {
      const lines = Array.from({ length: 200 }, (_, index) => JSON.stringify({
        ts: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
        event: `event-${index}`,
      }))
      await writeFile(path, `${lines.join('\n')}\n`)
      const events = await readAuditLog(path, 5) as Array<{ event: string }>
      assert.equal(events.length, 5)
      assert.equal(events[0].event, 'event-195')
      assert.equal(events[4].event, 'event-199')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('skips a partial first line when reading from the tail window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-audit-partial-'))
    const path = join(dir, 'events.jsonl')
    try {
      await writeFile(path, `${'x'.repeat(70 * 1024)}not-json\n${JSON.stringify({ event: 'ok' })}\n`)
      const events = await readAuditLog(path) as Array<{ event: string }>
      assert.equal(events.length, 1)
      assert.equal(events[0].event, 'ok')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('qr invite', () => {
  it('renders an SVG for a short invite URL', () => {
    const svg = qrToSvg('http://127.0.0.1:3081/_dsh_reverse_proxy/login?invite=abc')
    assert.equal(typeof svg, 'string')
    // qrToSvg returns null only for empty/oversized input; the assertion above
    // already guarantees a non-null string for this valid short URL.
    assert.match(svg as string, /^<svg[\s\S]*<\/svg>$/)
  })
})

describe('one-time invites', () => {
  it('issues single-use codes and rejects reuse or expiry', async () => {
    const store = createInviteStore({ ttlMs: 30 })
    const code = store.issue()
    assert.equal(store.consume(code), true)
    assert.equal(store.consume(code), false)
    assert.equal(store.consume(''), false)
    const brief = createInviteStore({ ttlMs: 20 })
    const stale = brief.issue()
    await new Promise<void>(resolve => setTimeout(resolve, 35))
    assert.equal(brief.consume(stale), false)
    brief.clear()
    assert.equal(brief.size(), 0)
  })
})

describe('session idle + rename', () => {
  it('expires idle sessions and renames labels', async () => {
    const store = createSessionStore({ maxAgeSeconds: 3600, idleSeconds: 1 })
    const session = store.login({ userAgent: 'Chrome/126' })
    const cookie = encodeSessionCookie(session.id, session.secret)
    assert.equal(store.rename(session.id, 'Phone'), true)
    assert.equal(store.list()[0].label, 'Phone')
    assert.equal(store.rename(session.id, ''), false)
    await new Promise<void>(resolve => setTimeout(resolve, 1100))
    assert.equal(store.validate(cookie), undefined)
  })

  it('expires pending wait-page sessions the same way', async () => {
    const store = createSessionStore({ maxAgeSeconds: 3600, idleSeconds: 1, approvalRequired: true })
    const session = store.login({ userAgent: 'Chrome/126' })
    const cookie = encodeSessionCookie(session.id, session.secret)
    assert.equal(store.pending(cookie, session.id)?.status, 'pending')
    await new Promise<void>(resolve => setTimeout(resolve, 1100))
    assert.equal(store.pending(cookie, session.id), undefined)
  })
})

describe('fence self-check', () => {
  it('reports ok when the backend does not 403 settings.describe', async () => {
    const server = createServer((req, res) => {
      assert.equal(req.headers.host?.startsWith('127.0.0.1:'), true)
      assert.equal(req.headers['sec-fetch-site'], 'same-origin')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = portOf(server)
    try {
      const result = await probeFence({ backendHost: '127.0.0.1', backendPort: port })
      assert.equal(result.ok, true)
      assert.equal(result.status, 200)
      assert.equal(result.method, 'settings.describe')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('reports not ok on 403', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(403)
      res.end('forbidden')
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = portOf(server)
    try {
      const result = await probeFence({ backendHost: '127.0.0.1', backendPort: port })
      assert.equal(result.ok, false)
      assert.equal(result.status, 403)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
