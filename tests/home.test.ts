import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import { listenProxy } from '../src/proxy.ts'
import { createSessionStore } from '../src/sessions.ts'
import { createInviteStore } from '../src/invites.ts'
import { generateAccessToken } from '../src/security.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

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

function cookieOf(response: HttpResponse): string {
  const setCookie = response.headers['set-cookie']
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie
  if (raw === undefined) throw new Error('no set-cookie in response')
  return raw.split(';', 1)[0]
}

interface Harness {
  port: number
  token: string
  sessions: ReturnType<typeof createSessionStore>
  audit: Array<{ event: string, fields?: Record<string, unknown> }>
  login: (extra?: string) => Promise<HttpResponse>
}

async function harness(options: {
  approvalMode?: boolean
  inviteStore?: ReturnType<typeof createInviteStore>
} = {}): Promise<Harness> {
  const token = generateAccessToken()
  const audit: Array<{ event: string, fields?: Record<string, unknown> }> = []
  const sessions = createSessionStore({
    maxSessions: 16,
    maxAgeSeconds: 3600,
    idleSeconds: 0,
    approvalRequired: false,
    onChange: () => {},
  })
  const proxy = await listenProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    backendHost: '127.0.0.1',
    backendPort: 3080,
    accessToken: token,
    cookieName: 'session',
    controlPrefix: '/dsh-reverse-proxy',
    maxRequestBytes: 4096,
    upstreamTimeoutMs: 2000,
    sessionMaxAgeSeconds: 3600,
    loginDelayMs: 0,
    sessionStore: sessions,
    approvalMode: options.approvalMode === true,
    ...(options.inviteStore === undefined ? {} : { inviteStore: options.inviteStore }),
    audit: (event, fields) => { audit.push({ event, ...(fields === undefined ? {} : { fields }) }) },
  })
  cleanups.push(proxy.close)
  const login = (extra = '') => http({
    port: proxy.port,
    path: '/_dsh_reverse_proxy/login',
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `token=${encodeURIComponent(token)}${extra}`,
  })
  return { port: proxy.port, token, sessions, audit, login }
}

