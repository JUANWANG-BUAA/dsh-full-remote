/**
 * Cross-browser smoke for the real React settings fixture.
 *
 * This intentionally uses the fixture under scripts/screenshots rather than
 * a mocked DOM. It catches bundler, CSS, browser API, and hydration/runtime
 * regressions while keeping the test independent of a live Harness process.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const require = createRequire(import.meta.url)
const viteEntry = require.resolve('vite', { paths: [require.resolve('vitest')] })
const { createServer } = await import(pathToFileURL(viteEntry).href)

const server = await createServer({
  root: new URL('../scripts/screenshots/', import.meta.url).pathname,
  configFile: false,
  appType: 'spa',
  server: { host: '127.0.0.1', port: 4177, strictPort: true },
})
const browser = await chromium.launch({ headless: true })

try {
  await server.listen()
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto('http://127.0.0.1:4177/?chrome=0&narrow=1', { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: '反向代理' }).waitFor()
  if (await page.getByText('代理正在运行').count() !== 1) {
    throw new Error('browser smoke: running proxy status did not render')
  }
  await page.getByRole('button', { name: '运行自检' }).click()
  await page.getByText('本机特权通道已打开').waitFor()
  await page.getByRole('button', { name: '生成邀请' }).click()
  await page.getByText(/login\?invite=/).waitFor()
  if (errors.length > 0) throw new Error(`browser page errors:\n${errors.join('\n')}`)
  console.log('browser smoke passed: Chromium rendered, self-check and invite flows completed')
} finally {
  await browser.close()
  await server.close()
}
