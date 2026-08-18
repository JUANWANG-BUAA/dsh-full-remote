/**
 * Client entry — settings section + control API for the Web UI.
 *
 * Registers one official slot (`settings.section`, order 30: after General,
 * Models, Plugins, Agent presets) and wires the loopback control API.
 * The locale service is OPTIONAL: present, the page follows the active
 * DSh locale; absent, it falls back to zh.
 *
 * Also registers a `shell.overlay` confirmation sheet so a remote/mobile
 * browser can answer userQuestions and tool approvals that would otherwise
 * only appear in the host conversation composer.
 */
import type { ClientContext, ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import { RemoteSection } from './RemoteSection.tsx'
import { InteractionOverlay } from './InteractionOverlay.tsx'
import { createPendingSource } from './pending-source.ts'
import { bindTranslate } from './i18n.ts'
import { trustSettingsPersistence } from './trust-settings.ts'
import type { AuditResult, InviteResult, ProxyApi, ProxyStatus, SelfCheckResult, SessionInfo } from './types.ts'
import { CONTROL_HEADER, CONTROL_HEADER_VALUE, CONTROL_PREFIX } from '../control.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'settings.section': {
      kind: 'list'
      scope: 'root'
      owner: { close: () => void }
    }
  }
}

export const inject = ['slots']

/**
 * Map a control-surface HTTP failure to the Error `toastFromCaught` already
 * understands. The public proxy answers `/dsh-reverse-proxy/*` with plain
 * `403 forbidden` (not JSON), so a phone that opens Settings → Reverse proxy
 * must not surface a locale-stuck "请求失败 (403)".
 */
export function errorFromControlResponse(status: number, body: { error?: string }): Error {
  const code = typeof body.error === 'string' ? body.error.trim() : ''
  if (code !== '') return new Error(code)
  if (status === 403 || status === 401) return new Error('forbidden')
  return new Error(`HTTP ${status}`)
}

function withQuery(path: string, params: Record<string, string | number | undefined>) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue
    search.set(key, String(value))
  }
  const query = search.toString()
  return query === '' ? path : `${path}?${query}`
}

function controlFetch(path: string, init?: RequestInit) {
  return fetch(`${CONTROL_PREFIX}${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      [CONTROL_HEADER]: CONTROL_HEADER_VALUE,
    },
  })
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await controlFetch(path, init)
  const body = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw errorFromControlResponse(response.status, body)
  return body as T
}

async function requestBlob(path: string): Promise<Blob> {
  const response = await controlFetch(path)
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    throw errorFromControlResponse(response.status, body)
  }
  return response.blob()
}

function createApi(): ProxyApi {
  const post = <T = ProxyStatus>(path: string, body?: unknown) => request<T>(path, {
    method: 'POST',
    ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  })
  return {
    status: () => request<ProxyStatus>('/status'),
    start: () => post('/start'),
    stop: () => post('/stop'),
    token: async () => (await request<{ accessToken: string }>('/token')).accessToken,
    rotateToken: () => post<ProxyStatus & { accessToken: string }>('/rotate-token'),
    setListen: (host, port) => post('/listen', { host, port }),
    sessions: async () => (await request<{ sessions: SessionInfo[] }>('/sessions')).sessions ?? [],
    approveSession: id => post<{ ok: boolean }>('/sessions/approve', { id }),
    revokeSession: id => post<{ ok: boolean }>('/sessions/revoke', { id }),
    renameSession: (id, label) => post<{ ok: boolean }>('/sessions/rename', { id, label }),
    selfCheck: async () => {
      const result = await post<SelfCheckResult>('/self-check')
      const trusted = (globalThis as { __DSH_FULL_REMOTE_TRUSTED__?: number }).__DSH_FULL_REMOTE_TRUSTED__ === 1
      const failed = (globalThis as { __DSH_FULL_REMOTE_BOOTSTRAP_FAILED__?: number }).__DSH_FULL_REMOTE_BOOTSTRAP_FAILED__ === 1
      return { ...result, trustBootstrap: trusted, bootstrapFailed: failed }
    },
    invite: (publicBase) => post<InviteResult>('/invite', publicBase === undefined ? {} : { publicBase }),
    audit: (limit, event) => request<AuditResult>(withQuery('/audit', { limit, event })),
    startTunnel: () => post('/tunnel/start'),
    stopTunnel: () => post('/tunnel/stop'),
    exportAudit: event => requestBlob(withQuery('/audit/export', { event })),
  }
}

export function apply(ctx: ClientContext): void {
  // Backup: official locale / theme / models bind during their own apply,
  // which is earlier than this plugin. The index-tap pin of
  // connection.isLoopback is the path that reaches those consumers. If
  // that pin already succeeded, trustSettingsPersistence does not assign
  // through the settingsScope Service proxy (same class of bug as #9).
  ctx.inject(['settingsScope'], (scope: ClientContext) => {
    const binder = scope.get('settingsScope') as { bind: (spec: unknown) => unknown }
    trustSettingsPersistence(binder, () => scope.get('connection') as { isLoopback?: boolean } | undefined)
  })
  const api = createApi()
  const { t, dispose } = bindTranslate(ctx)
  if (dispose !== undefined) ctx.effect(() => dispose)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'reverse-proxy',
    order: 30,
    label: () => t('action.label'),
    inject: () => ({ api, t }),
  }, RemoteSection))
  ctx.inject(['sessions'], (scope: ClientContext) => {
    const sessions = scope.get('sessions') as ISessions | undefined
    if (sessions === undefined) return
    const source = createPendingSource(sessions)
    scope.effect(() => () => { source.dispose() }, 'reverse-proxy: pending overlay')
    scope.slots.inject('shell.overlay', () => scope.slots.register({
      name: 'shell.overlay',
      id: 'reverse-proxy-interact',
      order: 40,
      inject: () => ({
        t,
        openSession: (id: string) => { sessions.open(id as Parameters<ISessions['open']>[0]) },
        answerApproval: (key: string, outcome: 'allowed-once' | 'rejected') => source.answerApproval(key, outcome),
        answerQuestion: source.answerQuestion,
        cancelQuestion: source.cancelQuestion,
        hooks: { remotePending: source },
      }),
    }, InteractionOverlay))
  })
}
