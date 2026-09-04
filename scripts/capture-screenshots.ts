/**
 * Recapture README / repository screenshots from the live React settings section
 * and the gate HTML in src/pages.ts. Requires Google Chrome.
 *
 *   pnpm run screenshots
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homePage, loginPage, waitPage } from '../src/pages.ts'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const PORT = 4177
const ORIGIN = `http://127.0.0.1:${PORT}`
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const DEMO_TOKEN = 'demo-token-not-a-secret'

type Json = Record<string, unknown>

class Cdp {
  private id = 0
  private readonly pending = new Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void }>()
  private readonly events = new Map<string, Array<(params: unknown) => void>>()
  private readonly ws: WebSocket

  constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', event => {
      const msg = JSON.parse(String(event.data)) as {
        id?: number
        method?: string
        params?: unknown
        error?: { message?: string }
        result?: unknown
      }
      if (msg.method !== undefined) {
        for (const fn of this.events.get(msg.method) ?? []) fn(msg.params)
        return
      }
      if (msg.id === undefined) return
      const waiter = this.pending.get(msg.id)
      if (waiter === undefined) return
      this.pending.delete(msg.id)
      if (msg.error !== undefined) waiter.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
      else waiter.resolve(msg.result)
    })
  }

  send(method: string, params: Json = {}) {
    const id = ++this.id
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  once(method: string) {
    return new Promise<unknown>(resolve => {
      const fn = (params: unknown) => {
        const list = this.events.get(method) ?? []
        this.events.set(method, list.filter(item => item !== fn))
        resolve(params)
      }
      const list = this.events.get(method) ?? []
      list.push(fn)
      this.events.set(method, list)
    })
  }
}

function sleep(ms: number) {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

async function waitForWs(url: string) {
  for (let i = 0; i < 40; i += 1) {
    try {
      const ws = new WebSocket(url)
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => { resolve() }, { once: true })
        ws.addEventListener('error', () => { reject(new Error('ws error')) }, { once: true })
      })
      return ws
    } catch {
      await sleep(100)
    }
  }
  throw new Error(`cannot open ${url}`)
}

async function evalValue(cdp: Cdp, expression: string) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }) as { result?: { value?: unknown, subtype?: string, description?: string } }
  if (result.result?.subtype === 'error') {
    throw new Error(result.result.description ?? 'evaluate failed')
  }
  return result.result?.value
}

async function waitForText(cdp: Cdp, needle: string, timeoutMs = 10_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const text = await evalValue(cdp, 'document.body.innerText')
    if (typeof text === 'string' && text.includes(needle)) return
    await sleep(80)
  }
  throw new Error(`timed out waiting for ${JSON.stringify(needle)}`)
}

async function clickText(cdp: Cdp, label: string) {
  const clicked = await evalValue(cdp, `
    (() => {
      const needle = ${JSON.stringify(label)};
      const buttons = [...document.querySelectorAll('button')];
      const match = buttons.find(el => (el.textContent ?? '').trim() === needle)
        ?? buttons.find(el => (el.getAttribute('aria-label') ?? '').includes(needle));
      if (!match) return false;
      match.click();
      return true;
    })()
  `)
  if (clicked !== true) throw new Error(`button not found: ${label}`)
}

async function screenshotClip(cdp: Cdp, selector: string, path: string, pad = 0) {
  const box = await evalValue(cdp, `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()
  `) as { x: number, y: number, width: number, height: number } | null
  if (box === null) throw new Error(`missing ${selector}`)
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    fromSurface: true,
    clip: {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: Math.max(1, box.width + pad * 2),
      height: Math.max(1, box.height + pad * 2),
      scale: 1,
    },
  }) as { data: string }
  await writeFile(path, Buffer.from(shot.data, 'base64'))
}

async function screenshotPage(cdp: Cdp, path: string) {
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
  }) as { data: string }
  await writeFile(path, Buffer.from(shot.data, 'base64'))
}

async function setViewport(cdp: Cdp, width: number, height: number, scale: number, mobile: boolean) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: scale,
    mobile,
    screenWidth: width,
    screenHeight: height,
  })
}

async function fitSelector(cdp: Cdp, selector: string, width: number, scale: number, mobile: boolean, extra = 48) {
  await setViewport(cdp, width, 900, scale, mobile)
  const height = await evalValue(cdp, `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 900;
      const r = el.getBoundingClientRect();
      return Math.ceil(r.bottom + window.scrollY + ${extra});
    })()
  `)
  const next = Math.max(900, typeof height === 'number' ? height : 900)
  await setViewport(cdp, width, next, scale, mobile)
  await sleep(80)
}

async function setColorScheme(cdp: Cdp, value: 'dark' | 'light') {
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value }],
  })
}

async function goto(cdp: Cdp, url: string) {
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  const loaded = cdp.once('Page.loadEventFired')
  await cdp.send('Page.navigate', { url })
  await Promise.race([loaded, sleep(4000)])
  await sleep(150)
}

async function startVite() {
  const viteEntry = require.resolve('vite', { paths: [require.resolve('vitest')] })
  const { createServer } = await import(pathToFileURL(viteEntry).href) as {
    createServer: (inline: Json) => Promise<{
      listen: () => Promise<unknown>
      close: () => Promise<unknown>
    }>
  }
  const server = await createServer({
    root: join(here, 'screenshots'),
    configFile: false,
    appType: 'spa',
    server: {
      host: '127.0.0.1',
      port: PORT,
      strictPort: true,
      fs: { allow: [root] },
    },
  })
  await server.listen()
  return server
}

async function startChrome(profile: string) {
  const child = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--disable-extensions',
    '--disable-background-networking',
    '--font-render-hinting=none',
    '--force-color-profile=srgb',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  const wsUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('chrome did not print DevTools URL')) }, 8000)
    let buf = ''
    child.stderr?.on('data', chunk => {
      buf += String(chunk)
      const match = buf.match(/DevTools listening on (ws:\/\/\S+)/)
      if (match?.[1] !== undefined) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
  return { child, wsUrl }
}

async function connectPage(browserWs: string) {
  const parsed = new URL(browserWs)
  const listUrl = `http://${parsed.host}/json/list`
  for (let i = 0; i < 30; i += 1) {
    const pages = await (await fetch(listUrl)).json() as Array<{ type: string, webSocketDebuggerUrl?: string }>
    const page = pages.find(item => item.type === 'page' && item.webSocketDebuggerUrl)
    if (page?.webSocketDebuggerUrl !== undefined) return new Cdp(await waitForWs(page.webSocketDebuggerUrl))
    await sleep(100)
  }
  throw new Error('no page target')
}

async function preparePanel(cdp: Cdp) {
  await waitForText(cdp, '代理正在运行')
  await clickText(cdp, '运行自检')
  await waitForText(cdp, '本机特权通道已打开')
  await waitForText(cdp, '常驻令牌读取已开启')
  await clickText(cdp, '生成邀请')
  await waitForText(cdp, 'login?invite=')
  await clickText(cdp, '显示访问令牌')
  await waitForText(cdp, DEMO_TOKEN)
}

async function main() {
  const profile = await mkdtemp(join(tmpdir(), 'dsh-shots-'))
  const gates = join(profile, 'gates')
  await mkdir(gates)
  await writeFile(join(gates, 'login.html'), loginPage('zh'))
  await writeFile(join(gates, 'home.html'), homePage('zh', {
    host: 'http://192.168.3.23:3081',
    label: 'Safari on iOS',
    createdIp: '203.0.113.9',
    createdAt: Date.parse('2026-08-17T11:51:40+08:00'),
    sessionMaxAgeSeconds: 30 * 24 * 3600,
    approvalMode: true,
  }))
  await writeFile(join(gates, 'wait.html'), waitPage('zh', 'sess-demo', 'Safari on iOS'))

  let vite: Awaited<ReturnType<typeof startVite>> | undefined
  let chrome: { child: ChildProcess } | undefined
  try {
    vite = await startVite()
    const launched = await startChrome(profile)
    chrome = launched
    const cdp = await connectPage(launched.wsUrl)

    const docs = join(root, 'docs')
    const shots = join(docs, 'screenshots')
    await mkdir(shots, { recursive: true })

    await setColorScheme(cdp, 'dark')
    await setViewport(cdp, 720, 1200, 2, false)
    await goto(cdp, `${ORIGIN}/?chrome=0`)
    await preparePanel(cdp)
    await fitSelector(cdp, '[data-shot="section"]', 720, 2, false)
    await screenshotClip(cdp, '[data-shot="section"]', join(shots, 'preview-desktop.png'), 8)
    await screenshotClip(cdp, '[data-shot="invite"]', join(shots, 'preview-invite.png'), 4)
    await screenshotClip(cdp, '[data-shot="invite"]', join(docs, 'rp-demo-invite.png'), 4)
    await screenshotClip(cdp, '[data-shot="listen"]', join(docs, 'rp-demo-listen-address.png'), 4)
    await screenshotClip(cdp, '[data-shot="token"]', join(docs, 'rp-demo-token.png'), 4)
    await screenshotClip(cdp, '[data-shot="check"]', join(docs, 'rp-demo-self-check.png'), 4)

    await clickText(cdp, '重命名: Chrome on macOS')
    await waitForText(cdp, '保存')
    await screenshotClip(cdp, '[data-shot="devices"]', join(shots, 'preview-devices.png'), 4)

    await setViewport(cdp, 800, 980, 2, false)
    await goto(cdp, `${ORIGIN}/`)
    await preparePanel(cdp)
    await screenshotPage(cdp, join(docs, 'rp-demo-panel.png'))

    await setViewport(cdp, 390, 1200, 3, true)
    await goto(cdp, `${ORIGIN}/?chrome=0&narrow=1`)
    await preparePanel(cdp)
    await fitSelector(cdp, '[data-shot="section"]', 390, 3, true)
    await screenshotClip(cdp, '[data-shot="section"]', join(shots, 'preview-mobile-panel.png'), 8)

    await setColorScheme(cdp, 'light')
    await setViewport(cdp, 720, 520, 2, false)
    await goto(cdp, pathToFileURL(join(gates, 'login.html')).href)
    await waitForText(cdp, '设备主页')
    await screenshotPage(cdp, join(docs, 'rp-demo-login.png'))

    await setColorScheme(cdp, 'dark')
    await setViewport(cdp, 390, 844, 3, true)
    await goto(cdp, pathToFileURL(join(gates, 'login.html')).href)
    await waitForText(cdp, '设备主页')
    await screenshotPage(cdp, join(shots, 'preview-mobile-login.png'))
    await screenshotPage(cdp, join(docs, 'rp-demo-mobile-login.png'))

    await setColorScheme(cdp, 'dark')
    await setViewport(cdp, 720, 900, 2, false)
    await goto(cdp, pathToFileURL(join(gates, 'home.html')).href)
    await waitForText(cdp, '给这台设备起个名字')
    await screenshotClip(cdp, '.card', join(shots, 'preview-home.png'), 16)

    await goto(cdp, pathToFileURL(join(gates, 'wait.html')).href)
    await waitForText(cdp, '等待批准中')
    await screenshotClip(cdp, '.card', join(shots, 'preview-wait.png'), 16)

    console.log('screenshots written under docs/screenshots and docs/rp-demo-*.png; the npm package links to the repository gallery')
  } finally {
    chrome?.child.kill('SIGKILL')
    await vite?.close()
    await sleep(250)
    await rm(profile, { recursive: true, force: true }).catch(() => undefined)
  }
}

await main()
