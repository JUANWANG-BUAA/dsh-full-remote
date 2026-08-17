/**
 * self-check — probe whether Host/Origin rewrite would open the harness
 * privilege fence for `settings.describe`.
 *
 * Hits the backend directly with the same rewriteAuthority the proxy uses.
 * A 403 means the fence is still closed; any other status means the Host
 * check passed (the method may still 404/400 without a full RPC body).
 */
import { request as httpRequest } from 'node:http'
import { rewriteLoopbackAuthority, asError } from './http-util.ts'

const METHOD = 'settings.describe'
const PATH = `/api/${METHOD}`

/**
 * @param {{
 *   backendHost: string,
 *   backendPort: number,
 *   timeoutMs?: number,
 * }} spec
 * @returns {Promise<{
 *   ok: boolean,
 *   method: string,
 *   status: number,
 *   rewriteAuthority: string,
 *   detail?: string,
 * }>}
 */
export function probeFence(spec: {
  backendHost: string
  backendPort: number
  timeoutMs?: number
}): Promise<{
  ok: boolean
  method: string
  status: number
  rewriteAuthority: string
  detail?: string
}> {
  const rewriteAuthority = rewriteLoopbackAuthority(spec.backendPort)
  const timeoutMs = spec.timeoutMs ?? 3_000
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: 'dsh-full-remote-self-check',
    method: METHOD,
    payload: { args: {} },
  })

  return new Promise((resolve) => {
    const up = httpRequest({
      hostname: spec.backendHost,
      port: spec.backendPort,
      path: PATH,
      method: 'POST',
      headers: {
        host: rewriteAuthority,
        origin: `http://${rewriteAuthority}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-dsh-reverse-proxy': '1',
      },
    }, (incoming) => {
      clearTimeout(timer)
      incoming.resume()
      const status = incoming.statusCode ?? 0
      resolve({
        ok: status !== 403 && status !== 0,
        method: METHOD,
        status,
        rewriteAuthority,
        ...(status === 403 ? { detail: 'privilege-fence-denied' } : {}),
      })
    })
    const timer = setTimeout(() => {
      up.destroy(new Error('self-check timeout'))
    }, timeoutMs)
    timer.unref?.()
    up.on('error', (error) => {
      clearTimeout(timer)
      resolve({
        ok: false,
        method: METHOD,
        status: 0,
        rewriteAuthority,
        detail: asError(error).message,
      })
    })
    up.end(body)
  })
}
