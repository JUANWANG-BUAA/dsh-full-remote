/**
 * Client entry — settings section + control API for the Web UI.
 *
 * Registers one official slot (`settings.section`, order 30: after General,
 * Models, Plugins, Agent presets) and wires the loopback control API.
 * The locale service is OPTIONAL: present, the page follows the active
 * DSh locale; absent, it falls back to zh.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { RemoteSection } from './RemoteSection.tsx'
import { bindTranslate } from './i18n.ts'
import { trustSettingsPersistence } from './trust-settings.ts'
import type { AuditResult, InviteResult, ProxyApi, ProxyStatus, SelfCheckResult, SessionInfo } from './types.ts'

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/dsh-reverse-proxy${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      'x-dsh-reverse-proxy-control': '1',
    },
  })
  const body = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw errorFromControlResponse(response.status, body)
  return body as T
}

function createApi(): ProxyApi {
  const post = (path: string, body?: unknown) => request<ProxyStatus>(path, {
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
    rotateToken: () => request<ProxyStatus & { accessToken: string }>('/rotate-token', { method: 'POST' }),
    setListen: (host, port) => post('/listen', { host, port }),
    sessions: async () => (await request<{ sessions: SessionInfo[] }>('/sessions')).sessions ?? [],
    approveSession: id => request<{ ok: boolean }>(`/sessions/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    }),
    revokeSession: id => request<{ ok: boolean }>(`/sessions/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    }),
    renameSession: (id, label) => request<{ ok: boolean }>(`/sessions/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, label }),
    }),
    selfCheck: async () => {
      const result = await request<SelfCheckResult>('/self-check', { method: 'POST' })
      const trusted = (globalThis as { __DSH_FULL_REMOTE_TRUSTED__?: number }).__DSH_FULL_REMOTE_TRUSTED__ === 1
      const failed = (globalThis as { __DSH_FULL_REMOTE_BOOTSTRAP_FAILED__?: number }).__DSH_FULL_REMOTE_BOOTSTRAP_FAILED__ === 1
      return { ...result, trustBootstrap: trusted, bootstrapFailed: failed }
    },
    invite: (publicBase) => request<InviteResult>('/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(publicBase === undefined ? {} : { publicBase }),
    }),
    audit: (limit, event) => {
      const params = new URLSearchParams()
      if (limit !== undefined) params.set('limit', String(limit))
      if (event !== undefined && event !== '') params.set('event', event)
      const query = params.toString()
      return request<AuditResult>(`/audit${query === '' ? '' : `?${query}`}`)
    },
  }
}

export function apply(ctx: ClientContext): void {
  // Backup: official locale / theme / models bind during their own apply,
  // which is earlier than this plugin. The index-tap ModuleLoader wrap is
  // the path that actually reaches those consumers.
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
}
