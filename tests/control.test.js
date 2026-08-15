import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../src/index.js'
import { request } from 'node:http'

const cleanups = []
afterEach(async () => {
  // Sequential reverse order: disposers may write state files, so a parallel
  // rm would race them.
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

function makeConfig(stateFile, extra = {}) {
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
  }
}

function makeContext() {
  return { webServer: { port: 3080 }, logger: { warn() {}, info() {}, debug() {} } }
}

async function makeRuntime() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-reverse-proxy-control-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const stateFile = join(dir, 'state.json')
  const runtime = createRuntime(makeContext(), makeConfig(stateFile))
  cleanups.push(() => runtime.dispose())
  return { runtime, stateFile }
}

function fakeRes() {
  const res = { statusCode: 0, headers: {}, body: '' }
  res.writeHead = (code, headers = {}) => {
    res.statusCode = code
    Object.assign(res.headers, headers)
  }
  res.end = (body = '') => {
    res.body += String(body)
  }
  return res
}

function fakeReq({ path, method = 'GET', headers = {}, remoteAddress = '127.0.0.1', body }) {
  const handlers = {}
  const req = {
    url: path,
    method,
    headers,
    socket: { remoteAddress },
    on(event, fn) {
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

function http({ port, path = '/', method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = []
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

async function call(runtime, { path, method = 'GET', headers = {}, remoteAddress = '127.0.0.1', body }) {
  const res = fakeRes()
  await runtime.handle(fakeReq({ path, method, headers, remoteAddress, body }), res)
  return {
    status: res.statusCode,
    body: res.body === '' ? {} : JSON.parse(res.body),
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
    const proxyPort = new URL(started.target).port

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
    assert.match(login.headers.location, /^\/_dsh_reverse_proxy\/wait\//)

    // The control surface lists the pending device.
    const listed = await call(runtime, { path: '/dsh-reverse-proxy/sessions', method: 'GET' })
    assert.equal(listed.status, 200)
    assert.equal(listed.body.sessions.length, 1)
    assert.equal(listed.body.sessions[0].status, 'pending')
    assert.equal(listed.body.sessions[0].label, 'Chrome on macOS')
    const id = listed.body.sessions[0].id

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
    const afterApprove = await call(runtime, { path: '/dsh-reverse-proxy/sessions', method: 'GET' })
    assert.equal(afterApprove.body.sessions[0].status, 'active')

    // Revoke; the list drains.
    const revoked = await call(runtime, {
      path: '/dsh-reverse-proxy/sessions/revoke',
      method: 'POST',
      headers: { ...CONTROL, 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    assert.deepEqual(revoked.body, { ok: true })
    const afterRevoke = await call(runtime, { path: '/dsh-reverse-proxy/sessions', method: 'GET' })
    assert.deepEqual(afterRevoke.body.sessions, [])
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
    assert.equal(res.body.error, 'loopback-required')
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

  it('serves status and applies listen changes over the control route', async () => {
    const { runtime } = await makeRuntime()
    const status = await call(runtime, { path: '/dsh-reverse-proxy/status' })
    assert.equal(status.status, 200)
    assert.equal(status.body.running, false)

    const changed = await call(runtime, {
      path: '/dsh-reverse-proxy/listen',
      method: 'POST',
      headers: CONTROL,
      body: JSON.stringify({ host: '0.0.0.0', port: 9081 }),
    })
    assert.equal(changed.status, 200)
    assert.deepEqual(changed.body.listen, { host: '0.0.0.0', port: 9081 })

    const malformed = await call(runtime, {
      path: '/dsh-reverse-proxy/listen',
      method: 'POST',
      headers: CONTROL,
      body: '{not-json',
    })
    assert.equal(malformed.status, 400)
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
})
