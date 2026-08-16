import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { compileCidrList, ipAllowed, normalizeRemoteIp, parseCidr } from '../src/cidr.ts'
import { createAuditLog } from '../src/audit.ts'
import { qrToSvg } from '../src/qr-svg.ts'
import { probeFence } from '../src/self-check.ts'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInviteStore } from '../src/invites.ts'
import { createSessionStore, encodeSessionCookie } from '../src/sessions.ts'

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
      const line = JSON.parse(text.trim())
      assert.equal(line.event, 'login.ok')
      assert.equal(line.remote, '1.2.3.4')
      assert.equal(typeof line.ts, 'string')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('qr invite', () => {
  it('renders an SVG for a short invite URL', () => {
    const svg = qrToSvg('http://127.0.0.1:3081/_dsh_reverse_proxy/login?invite=abc')
    assert.equal(typeof svg, 'string')
    assert.match(svg, /^<svg[\s\S]*<\/svg>$/)
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
    await new Promise(resolve => setTimeout(resolve, 35))
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
    await new Promise(resolve => setTimeout(resolve, 1100))
    assert.equal(store.validate(cookie), undefined)
  })

  it('expires pending wait-page sessions the same way', async () => {
    const store = createSessionStore({ maxAgeSeconds: 3600, idleSeconds: 1, approvalRequired: true })
    const session = store.login({ userAgent: 'Chrome/126' })
    const cookie = encodeSessionCookie(session.id, session.secret)
    assert.equal(store.pending(cookie, session.id)?.status, 'pending')
    await new Promise(resolve => setTimeout(resolve, 1100))
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
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    try {
      const result = await probeFence({ backendHost: '127.0.0.1', backendPort: port })
      assert.equal(result.ok, true)
      assert.equal(result.status, 200)
      assert.equal(result.method, 'settings.describe')
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('reports not ok on 403', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(403)
      res.end('forbidden')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    try {
      const result = await probeFence({ backendHost: '127.0.0.1', backendPort: port })
      assert.equal(result.ok, false)
      assert.equal(result.status, 403)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })
})
