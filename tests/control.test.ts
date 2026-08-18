import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../src/index.ts'
import { writeState } from '../src/persist.ts'
import { createServer as createHttpServer, request } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:net'

/** The runtime returned by `createRuntime` (config defaults are re-applied inside). */
type Runtime = ReturnType<typeof createRuntime>
type RuntimeConfig = Parameters<typeof createRuntime>[1]

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  // Sequential reverse order: disposers may write state files, so a parallel
  // rm would race them.
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

function makeConfig(stateFile: string, extra: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    listenHost: '127.0.0.1',
    listenPort: 0,
    backendHost: '127.0.0.1',
    backendPort: 3080,
    stateFile,
    autoRestore: false,
    maxRequestBytes: 1024,
    upstreamTimeoutMs: 1000,
    sessionMaxAgeSeconds: 3600,
    cookieName: 'test_session',
    ...extra,
  } as RuntimeConfig
}

function makeContext() {
  return {
    webServer: {
      port: 3080,
      register() { return () => {} },
      tapIndex() { return () => {} },
    },
    logger: { warn() {}, info() {}, debug() {} },
    effect() {},
  }
}

async function makeRuntime(): Promise<{ runtime: Runtime, stateFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-reverse-proxy-control-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const stateFile = join(dir, 'state.json')
  const runtime = createRuntime(makeContext(), makeConfig(stateFile))
  cleanups.push(() => runtime.dispose())
  return { runtime, stateFile }
}

/** Mount the runtime handle behind a real Node HTTP listener for black-box route tests. */
async function listenControl(runtime: Runtime) {
  const server = createHttpServer((req, res) => { void runtime.handle(req, res) })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a TCP control listener')
  return address.port
}

interface FakeResponse {
  statusCode: number
  headers: Record<string, unknown>
  body: string
  writeHead(code: number, headers?: Record<string, unknown>): void
  end(body?: string): void
}

function fakeRes(): FakeResponse {
  const res: FakeResponse = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code: number, headers: Record<string, unknown> = {}) {
      res.statusCode = code
      Object.assign(res.headers, headers)
    },
    end(body: string = '') {
      res.body += String(body)
    },
  }
  return res
}

interface FakeRequest {
  url: string
  method: string
  headers: Record<string, string>
  socket: { remoteAddress: string }
  on(event: string, fn: (chunk?: Buffer) => void): FakeRequest
}

function fakeReq(options: {
  path: string
  method?: string
  headers?: Record<string, string>
  remoteAddress?: string
  body?: string
}): FakeRequest {
  const { path, method = 'GET', headers = {}, remoteAddress = '127.0.0.1', body } = options
  const handlers: Record<string, ((chunk?: Buffer) => void) | undefined> = {}
  const req: FakeRequest = {
    url: path,
    method,
    headers,
    socket: { remoteAddress },
    on(event: string, fn: (chunk?: Buffer) => void) {
      handlers[event] = fn
      return req
    },
  }
  queueMicrotask(() => {
    if (body !== undefined) handlers.data?.(Buffer.from(body))
    handlers.end?.()
  })
  return req
}

interface HttpResponse {
  status: number | undefined
  headers: IncomingHttpHeaders
  body: string
}

function http(options: {
  port: number
  path?: string
  method?: string
  headers?: Record<string, string>
  body?: string
}): Promise<HttpResponse> {
  const { port, path = '/', method = 'GET', headers = {}, body } = options
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    if (body !== undefined) req.end(body)
    else req.end()
  })
}

const CONTROL = {
  'x-dsh-reverse-proxy-control': '1',
  origin: 'http://127.0.0.1:3080',
}

async function call(runtime: Runtime, options: {
  path: string
  method?: string
  headers?: Record<string, string>
  remoteAddress?: string
  body?: string
}): Promise<{ status: number, body: unknown }> {
  const res = fakeRes()
  await runtime.handle(
    fakeReq(options) as unknown as IncomingMessage,
    res as unknown as ServerResponse,
  )
  return {
    status: res.statusCode,
    // Control responses are JSON; the parse result is asserted per-test.
    body: res.body === '' ? {} : JSON.parse(res.body) as unknown,
  }
}

