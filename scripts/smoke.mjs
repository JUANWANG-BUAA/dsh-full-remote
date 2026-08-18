/**
 * Real-boot smoke test for dsh-full-remote.
 *
 * Boots a real DeepSeek Harness web profile with this plugin installed via
 * the community-standard `dsh plugin add` flow, then exercises the control
 * surface, the proxy login gate, the rate limiter, and the index polyfill
 * over real HTTP. This is the seam-drift alarm: it fails when webServer,
 * the client slots, or the bundle manifest change underneath us.
 *
 * Environment:
 *   HARNESS_DIR  path to a deepseek-harness checkout (required, installed)
 *   DSH_HOME     temp home for the smoke profile (required; is mutated)
 *   PORT         main DeepSeek Harness web port (default 3199)
 *   PACK_PLUGIN  set to 1 to install the npm tarball (default 0)
 *
 * Usage (from the plugin repo root):
 *   DSH_HOME=$(mktemp -d) HARNESS_DIR=../deepseek-harness node scripts/smoke.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = join(fileURLToPath(import.meta.url), '..', '..')
const HARNESS_DIR = process.env.HARNESS_DIR
const PORT = process.env.PORT ?? '3199'
const BASE = `http://127.0.0.1:${PORT}`
const CONTROL = { 'x-dsh-reverse-proxy-control': '1', origin: BASE }

if (HARNESS_DIR === undefined) {
  console.error('[smoke] HARNESS_DIR is required (path to an installed deepseek-harness checkout).')
  process.exit(2)
}

const failures = []
let exited = null
const bootLog = []
let phase = 'setup'
function fail(step, detail) {
  failures.push(`${step}: ${detail}`)
  console.error(`[smoke] FAIL ${step}: ${detail}`)
}

function assert(condition, step, detail) {
  if (!condition) fail(step, detail)
  return condition
}

async function json(response, step) {
  const text = await response.text().catch(() => '')
  try {
    return JSON.parse(text)
  } catch {
    fail(step, `expected JSON, got: ${text.slice(0, 200)}`)
    return undefined
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}`))
    })
  })
}

async function dsh(args) {
  // The harness CLI lives inside the checkout; its own pnpm is the entry.
  await run('pnpm', ['dsh', ...args], { cwd: HARNESS_DIR })
}

async function waitForBoot(exited = () => null) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (exited() !== null) return
    try {
      const response = await fetch(BASE, { redirect: 'manual' })
      if (response.status < 500) return
    } catch {
      // not up yet
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('server did not boot within 120s')
}

async function main() {
  // 1. Build the plugin. PACK_PLUGIN verifies the actual `files` allowlist
  // and package entrypoint instead of only exercising a source directory.
  await run('pnpm', ['run', 'build'], { cwd: PLUGIN_DIR })

  let pluginSource = PLUGIN_DIR
  if (process.env.PACK_PLUGIN === '1') {
    const packDir = join(process.env.DSH_HOME, 'plugin-pack')
    await run('pnpm', ['pack', '--pack-destination', packDir], { cwd: PLUGIN_DIR })
    const archives = (await readdir(packDir)).filter(file => file.endsWith('.tgz'))
    if (archives.length !== 1) throw new Error(`expected one plugin tarball, found ${archives.length}`)
    pluginSource = join(packDir, archives[0])
  }

  // 2. Community-standard install: web-app first, then this plugin.
  // `dsh plugin add` appends to `dsh.profile.bundles`. Our later patch layer
  // conditionally disables the adaptive picker and enables the browse pair;
  // adding web-app first keeps the target row present for that override.
  await dsh(['plugin', '--profile', 'smoke', 'add', join(HARNESS_DIR, 'packages/bundle/web-app')])
  await dsh(['plugin', '--profile', 'smoke', 'add', pluginSource])

  // The production-safe default keeps standing token reads disabled. This
  // black-box flow needs a token to exercise the login/session path, so make
  // the opt-in explicit in the isolated smoke home rather than weakening the
  // plugin's shipped patch or silently relying on a default.
  await writeFile(join(process.env.DSH_HOME, 'cordis.patch.yml'), [
    '- id: reverse-proxy',
    '  config:',
    '    allowTokenRead: true',
    '',
  ].join('\n'))

  // 3. Boot the real composition.
  const server = spawn('pnpm', ['dsh', '--profile', 'smoke', '--port', PORT], {
    cwd: HARNESS_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  server.stderr.on('data', chunk => bootLog.push(String(chunk)))
  server.stdout.on('data', chunk => bootLog.push(String(chunk)))
  server.once('exit', code => { exited = code })
  const kill = () => {
    try { process.kill(-server.pid, 'SIGTERM') } catch { /* already gone */ }
  }
  try {
    await waitForBoot(() => exited)
    if (exited !== null) {
      console.error(`[smoke] server exited during boot (code ${exited}):\n${bootLog.join('').split('\n').slice(-20).join('\n')}`)
      process.exit(1)
    }

    // The boot banner can print before the listener is fully ready; give the
    // control route a short grace window before declaring the boot broken.
    const fetchWithGrace = async (url, init, step) => {
      let last
      for (let attempt = 0; attempt < 12; attempt++) {
        try {
          return await fetch(url, init)
        } catch (error) {
          last = error
          await new Promise(resolve => setTimeout(resolve, 500))
        }
      }
      fail(step, `fetch ${url} failed after retries: ${last instanceof Error ? `${last.message} cause=${String(last.cause)}` : String(last)}`)
      return undefined
    }

    phase = 'step4-status/listen/start'
    // 4. Control surface: status, listen, start.
    const status0 = await json(await fetchWithGrace(`${BASE}/dsh-reverse-proxy/status`, { headers: CONTROL }, 'status'), 'status')
    assert(status0?.running === false, 'status snapshot', JSON.stringify(status0))
    assert(status0?.trustForwardedFor === false, 'default trustForwardedFor', JSON.stringify(status0))

    const audit0 = await json(await fetch(`${BASE}/dsh-reverse-proxy/audit`, { headers: CONTROL }), 'audit viewer')
    assert(audit0?.enabled === true && Array.isArray(audit0?.events), 'audit viewer', JSON.stringify(audit0))

    const listen = await json(await fetch(`${BASE}/dsh-reverse-proxy/listen`, {
      method: 'POST', headers: { ...CONTROL, 'content-type': 'application/json' },
      body: JSON.stringify({ host: '127.0.0.1', port: 0 }),
    }), 'listen')
    assert(listen !== undefined, 'listen call', 'no JSON response')

    const started = await json(await fetch(`${BASE}/dsh-reverse-proxy/start`, {
      method: 'POST', headers: CONTROL,
    }), 'start')
    assert(started?.running === true && started?.target !== undefined, 'proxy start', JSON.stringify(started))
    if (started?.running !== true) return
    const proxyPort = new URL(started.target).port
    const proxy = `http://127.0.0.1:${proxyPort}`

    phase = 'step5-login-redirect'
    // 5. Unauthenticated traffic redirects to the login gate.
    const anonymous = await fetch(proxy, { redirect: 'manual' })
    assert(anonymous.status === 303 && anonymous.headers.get('location')?.includes('/_dsh_reverse_proxy/login'), 'login redirect', `status ${anonymous.status}`)

    phase = 'step6-rate-limit'
    // 6. Rate limiter: N failures, then 429.
    const attempts = 6
    let last
    for (let i = 0; i < attempts; i++) {
      const response = await fetch(`${proxy}/_dsh_reverse_proxy/login`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'token=wrong',
      })
      last = response.status
    }
    assert(last === 429, 'rate limit lockout', `expected 429 after ${attempts} failures, got ${last}`)

    phase = 'step7-token-login'
    // 7. Restart resets the buckets, then the real token logs in. The listen
    // override is port 0, so a restart can land on a NEW free port — always
    // re-read the target from the fresh start response.
    await fetch(`${BASE}/dsh-reverse-proxy/stop`, { method: 'POST', headers: CONTROL })
    const restarted = await json(await fetch(`${BASE}/dsh-reverse-proxy/start`, { method: 'POST', headers: CONTROL }), 'restart')
    assert(restarted?.running === true, 'proxy restart', JSON.stringify(restarted))
    const restartedProxy = `http://127.0.0.1:${new URL(restarted.target).port}`
    const token = await json(await fetch(`${BASE}/dsh-reverse-proxy/token`, { headers: CONTROL }), 'token')
    assert(typeof token?.accessToken === 'string' && token.accessToken.length >= 24, 'token reveal', JSON.stringify(token))
    const login = await fetch(`${restartedProxy}/_dsh_reverse_proxy/login`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: token.accessToken }).toString(),
      redirect: 'manual',
    })
    const setCookie = login.headers.get('set-cookie') ?? ''
    assert(login.status === 303 && setCookie.includes('dsh_reverse_proxy_session='), 'token login', `status ${login.status}, cookie ${setCookie.slice(0, 40)}`)
    const cookie = setCookie.split(';', 1)[0]

    phase = 'step8-polyfill-index'
    // 8. Authenticated index carries the remote-context polyfill + viewport.
    const index = await fetch(restartedProxy, { headers: { cookie } })
    const html = await index.text()
    assert(index.status === 200, 'authenticated index', `status ${index.status}`)
    assert(html.includes('data-plugin="dsh-reverse-proxy"'), 'randomUUID polyfill', 'marker missing from index')
    assert(html.includes('viewport-fit=cover'), 'viewport injection', 'viewport-fit missing from index')

    phase = 'step8-privileged-api-fence'
    // 8b. Exercise the real privileged RPC routes through the proxy. A
    // successful non-403 response proves both auth and Host/Origin rewriting;
    // method-level business errors are still useful evidence that the fence
    // was passed and are reported without making the smoke fixture dependent
    // on local settings/credential contents.
    const rpc = async (method, args) => fetch(`${restartedProxy}/api/${method}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `smoke-${method}`,
        method,
        payload: { args },
      }),
    })
    for (const [method, args] of [
      ['settings.describe', {}],
      ['credentials.describe', { refs: [] }],
      ['host.listDirectory', {}],
    ]) {
      const response = await rpc(method, args)
      assert(response.status !== 401 && response.status !== 403, `${method} fence`, `status ${response.status}`)
      await response.arrayBuffer()
    }

    phase = 'step9-stop'
    // 9. Per-device sessions: the login created one device; kicking it must
    // revoke the cookie immediately.
    const listed = await json(await fetch(`${BASE}/dsh-reverse-proxy/sessions`, { headers: CONTROL }), 'sessions list')
    assert(Array.isArray(listed?.sessions) && listed.sessions.length >= 1, 'device session listed', JSON.stringify(listed))
    if (listed === undefined) return
    const deviceId = listed.sessions[0].id
    const revoked = await json(await fetch(`${BASE}/dsh-reverse-proxy/sessions/revoke`, {
      method: 'POST', headers: { ...CONTROL, 'content-type': 'application/json' },
      body: JSON.stringify({ id: deviceId }),
    }), 'session revoke')
    assert(revoked?.ok === true, 'session revoke ok', JSON.stringify(revoked))
    const kicked = await fetch(restartedProxy, { headers: { cookie }, redirect: 'manual' })
    assert(kicked.status === 303, 'revoked device redirected to login', `status ${kicked.status}`)

    // 10. Clean stop.
    const stopped = await json(await fetch(`${BASE}/dsh-reverse-proxy/stop`, { method: 'POST', headers: CONTROL }), 'stop')
    assert(stopped?.running === false, 'proxy stop', JSON.stringify(stopped))
  } finally {
    kill()
  }

  if (failures.length > 0) {
    console.error(`[smoke] ${failures.length} failure(s).`)
    process.exit(1)
  }
  console.log('[smoke] PASS: control surface, login gate, rate limit, polyfill, device sessions all verified.')
}

const home = await mkdtemp(join(tmpdir(), 'dsh-smoke-'))
// Always isolate the smoke profile in its own home: the caller's environment
// may carry a DSH_HOME pointing at a real installation, and this script must
// never touch it.
process.env.DSH_HOME = home
try {
  await main()
} catch (error) {
  console.error(`[smoke] ERROR [${phase}] ${error instanceof Error ? error.message : String(error)} cause=${error instanceof Error ? String(error.cause) : ''}`)
  console.error(`[smoke] server exited: ${exited}, boot log:\n${bootLog.join('')}`)
  process.exit(1)
} finally {
  await rm(home, { recursive: true, force: true }).catch(() => {})
}
