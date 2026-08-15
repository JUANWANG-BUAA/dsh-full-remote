import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { RemoteAction } from './RemoteAction.tsx'
import { RemoteOverlay } from './RemoteOverlay.tsx'
import { createRemotePanelStore } from './store.ts'
import { bindTranslate } from './i18n.ts'
import type { ProxyApi, ProxyStatus } from './types.ts'

export const inject = ['slots']

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
  if (!response.ok) throw new Error(body.error ?? `请求失败 (${response.status})`)
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
  }
}

export function apply(ctx: ClientContext): void {
  const store = createRemotePanelStore()
  const api = createApi()
  const { t, dispose } = bindTranslate(ctx)
  if (dispose !== undefined) ctx.effect(() => dispose)
  // `sidebar.footer.action` is an ascending-order list slot; -1 pins this
  // entry above every other bottom control (Settings, third-party actions),
  // i.e. the very first row of the sidebar foot block.
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'reverse-proxy',
    order: -1,
    store,
    inject: () => ({ t }),
  }, RemoteAction))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'reverse-proxy',
    order: 40,
    store,
    inject: () => ({ api, t }),
  }, RemoteOverlay))
}