describe('device home page', () => {
  it('redirects anonymous visitors to the login page', async () => {
    const h = await harness()
    const res = await http({ port: h.port, path: '/_dsh_reverse_proxy/home' })
    assert.equal(res.status, 303)
    assert.equal(res.headers.location, '/_dsh_reverse_proxy/login')
  })

  it('keeps the original landing at / (constraint) and serves home on demand', async () => {
    const h = await harness()
    const login = await h.login()
    assert.equal(login.status, 303)
    assert.equal(login.headers.location, '/')
    const home = await http({
      port: h.port,
      path: '/_dsh_reverse_proxy/home',
      headers: { cookie: cookieOf(login) },
    })
    assert.equal(home.status, 200)
    assert.match(home.body, /设备主页/)
    assert.match(home.body, /127\.0\.0\.1/)
    assert.match(home.body, /未开启审批/)
  })

  it('lands on home only when the secondary login button is used', async () => {
    const h = await harness()
    const login = await h.login('&next=home')
    assert.equal(login.status, 303)
    assert.equal(login.headers.location, '/_dsh_reverse_proxy/home')
  })

  it('shows the approval posture when approvalMode is on', async () => {
    const h = await harness({ approvalMode: true })
    const login = await h.login()
    const home = await http({
      port: h.port,
      path: '/_dsh_reverse_proxy/home',
      headers: { cookie: cookieOf(login) },
    })
    assert.equal(home.status, 200)
    assert.match(home.body, /需主人审批/)
  })

  it('renames only the signed-in device', async () => {
    const h = await harness()
    const first = await h.login()
    await h.login()
    assert.equal(h.sessions.list().length, 2)
    const renamed = await http({
      port: h.port,
      path: '/_dsh_reverse_proxy/home/rename',
      method: 'POST',
      headers: { cookie: cookieOf(first), 'content-type': 'application/x-www-form-urlencoded' },
      body: 'label=' + encodeURIComponent('小王的 iPhone'),
    })
    assert.equal(renamed.status, 303)
    assert.equal(renamed.headers.location, '/_dsh_reverse_proxy/home')
    const labels = h.sessions.list().map(record => record.label).sort()
    assert.equal(labels.filter(label => label === '小王的 iPhone').length, 1)
    assert.equal(labels.some(label => label !== '小王的 iPhone'), true)
  })

  it('rejects rename without an active session', async () => {
    const h = await harness()
    const res = await http({
      port: h.port,
      path: '/_dsh_reverse_proxy/home/rename',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'label=x',
    })
    assert.equal(res.status, 303)
    assert.equal(res.headers.location, '/_dsh_reverse_proxy/login')
  })

  it('accepts an invite re-POST from the same client inside the retry grace', async () => {
    const invites = createInviteStore({ retryGraceMs: 60_000 })
    const h = await harness({ inviteStore: invites })
    const code = invites.issue()
    const submit = () => http({
      port: h.port,
      path: '/_dsh_reverse_proxy/login',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'InvitePhone/1' },
      body: 'invite=' + encodeURIComponent(code),
    })
    // First submit consumes the code and signs the device in.
    const first = await submit()
    assert.equal(first.status, 303)
    assert.equal(first.headers.location, '/')
    // A browser retry after a lost redirect (same client IP) must not
    // deadlock into the token form: it reuses the same device session.
    const retry = await submit()
    assert.equal(retry.status, 303)
    assert.equal(retry.headers.location, '/')
    assert.equal(h.sessions.list().length, 1)
    assert.equal(h.audit.filter(event => event.event === 'login.ok' && event.fields?.via === 'invite').length, 2)
    assert.equal(h.audit.some(event => event.event === 'login.ok' && event.fields?.retry === true), true)
    // No failed-login noise from the legitimate retry.
    assert.equal(h.audit.filter(event => event.event === 'login.fail').length, 0)
  })

  it('does not resurrect a kicked device through the invite retry grace', async () => {
    const invites = createInviteStore({ retryGraceMs: 60_000 })
    const h = await harness({ inviteStore: invites })
    const code = invites.issue()
    const submit = () => http({
      port: h.port,
      path: '/_dsh_reverse_proxy/login',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'InvitePhone/1' },
      body: 'invite=' + encodeURIComponent(code),
    })
    const first = await submit()
    assert.equal(first.status, 303)
    const [device] = h.sessions.list()
    assert.equal(h.sessions.revoke(device.id), true)
    const retry = await submit()
    assert.equal(retry.status, 401)
    assert.equal(h.sessions.list().length, 0)
  })

  it('logout revokes only the signed-in device and expires the cookie', async () => {
    const h = await harness()
    const first = await h.login()
    const second = await h.login()
    assert.equal(h.sessions.list().length, 2)
    const out = await http({
      port: h.port,
      path: '/_dsh_reverse_proxy/logout',
      method: 'POST',
      headers: { cookie: cookieOf(first) },
    })
    assert.equal(out.status, 303)
    assert.equal(out.headers.location, '/_dsh_reverse_proxy/login')
    assert.match(String(out.headers['set-cookie']), /Max-Age=0/)
    assert.equal(h.sessions.list().length, 1)
    assert.equal(h.audit.some(event => event.event === 'session.logout'), true)

    // The revoked cookie can no longer reach home; the other device still can.
    const stale = await http({
      port: h.port,
      path: '/_dsh_reverse_proxy/home',
      headers: { cookie: cookieOf(first) },
    })
    assert.equal(stale.status, 303)
    const alive = await http({
      port: h.port,
      path: '/_dsh_reverse_proxy/home',
      headers: { cookie: cookieOf(second) },
    })
    assert.equal(alive.status, 200)
  })

  it('expires a Secure cookie with the Secure flag so HTTPS tunnels actually sign out', async () => {
    const token = generateAccessToken()
    const proxy = await listenProxy({
      listenHost: '127.0.0.1',
      listenPort: 0,
      backendHost: '127.0.0.1',
      backendPort: 3080,
      accessToken: token,
      cookieName: 'session',
      controlPrefix: '/dsh-reverse-proxy',
      maxRequestBytes: 4096,
      upstreamTimeoutMs: 2000,
      sessionMaxAgeSeconds: 3600,
      loginDelayMs: 0,
      trustForwardedProto: true,
    })
    cleanups.push(proxy.close)
    const login = await http({
      port: proxy.port,
      path: '/_dsh_reverse_proxy/login',
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-proto': 'https',
      },
      body: `token=${encodeURIComponent(token)}`,
    })
    assert.equal(login.status, 303)
    assert.match(String(login.headers['set-cookie']), /Secure/)
    const out = await http({
      port: proxy.port,
      path: '/_dsh_reverse_proxy/logout',
      method: 'POST',
      headers: {
        cookie: cookieOf(login),
        'x-forwarded-proto': 'https',
      },
    })
    assert.equal(out.status, 303)
    assert.match(String(out.headers['set-cookie']), /Max-Age=0/)
    assert.match(String(out.headers['set-cookie']), /Secure/)
  })
})