describe('device session control', () => {
  it('lists devices and approves/revokes them through the control surface', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-reverse-proxy-session-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const ctx = makeContext()
    const stateFile = join(dir, 'state.json')
    const runtime = createRuntime(ctx, makeConfig(stateFile, { approvalMode: true }))
    cleanups.push(() => runtime.dispose())

    const started = await runtime.start()
    assert.equal(started.running, true)
    const proxyPort = Number(new URL(started.target).port)

    // A remote device logs in through the real proxy.
    const token = await runtime.token()
    const login = await http({
      port: proxyPort,
      path: '/_dsh_reverse_proxy/login',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/126' },
      body: `token=${encodeURIComponent(token)}`,
    })
    assert.equal(login.status, 303)
    assert.match(login.headers.location!, /^\/_dsh_reverse_proxy\/wait\//)

    // The control surface lists the pending device, with its source IP.
    const listed = await call(runtime, { path: '/dsh-reverse-proxy/sessions', method: 'GET', headers: CONTROL })
    assert.equal(listed.status, 200)
    const sessions = listed.body as { sessions: Array<{ id: string, status: string, label: string, createdIp?: string, lastSeenIp?: string }> }
    assert.equal(sessions.sessions.length, 1)
    assert.equal(sessions.sessions[0].status, 'pending')
    assert.equal(sessions.sessions[0].label, 'Chrome on macOS')
    assert.equal(sessions.sessions[0].createdIp, '127.0.0.1')
    assert.equal(sessions.sessions[0].lastSeenIp, '127.0.0.1')
    const id = sessions.sessions[0].id

    // Mutations require the control header; approve without it is rejected.
    const blocked = await call(runtime, {
      path: '/dsh-reverse-proxy/sessions/approve',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    assert.equal(blocked.status, 403)

    // Approve, then the same device appears active.
    const approved = await call(runtime, {
      path: '/dsh-reverse-proxy/sessions/approve',
      method: 'POST',
      headers: { ...CONTROL, 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    assert.deepEqual(approved.body, { ok: true })
    const afterApprove = await call(runtime, { path: '/dsh-reverse-proxy/sessions', method: 'GET', headers: CONTROL })
    assert.equal((afterApprove.body as { sessions: Array<{ status: string }> }).sessions[0].status, 'active')

    // Revoke; the list drains.
    const revoked = await call(runtime, {
      path: '/dsh-reverse-proxy/sessions/revoke',
      method: 'POST',
      headers: { ...CONTROL, 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    assert.deepEqual(revoked.body, { ok: true })
    const afterRevoke = await call(runtime, { path: '/dsh-reverse-proxy/sessions', method: 'GET', headers: CONTROL })
    assert.deepEqual(afterRevoke.body, { sessions: [] })
  })

  it('surfaces approvalMode on the device home page after the owner approves', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-reverse-proxy-home-approval-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const runtime = createRuntime(makeContext(), makeConfig(join(dir, 'state.json'), { approvalMode: true }))
    cleanups.push(() => runtime.dispose())
    const started = await runtime.start()
    const proxyPort = Number(new URL(started.target).port)
    const token = await runtime.token()
    const login = await http({
      port: proxyPort,
      path: '/_dsh_reverse_proxy/login',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(token)}`,
    })
    assert.equal(login.status, 303)
    const listed = await call(runtime, { path: '/dsh-reverse-proxy/sessions', method: 'GET', headers: CONTROL })
    const id = (listed.body as { sessions: Array<{ id: string }> }).sessions[0].id
    await call(runtime, {
      path: '/dsh-reverse-proxy/sessions/approve',
      method: 'POST',
      headers: { ...CONTROL, 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const raw = login.headers['set-cookie']
    const cookie = (Array.isArray(raw) ? raw[0] : raw)!.split(';', 1)[0]
    const home = await http({
      port: proxyPort,
      path: '/_dsh_reverse_proxy/home',
      headers: { cookie },
    })
    assert.equal(home.status, 200)
    assert.match(home.body, /需主人审批/)
  })
})

describe('runtime control surface', () => {
  it('starts and stops the proxy and keeps the token stable', async () => {
    const { runtime } = await makeRuntime()
    const token = await runtime.token()
    assert.match(token, /^[A-Za-z0-9_-]{32}$/)
    assert.equal(await runtime.token(), token)

    const started = await runtime.start()
    assert.equal(started.running, true)
    assert.match(started.target, /^http:\/\/127\.0\.0\.1:\d+$/)

    const stopped = await runtime.stop()
    assert.equal(stopped.running, false)
    assert.equal(stopped.enabled, false)
  })

  it('persists runtime listen overrides with 0600 permissions', async () => {
    const { runtime, stateFile } = await makeRuntime()
    const updated = await runtime.setListen('0.0.0.0', 0)
    assert.deepEqual(updated.listen, { host: '0.0.0.0', port: 0 })
    const mode = (await stat(stateFile)).mode & 0o777
    assert.equal(mode, 0o600)

    const fresh = createRuntime(makeContext(), makeConfig(stateFile))
    cleanups.push(() => fresh.dispose())
    assert.deepEqual((await fresh.status()).listen, { host: '0.0.0.0', port: 0 })
  })

  it('refuses to start when the backend equals the listen address (self-loop)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-reverse-proxy-loop-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const ctx = makeContext()
    ctx.webServer.port = 3081
    const runtime = createRuntime(ctx, makeConfig(join(dir, 'state.json'), {
      listenPort: 3081,
      backendPort: 0,
    }))
    cleanups.push(() => runtime.dispose())
    const started = await runtime.start()
    assert.equal(started.running, false)
    assert.equal(started.reason, 'self-loop')
    const status = await runtime.status()
    assert.equal(status.reason, 'self-loop')
  })

  it('rotates the token through the control route without deadlocking the serial gate', async () => {
    const { runtime } = await makeRuntime()
    await runtime.start()
    const before = await runtime.token()
    const rotated = await Promise.race([
      call(runtime, { path: '/dsh-reverse-proxy/rotate-token', method: 'POST', headers: CONTROL }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('rotate-token hung on the serial gate')), 3000)
      }),
    ])
    assert.equal(rotated.status, 200)
    const body = rotated.body as { accessToken: string, running: boolean }
    assert.notEqual(body.accessToken, before)
    assert.equal(body.running, true)
    assert.equal(await runtime.token(), body.accessToken)
  })

  it('does not hydrate sessions when a short access token forces regeneration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-reverse-proxy-regen-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const stateFile = join(dir, 'state.json')
    const now = Date.now()
    await writeState(stateFile, {
      enabled: false,
      accessToken: 'too-short',
      sessions: [{
        id: 'device1',
        secretHash: 'hash',
        label: 'Phone',
        status: 'active',
        createdAt: now,
        lastSeenAt: now,
      }],
    })
    const runtime = createRuntime(makeContext(), makeConfig(stateFile))
    cleanups.push(() => runtime.dispose())
    const token = await runtime.token()
    assert.match(token, /^[A-Za-z0-9_-]{32}$/)
    const listed = await call(runtime, { path: '/dsh-reverse-proxy/sessions', method: 'GET', headers: CONTROL })
    assert.deepEqual(listed.body, { sessions: [] })
  })

  it('refuses to start when listen is a wildcard covering the backend port', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-reverse-proxy-wild-loop-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const ctx = makeContext()
    ctx.webServer.port = 3080
    const runtime = createRuntime(ctx, makeConfig(join(dir, 'state.json'), {
      listenHost: '0.0.0.0',
      listenPort: 3080,
      backendPort: 0,
    }))
    cleanups.push(() => runtime.dispose())
    const started = await runtime.start()
    assert.equal(started.running, false)
    assert.equal(started.reason, 'self-loop')
  })

  it('reports a connectable target when listen is 0.0.0.0 or ::', async () => {
    const { runtime } = await makeRuntime()
    const v4 = await runtime.setListen('0.0.0.0', 9081)
    assert.equal(v4.listen.host, '0.0.0.0')
    assert.equal(v4.wildcard, true)
    assert.equal(v4.target.includes('0.0.0.0'), false)
    new URL(v4.target)
    assert.equal(v4.reachables.some(url => url.includes('127.0.0.1')), true)

    const v6 = await runtime.setListen('::', 9082)
    assert.equal(v6.listen.host, '::')
    assert.doesNotMatch(v6.target, /http:\/\/:::/)
    new URL(v6.target)
  })

  it('requires the control header to reveal the access token', async () => {
    const { runtime } = await makeRuntime()
    const bare = await call(runtime, { path: '/dsh-reverse-proxy/token' })
    assert.equal(bare.status, 403)
    const ok = await call(runtime, { path: '/dsh-reverse-proxy/token', headers: CONTROL })
    assert.equal(ok.status, 200)
    assert.match((ok.body as { accessToken: string }).accessToken, /^[A-Za-z0-9_-]{32}$/)
  })

  it('rejects malformed listen overrides without changing state', async () => {
    const { runtime } = await makeRuntime()
    const bad = await runtime.setListen('bad host', 70000)
    assert.equal(bad.reason, 'invalid-listen')
    assert.deepEqual(bad.listen, { host: '127.0.0.1', port: 0 })
  })

  it('refuses control routes from non-loopback peers', async () => {
    const { runtime } = await makeRuntime()
    const res = await call(runtime, {
      path: '/dsh-reverse-proxy/start',
      method: 'POST',
      headers: CONTROL,
      remoteAddress: '10.0.0.5',
    })
    assert.equal(res.status, 403)
    assert.equal((res.body as { error: string }).error, 'loopback-required')
  })

  it('accepts control routes from any 127/8 loopback alias', async () => {
    const { runtime } = await makeRuntime()
    const res = await call(runtime, {
      path: '/dsh-reverse-proxy/status',
      headers: { 'x-dsh-reverse-proxy-control': '1', origin: 'http://127.0.0.2:3080' },
      remoteAddress: '127.0.0.2',
    })
    assert.equal(res.status, 200)
  })

  it('rejects invite bases that are not http(s) origins', async () => {
    const { runtime } = await makeRuntime()
    const res = await call(runtime, {
      path: '/dsh-reverse-proxy/invite',
      method: 'POST',
      headers: CONTROL,
      body: JSON.stringify({ publicBase: 'ftp://example.com' }),
    })
    assert.equal(res.status, 400)
    assert.equal((res.body as { error: string }).error, 'invalid-base')
  })

  it('refuses to build invites while the proxy is stopped', async () => {
    const { runtime } = await makeRuntime()
    const stopped = await call(runtime, {
      path: '/dsh-reverse-proxy/invite',
      method: 'POST',
      headers: CONTROL,
      body: '{}',
    })
    assert.equal(stopped.status, 409)
    assert.equal((stopped.body as { error: string }).error, 'not-running')

    await runtime.start()
    const running = await call(runtime, {
      path: '/dsh-reverse-proxy/invite',
      method: 'POST',
      headers: CONTROL,
      body: '{}',
    })
    assert.equal(running.status, 200)
    assert.match(
      (running.body as { inviteUrl: string }).inviteUrl,
      /^http:\/\/127\.0\.0\.1:\d+\/_dsh_reverse_proxy\/login\?invite=\S+$/,
    )
  })

  it('requires the control header and a loopback origin for mutations', async () => {
    const { runtime } = await makeRuntime()
    const noHeader = await call(runtime, { path: '/dsh-reverse-proxy/start', method: 'POST' })
    assert.equal(noHeader.status, 403)

    const evilOrigin = await call(runtime, {
      path: '/dsh-reverse-proxy/start',
      method: 'POST',
      headers: { 'x-dsh-reverse-proxy-control': '1', origin: 'http://evil.example' },
    })
    assert.equal(evilOrigin.status, 403)
  })

  it('enforces control authentication over a real HTTP listener without CORS exposure', async () => {
    const { runtime } = await makeRuntime()
    const port = await listenControl(runtime)
    const path = '/dsh-reverse-proxy/start'

    const crossSite = await http({
      port,
      path,
      method: 'POST',
      headers: { ...CONTROL, origin: 'https://evil.example' },
    })
    assert.equal(crossSite.status, 403)
    assert.deepEqual(JSON.parse(crossSite.body), { error: 'forbidden' })

    const missingHeader = await http({
      port,
      path,
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:3080' },
    })
    assert.equal(missingHeader.status, 403)

    const allowed = await http({ port, path, method: 'POST', headers: CONTROL })
    assert.equal(allowed.status, 200)
    assert.equal((JSON.parse(allowed.body) as { running: boolean }).running, true)
    assert.equal(allowed.headers['cache-control'], 'no-store')
    assert.equal(allowed.headers['x-content-type-options'], 'nosniff')
    assert.equal(allowed.headers['access-control-allow-origin'], undefined)
  })

  it('serves status and applies listen changes over the control route', async () => {
    const { runtime } = await makeRuntime()
    const bare = await call(runtime, { path: '/dsh-reverse-proxy/status' })
    assert.equal(bare.status, 403)

    const status = await call(runtime, { path: '/dsh-reverse-proxy/status', headers: CONTROL })
    assert.equal(status.status, 200)
    assert.equal((status.body as { running: boolean }).running, false)

    const changed = await call(runtime, {
      path: '/dsh-reverse-proxy/listen',
      method: 'POST',
      headers: CONTROL,
      body: JSON.stringify({ host: '0.0.0.0', port: 9081 }),
    })
    assert.equal(changed.status, 200)
    assert.deepEqual((changed.body as { listen: unknown }).listen, { host: '0.0.0.0', port: 9081 })

    const malformed = await call(runtime, {
      path: '/dsh-reverse-proxy/listen',
      method: 'POST',
      headers: CONTROL,
      body: '{not-json',
    })
    assert.equal(malformed.status, 400)
    assert.equal((malformed.body as { error: string }).error, 'invalid-request')
  })

  it('answers unknown paths with 404 and refuses to restart after dispose', async () => {
    const { runtime } = await makeRuntime()
    const missing = await call(runtime, { path: '/nope' })
    assert.equal(missing.status, 404)

    await runtime.dispose()
    const status = await runtime.start()
    assert.equal(status.reason, 'disposed')
    assert.equal(status.running, false)
  })

  it('keeps listen-failed on status until the address changes or a later start succeeds', async () => {
    const blocker = createServer()
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen(0, '127.0.0.1', resolve)
    })
    cleanups.push(() => new Promise<void>(resolve => blocker.close(() => resolve())))
    const addr = blocker.address()
    if (addr === null || typeof addr === 'string') throw new Error('expected a TCP bind')
    const occupied = addr.port
    const { runtime } = await makeRuntime()
    await runtime.setListen('127.0.0.1', occupied)
    const started = await runtime.start()
    assert.equal(started.running, false)
    assert.equal(started.reason, 'listen-failed')
    assert.equal((await runtime.status()).reason, 'listen-failed')

    await runtime.setListen('127.0.0.1', 0)
    assert.equal((await runtime.status()).reason, undefined)
    const retried = await runtime.start()
    assert.equal(retried.running, true)
    assert.equal(retried.reason, undefined)
  })
})

describe('audit log viewer', () => {
  it('returns recent audit events through the control route', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-reverse-proxy-audit-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const stateFile = join(dir, 'state.json')
    const auditFile = join(dir, 'audit.jsonl')
    await writeFile(auditFile, [
      JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', event: 'login.ok', remote: '1.2.3.4' }),
      JSON.stringify({ ts: '2026-01-01T00:00:01.000Z', event: 'proxy.start' }),
    ].join('\n') + '\n')
    const runtime = createRuntime(makeContext(), makeConfig(stateFile, {
      auditLog: true,
      auditLogFile: auditFile,
    }))
    cleanups.push(() => runtime.dispose())

    const res = await call(runtime, { path: '/dsh-reverse-proxy/audit', headers: CONTROL })
    assert.equal(res.status, 200)
    const body = res.body as { enabled: boolean, events: Array<{ event: string }> }
    assert.equal(body.enabled, true)
    assert.equal(body.events.length, 2)
    assert.equal(body.events[0].event, 'login.ok')
    assert.equal(body.events[1].event, 'proxy.start')
  })

  it('returns disabled state when audit logging is off', async () => {
    const { runtime } = await makeRuntime()
    const res = await call(runtime, { path: '/dsh-reverse-proxy/audit', headers: CONTROL })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { enabled: false, events: [] })
  })

  it('exports audit events as a JSON download', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-reverse-proxy-audit-export-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const stateFile = join(dir, 'state.json')
    const auditFile = join(dir, 'audit.jsonl')
    await writeFile(auditFile, [
      JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', event: 'login.ok' }),
      JSON.stringify({ ts: '2026-01-01T00:00:01.000Z', event: 'proxy.start' }),
    ].join('\n') + '\n')
    const runtime = createRuntime(makeContext(), makeConfig(stateFile, {
      auditLog: true,
      auditLogFile: auditFile,
    }))
    cleanups.push(() => runtime.dispose())

    const res = await call(runtime, { path: '/dsh-reverse-proxy/audit/export', headers: CONTROL })
    assert.equal(res.status, 200)
    const events = res.body as Array<{ event: string }>
    assert.equal(events.length, 2)
    assert.equal(events[0].event, 'login.ok')
    assert.equal(events[1].event, 'proxy.start')
  })

  it('filters and limits audit events through query parameters', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-reverse-proxy-audit-filter-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const stateFile = join(dir, 'state.json')
    const auditFile = join(dir, 'audit.jsonl')
    await writeFile(auditFile, [
      JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', event: 'login.ok', remote: '1.2.3.4' }),
      JSON.stringify({ ts: '2026-01-01T00:00:01.000Z', event: 'proxy.start' }),
      JSON.stringify({ ts: '2026-01-01T00:00:02.000Z', event: 'login.ok', remote: '5.6.7.8' }),
    ].join('\n') + '\n')
    const runtime = createRuntime(makeContext(), makeConfig(stateFile, {
      auditLog: true,
      auditLogFile: auditFile,
    }))
    cleanups.push(() => runtime.dispose())

    const filtered = await call(runtime, {
      path: '/dsh-reverse-proxy/audit?event=login.ok',
      headers: CONTROL,
    })
    assert.equal(filtered.status, 200)
    const filteredBody = filtered.body as { events: Array<{ event: string }> }
    assert.equal(filteredBody.events.length, 2)
    assert.equal(filteredBody.events[0].event, 'login.ok')
    assert.equal(filteredBody.events[1].event, 'login.ok')

    const limited = await call(runtime, {
      path: '/dsh-reverse-proxy/audit?limit=1',
      headers: CONTROL,
    })
    assert.equal(limited.status, 200)
    const limitedBody = limited.body as { events: Array<{ event: string }> }
    assert.equal(limitedBody.events.length, 1)
    assert.equal(limitedBody.events[0].event, 'login.ok')
  })
})

describe('one-click tunnel control', () => {
  const fakeTunnel = (calls: string[], onlineOnStart = false) => {
    let state: 'off' | 'starting' | 'online' = 'off'
    return {
      status: () => ({ state }),
      start: async () => { calls.push('start'); state = onlineOnStart ? 'online' : 'starting'; return { state } },
      stop: async () => { calls.push('stop'); state = 'off'; return { state } },
    }
  }

  it('refuses to start the tunnel while the proxy is stopped', async () => {
    const { runtime } = await makeRuntime()
    const res = await call(runtime, { path: '/dsh-reverse-proxy/tunnel/start', method: 'POST', headers: CONTROL })
    assert.equal(res.status, 409)
    assert.equal((res.body as { error: string }).error, 'not-running')
  })

  it('starts and stops the tunnel through the control routes and reports it in status', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-reverse-proxy-tunnel-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const stateFile = join(dir, 'state.json')
    const calls: string[] = []
    const runtime = createRuntime(makeContext(), makeConfig(stateFile), {
      createTunnel: () => fakeTunnel(calls),
    })
    cleanups.push(() => runtime.dispose())
    await runtime.start()

    const started = await call(runtime, { path: '/dsh-reverse-proxy/tunnel/start', method: 'POST', headers: CONTROL })
    assert.equal(started.status, 200)
    assert.equal((started.body as { tunnel: { state: string } }).tunnel.state, 'starting')

    const status = await call(runtime, { path: '/dsh-reverse-proxy/status', headers: CONTROL })
    assert.equal((status.body as { tunnel: { state: string } }).tunnel.state, 'starting')

    const stopped = await call(runtime, { path: '/dsh-reverse-proxy/tunnel/stop', method: 'POST', headers: CONTROL })
    assert.equal(stopped.status, 200)
    assert.equal((stopped.body as { tunnel: { state: string } }).tunnel.state, 'off')
    assert.deepEqual(calls, ['start', 'stop'])
  })

  it('rejects the tunnel when the proxy runs with local TLS', async () => {
    const { fileURLToPath } = await import('node:url')
    const cert = fileURLToPath(new URL('./fixtures/tls-cert.pem', import.meta.url))
    const key = fileURLToPath(new URL('./fixtures/tls-key.pem', import.meta.url))
    const dir = await mkdtemp(join(tmpdir(), 'dsh-reverse-proxy-tunnel-tls-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const runtime = createRuntime(makeContext(), makeConfig(join(dir, 'state.json'), {
      tlsCertFile: cert,
      tlsKeyFile: key,
    }), { createTunnel: () => fakeTunnel([]) })
    cleanups.push(() => runtime.dispose())
    const started = await runtime.start()
    assert.equal(started.running, true)

    const res = await call(runtime, { path: '/dsh-reverse-proxy/tunnel/start', method: 'POST', headers: CONTROL })
    assert.equal(res.status, 400)
    assert.equal((res.body as { error: string }).error, 'tls-unsupported')
  })

  it('requires the control header for tunnel routes', async () => {
    const { runtime } = await makeRuntime()
    const bare = await call(runtime, { path: '/dsh-reverse-proxy/tunnel/stop', method: 'POST' })
    assert.equal(bare.status, 403)
  })

  it('restarts a live tunnel after rotating the token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-reverse-proxy-tunnel-rotate-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const calls: string[] = []
    const runtime = createRuntime(makeContext(), makeConfig(join(dir, 'state.json')), {
      createTunnel: () => fakeTunnel(calls, true),
    })
    cleanups.push(() => runtime.dispose())
    await runtime.start()
    const started = await call(runtime, { path: '/dsh-reverse-proxy/tunnel/start', method: 'POST', headers: CONTROL })
    assert.equal(started.status, 200)
    await runtime.rotateToken()
    assert.deepEqual(calls, ['start', 'stop', 'start'])
  })
})
