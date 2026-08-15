/**
 * Real-boot smoke test for dsh-reverse-proxy.
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
 *
 * Usage (from the plugin repo root):
 *   DSH_HOME=$(mktemp -d) HARNESS_DIR=../deepseek-harness node scripts/smoke.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
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
  // 1. Build the plugin so `dsh plugin add` picks up current source.
  await run('pnpm', ['run', 'build'], { cwd: PLUGIN_DIR })

  // 2. Community-standard install: `dsh plugin add` for both bundles.
  await dsh(['plugin', '--profile', 'smoke', 'add', PLUGIN_DIR])
  await dsh(['plugin', '--profile', 'smoke', 'add', join(HARNESS_DIR, 'packages/bundle/web-app')])

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
    const status0 = await json(await fetchWithGrace(`${BASE}/dsh-reverse-proxy/status`, undefined, 'status'), 'status')
    assert(status0?.authenticated === true && status0?.running === false, 'status snapshot', JSON.stringify(status0))

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
    const token = await json(await fetch(`${BASE}/dsh-reverse-proxy/token`), 'token')
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

    phase = 'step9-stop'
    // 9. Clean stop.
    const stopped = await json(await fetch(`${BASE}/dsh-reverse-proxy/stop`, { method: 'POST', headers: CONTROL }), 'stop')
    assert(stopped?.running === false, 'proxy stop', JSON.stringify(stopped))
  } finally {
    kill()
  }

  if (failures.length > 0) {
    console.error(`[smoke] ${failures.length} failure(s).`)
    process.exit(1)
  }
  console.log('[smoke] PASS: real-boot control surface, login gate, rate limit, polyfill all verified.')
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
