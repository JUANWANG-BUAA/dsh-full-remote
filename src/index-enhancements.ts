import { PAGE_BOOTSTRAP_SOURCE } from './page-bootstrap.ts'

const VIEWPORT = 'width=device-width, initial-scale=1, viewport-fit=cover'
const INDEX_BOOTSTRAP = `<script data-plugin="dsh-reverse-proxy">${PAGE_BOOTSTRAP_SOURCE}</script>`

export function injectViewport(html: string) {
  return html.replace(
    /content="width=device-width, initial-scale=1(?:, viewport-fit=cover)?"/,
    `content="${VIEWPORT}"`,
  )
}

/**
 * Inject the small browser compatibility/bootstrap payload into the host
 * index. This transform is deliberately pure and idempotent because the
 * host may invoke index taps more than once during a reload.
 */
export function injectIndexEnhancements(html: string) {
  const withViewport = injectViewport(html)
  if (!withViewport.includes('<head>')) return withViewport
  if (withViewport.includes('data-plugin="dsh-reverse-proxy"')) return withViewport
  return withViewport.replace('<head>', `<head>${INDEX_BOOTSTRAP}`)
}
