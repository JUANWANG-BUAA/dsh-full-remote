import type { IncomingMessage, ServerResponse } from 'node:http'
import { readAuditLog, readAuditLogAll } from './audit.ts'
import { CONTROL_HEADER, CONTROL_HEADER_VALUE, CONTROL_PREFIX } from './control.ts'
import { isLoopbackHost } from './hosts.ts'
import { pathnameOf, readJson, sendJson } from './http-util.ts'
import type { RuntimeStatus } from './runtime-types.ts'

type ControlHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
type AuditRecord = (event: string, fields?: Record<string, unknown>) => Promise<void>
type ActionStatus = () => Promise<RuntimeStatus>

export type InviteResult =
  | { error: 'invalid-base' | 'not-running' }
  | { inviteUrl: string, qrSvg?: string }

export interface ControlRouteDeps {
  allowTokenRead: boolean
  audit: {
    enabled: boolean
    path?: string
    record: AuditRecord
  }
  warn(error: unknown): void
  exclusive<T>(fn: () => T | Promise<T>): Promise<T>
  shared<T>(fn: () => T | Promise<T>): Promise<T>
  snapshot(): Promise<RuntimeStatus>
  runSelfCheck(): Promise<unknown>
  buildInvite(publicBase?: string): Promise<InviteResult>
  readToken(): Promise<string>
  listSessions(): Promise<unknown[]>
  mutateSession(action: 'approve' | 'revoke' | 'rename', id: string, label?: string): Promise<boolean>
  startTunnel(): Promise<'ok' | 'not-running' | 'tls-unsupported' | 'disposed'>
  stopTunnel(): Promise<RuntimeStatus>
  start: ActionStatus
  stop: ActionStatus
  rotateToken: ActionStatus
  setListen(host: unknown, port: unknown): Promise<RuntimeStatus>
}

function isLoopbackOrigin(origin: string | undefined) {
  if (origin === undefined) return true
  try {
    return isLoopbackHost(new URL(origin).hostname)
  } catch {
    return false
  }
}

function auditQuery(req: IncomingMessage) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const rawLimit = Number(url.searchParams.get('limit') ?? 50)
  const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50
  const event = url.searchParams.get('event')?.trim() || undefined
  return { limit, event }
}

/** Build the authenticated loopback control API without owning runtime state. */
export function createControlRoutes(deps: ControlRouteDeps) {
  const withJson = (
    fn: (body: Record<string, unknown>, res: ServerResponse) => Promise<void>,
  ): ControlHandler => async (req, res) => {
    let body: Record<string, unknown>
    try {
      body = await readJson(req) as Record<string, unknown>
    } catch {
      sendJson(res, 400, { error: 'invalid-request' })
      return
    }
    try {
      await fn(body, res)
    } catch (error) {
      deps.warn(error)
      sendJson(res, 500, { error: 'action-failed' })
    }
  }

  const routes = new Map<string, ControlHandler>()
  const route = (method: string, suffix: string, handler: ControlHandler) => {
    routes.set(`${method} ${CONTROL_PREFIX}${suffix}`, handler)
  }

  const runAction = (action: ActionStatus): ControlHandler => async (_req, res) => {
    try {
      sendJson(res, 200, await deps.exclusive(action))
    } catch (error) {
      deps.warn(error)
      sendJson(res, 500, { error: 'action-failed' })
    }
  }

  route('GET', '/status', async (_req, res) => {
    sendJson(res, 200, await deps.shared(() => deps.snapshot()))
  })
  route('POST', '/self-check', async (_req, res) => {
    sendJson(res, 200, await deps.shared(() => deps.runSelfCheck()))
  })
  route('POST', '/invite', withJson(async (body, res) => {
    const invite = await deps.shared(() => deps.buildInvite(typeof body.publicBase === 'string' ? body.publicBase : undefined))
    if ('error' in invite) {
      sendJson(res, invite.error === 'not-running' ? 409 : 400, invite)
      return
    }
    void deps.audit.record('invite.create')
    sendJson(res, 200, invite)
  }))
  route('GET', '/token', async (_req, res) => {
    if (!deps.allowTokenRead) {
      sendJson(res, 403, { error: 'token-read-disabled' })
      return
    }
    sendJson(res, 200, { accessToken: await deps.readToken() })
  })
  route('GET', '/sessions', async (_req, res) => {
    sendJson(res, 200, { sessions: await deps.shared(() => deps.listSessions()) })
  })
  route('GET', '/audit', async (req, res) => {
    const { limit, event } = auditQuery(req)
    sendJson(res, 200, await deps.shared(async () => ({
      enabled: deps.audit.enabled,
      events: await readAuditLog(deps.audit.path, limit, event),
    })))
  })
  route('GET', '/audit/export', async (req, res) => {
    const { event } = auditQuery(req)
    const events = await deps.shared(() => readAuditLogAll(deps.audit.path, event))
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-disposition': 'attachment; filename="dsh-reverse-proxy-audit.json"',
      'x-content-type-options': 'nosniff',
    })
    res.end(JSON.stringify(events, null, 2))
  })
  route('POST', '/tunnel/start', async (_req, res) => {
    const outcome = await deps.exclusive(() => deps.startTunnel())
    if (outcome !== 'ok') {
      sendJson(res, outcome === 'not-running' || outcome === 'disposed' ? 409 : 400, { error: outcome })
      return
    }
    sendJson(res, 200, await deps.shared(() => deps.snapshot()))
  })
  route('POST', '/tunnel/stop', async (_req, res) => {
    sendJson(res, 200, await deps.exclusive(() => deps.stopTunnel()))
  })
  const mutateSession = (action: 'approve' | 'revoke' | 'rename'): ControlHandler => withJson(async (body, res) => {
    const id = typeof body.id === 'string' ? body.id : ''
    const label = typeof body.label === 'string' ? body.label : undefined
    const ok = await deps.mutateSession(action, id, label)
    sendJson(res, 200, { ok })
  })
  route('POST', '/sessions/approve', mutateSession('approve'))
  route('POST', '/sessions/revoke', mutateSession('revoke'))
  route('POST', '/sessions/rename', mutateSession('rename'))
  route('POST', '/start', runAction(deps.start))
  route('POST', '/stop', runAction(deps.stop))
  route('POST', '/rotate-token', runAction(deps.rotateToken))
  route('POST', '/listen', withJson(async (body, res) => {
    sendJson(res, 200, await deps.setListen(body.host, body.port))
  }))

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!isLoopbackHost(req.socket.remoteAddress ?? '')) {
      sendJson(res, 403, { error: 'loopback-required' })
      return
    }
    const handler = routes.get(`${req.method} ${pathnameOf(req.url)}`)
    if (handler === undefined) {
      sendJson(res, 404, { error: 'not-found' })
      return
    }
    if (req.headers[CONTROL_HEADER] !== CONTROL_HEADER_VALUE || !isLoopbackOrigin(req.headers.origin)) {
      sendJson(res, 403, { error: 'forbidden' })
      return
    }
    await handler(req, res)
  }

  return { handle }
}
