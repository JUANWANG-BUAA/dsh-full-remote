import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { errorFromControlResponse } from '../src/client/index.ts'
import { RemoteSection } from '../src/client/RemoteSection.tsx'
import {
  pageNeedsHostSettingsPersistence,
  trustSettingsPersistence,
} from '../src/client/trust-settings.ts'
import type { ProxyApi, ProxyStatus } from '../src/client/types.ts'
import { translatorFor, zh, en, type ReverseProxyTranslate } from '../src/client/i18n.ts'
import { toastFromCaught, toastFromStatus } from '../src/client/toast.ts'

afterEach(cleanup)

const stopped: ProxyStatus = {
  enabled: false,
  running: false,
  target: 'http://127.0.0.1:3081',
  backend: 'http://127.0.0.1:3080',
  listen: { host: '127.0.0.1', port: 3081 },
}

function api(overrides: Partial<ProxyApi> = {}): ProxyApi {
  return {
    status: vi.fn().mockResolvedValue(stopped),
    start: vi.fn().mockResolvedValue({ ...stopped, enabled: true, running: true }),
    stop: vi.fn().mockResolvedValue(stopped),
    token: vi.fn().mockResolvedValue('secret-token'),
    rotateToken: vi.fn().mockResolvedValue({ ...stopped, accessToken: 'next-token' }),
    setListen: vi.fn().mockResolvedValue(stopped),
    sessions: vi.fn().mockResolvedValue([]),
    approveSession: vi.fn().mockResolvedValue({ ok: true }),
    revokeSession: vi.fn().mockResolvedValue({ ok: true }),
    renameSession: vi.fn().mockResolvedValue({ ok: true }),
    selfCheck: vi.fn().mockResolvedValue({
      running: false,
      fence: { ok: true, method: 'settings.describe', status: 200, rewriteAuthority: '127.0.0.1:3080' },
      tls: false,
      auditLog: true,
      allowTokenRead: true,
      trustForwardedFor: false,
      trustBootstrap: true,
    }),
    invite: vi.fn().mockResolvedValue({
      inviteUrl: 'http://127.0.0.1:3081/_dsh_reverse_proxy/login?invite=one-time',
      qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    }),
    audit: vi.fn().mockResolvedValue({ enabled: true, events: [] }),
    exportAudit: vi.fn().mockResolvedValue(new Blob(['[]'], { type: 'application/json' })),
    ...overrides,
  }
}

/**
 * The real slot contracts extend GlobalStandardProps with session/workspace
 * hooks the page never reads. The one cast lives here so every render call
 * below stays fully typed and readable.
 */
function sectionProps(
  service: ProxyApi,
  t: ReverseProxyTranslate = translatorFor(zh),
): ComponentProps<typeof RemoteSection> {
  return {
    api: service,
    t,
    close: vi.fn(),
    useSessions: vi.fn(),
    useWorkspaces: vi.fn(),
  } as unknown as ComponentProps<typeof RemoteSection>
}

describe('i18n dictionaries', () => {
  it('covers the same keys in both locales', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('translates through the active dictionary and keeps the zh fallback default', () => {
    expect(translatorFor(en)('start')).toBe('Start proxy')
    expect(translatorFor(zh)('start')).toBe('启动代理')
    expect(translatorFor(en)('error.startListenFailed', { bind: '0.0.0.0:8000' })).toContain('0.0.0.0:8000')
  })
})

describe('toast mapping', () => {
  const t = translatorFor(zh)

  it('maps listen-failed on start to occupancy copy with the bind address', () => {
    const toast = toastFromStatus(
      { ...stopped, listen: { host: '0.0.0.0', port: 8000 }, reason: 'listen-failed' },
      t,
      'start',
    )
    expect(toast.kind).toBe('error')
    expect(toast.text).toContain('0.0.0.0:8000')
    expect(toast.text).toContain('应用发布地址')
  })

  it('maps forbidden control errors to the local-window copy', () => {
    expect(toastFromCaught(new Error('forbidden'), t).text).toMatch(/127\.0\.0\.1/)
  })

  it('maps invalid-base invite errors to a dedicated message', () => {
    expect(toastFromCaught(new Error('invalid-base'), t).text).toMatch(/Origin/)
  })

  it('keeps rotate success even when restart reports listen-failed', () => {
    const toast = toastFromStatus(
      { ...stopped, listen: { host: '127.0.0.1', port: 3081 }, reason: 'listen-failed', accessToken: 'x' },
      t,
      'rotate',
    )
    expect(toast.kind).toBe('warn')
    expect(toast.text).toMatch(/已轮换/)
    expect(toast.text).toMatch(/3081/)
  })

  it('maps a proxy 403 with no JSON body to forbidden, not a locale-stuck HTTP blurb', () => {
    expect(errorFromControlResponse(403, {}).message).toBe('forbidden')
    expect(errorFromControlResponse(401, {}).message).toBe('forbidden')
    expect(errorFromControlResponse(403, { error: 'loopback-required' }).message).toBe('loopback-required')
    expect(errorFromControlResponse(500, {}).message).toBe('HTTP 500')
  })
})

describe('settings persistence trust', () => {
  it('requires the index-tap flag and a non-loopback hostname', () => {
    expect(pageNeedsHostSettingsPersistence('app.example', 1)).toBe(true)
    expect(pageNeedsHostSettingsPersistence('127.0.0.1', 1)).toBe(false)
    expect(pageNeedsHostSettingsPersistence('localhost', 1)).toBe(false)
    expect(pageNeedsHostSettingsPersistence('app.example', undefined)).toBe(false)
    expect(pageNeedsHostSettingsPersistence('', 1)).toBe(false)
  })

  it('makes bind() see isLoopback and restores the handle afterwards', () => {
    const connection = { isLoopback: false }
    const seen: boolean[] = []
    const binder = {
      bind(spec: unknown) {
        seen.push(connection.isLoopback)
        return spec
      },
    }
    trustSettingsPersistence(binder, () => connection, { hostname: 'tunnel.example', trusted: 1 })
    expect(binder.bind({ namespace: 'ui-test' })).toEqual({ namespace: 'ui-test' })
    expect(seen).toEqual([true])
    expect(connection.isLoopback).toBe(false)
  })

  it('does not wrap bind on a loopback page', () => {
    const connection = { isLoopback: false }
    const binder = { bind: vi.fn((spec: unknown) => spec) }
    const original = binder.bind
    trustSettingsPersistence(binder, () => connection, { hostname: '127.0.0.1', trusted: 1 })
    expect(binder.bind).toBe(original)
  })

  it('does not wrap bind when the handle is already pinned', () => {
    const connection = { isLoopback: true }
    const binder = { bind: vi.fn((spec: unknown) => spec) }
    const original = binder.bind
    trustSettingsPersistence(binder, () => connection, { hostname: 'tunnel.example', trusted: 1 })
    expect(binder.bind).toBe(original)
  })
})

describe('remote settings section', () => {
  it('renders as a settings page, not a dialog overlay', async () => {
    const service = api()
    render(<RemoteSection {...sectionProps(service)} />)
    expect(document.querySelector('dialog')).toBeNull()
    expect(await screen.findByRole('heading', { name: '反向代理' })).toBeTruthy()
    expect(screen.getByText(/把任意隧道指到下方地址/)).toBeTruthy()
    expect(screen.getByRole('heading', { name: '隧道目标' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '发布地址' })).toBeTruthy()
  })

  it('uses the locale for the section heading', async () => {
    render(<RemoteSection {...sectionProps(api(), translatorFor(en))} />)
    expect(await screen.findByRole('heading', { name: 'Reverse proxy' })).toBeTruthy()
  })

  it('loads status and starts the proxy', async () => {
    const service = api()
    render(<RemoteSection {...sectionProps(service)} />)
    await waitFor(() => expect(service.status).toHaveBeenCalledOnce())
    expect(await screen.findByText('代理尚未运行')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '启动代理' }))
    await waitFor(() => expect(service.start).toHaveBeenCalledOnce())
  })

  it('shows a dedicated toast when start returns listen-failed', async () => {
    const failed: ProxyStatus = {
      ...stopped,
      listen: { host: '0.0.0.0', port: 8000 },
      reason: 'listen-failed',
    }
    const service = api({
      status: vi.fn().mockResolvedValue(failed),
      start: vi.fn().mockResolvedValue(failed),
    })
    render(<RemoteSection {...sectionProps(service)} />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText(/0\.0\.0\.0:8000/)).toBeTruthy()
    expect(screen.getByText(/占用/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '启动代理' }))
    await waitFor(() => expect(service.start).toHaveBeenCalledOnce())
    expect(screen.getByRole('alert').textContent).toMatch(/应用发布地址/)
  })

  it('explains a self-loop start refusal with the colliding addresses', async () => {
    const looped: ProxyStatus = {
      ...stopped,
      listen: { host: '127.0.0.1', port: 3080 },
      backend: 'http://127.0.0.1:3080',
      reason: 'self-loop',
    }
    const service = api({ start: vi.fn().mockResolvedValue(looped) })
    render(<RemoteSection {...sectionProps(service)} />)
    await waitFor(() => expect(service.status).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: '启动代理' }))
    expect(await screen.findByText(/死循环/)).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toMatch(/127\.0\.0\.1:3080/)
  })

  it('maps control-plane HTTP errors to an actionable toast', async () => {
    const service = api({ start: vi.fn().mockRejectedValue(new Error('forbidden')) })
    render(<RemoteSection {...sectionProps(service)} />)
    await waitFor(() => expect(service.status).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: '启动代理' }))
    expect(await screen.findByText(/不要从隧道/)).toBeTruthy()
  })

  it('shows a success toast after the proxy starts', async () => {
    const service = api()
    render(<RemoteSection {...sectionProps(service)} />)
    await waitFor(() => expect(service.status).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: '启动代理' }))
    expect(await screen.findByText(/代理已启动/)).toBeTruthy()
  })

  it('reveals the access token only after an explicit gesture', async () => {
    const service = api()
    render(<RemoteSection {...sectionProps(service)} />)
    expect(screen.queryByText('secret-token')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '显示访问令牌' }))
    expect(await screen.findByText('secret-token')).toBeTruthy()
  })

  it('rotates the token after it has been revealed', async () => {
    const service = api()
    render(<RemoteSection {...sectionProps(service)} />)
    fireEvent.click(screen.getByRole('button', { name: '显示访问令牌' }))
    expect(await screen.findByText('secret-token')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '轮换令牌' }))
    await waitFor(() => expect(service.rotateToken).toHaveBeenCalledOnce())
    expect(await screen.findByText('next-token')).toBeTruthy()
    expect(await screen.findByText(/已轮换/)).toBeTruthy()
  })

  it('clears a generated invite after rotating the token', async () => {
    const service = api()
    render(<RemoteSection {...sectionProps(service)} />)
    await waitFor(() => expect(service.status).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: '生成邀请' }))
    expect(await screen.findByText(/login\?invite=one-time/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '显示访问令牌' }))
    await screen.findByText('secret-token')
    fireEvent.click(screen.getByRole('button', { name: '轮换令牌' }))
    await waitFor(() => expect(service.rotateToken).toHaveBeenCalledOnce())
    await waitFor(() => {
      expect(screen.queryByText(/login\?invite=one-time/)).toBeNull()
    })
  })

  it('applies a custom listen address and warns about wildcard binds', async () => {
    const service = api({
      setListen: vi.fn().mockResolvedValue({ ...stopped, listen: { host: '0.0.0.0', port: 9081 }, wildcard: true, target: 'http://127.0.0.1:9081' }),
    })
    render(<RemoteSection {...sectionProps(service)} />)
    await waitFor(() => expect(service.status).toHaveBeenCalledOnce())
    fireEvent.change(screen.getByPlaceholderText('127.0.0.1'), { target: { value: '0.0.0.0' } })
    fireEvent.change(screen.getByPlaceholderText('3081'), { target: { value: '9081' } })
    expect(screen.getByText(/不是可连接的地址/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '应用发布地址' }))
    await waitFor(() => expect(service.setListen).toHaveBeenCalledWith('0.0.0.0', 9081))
  })

  it('warns when the listen host is a non-loopback unicast address', async () => {
    const service = api()
    render(<RemoteSection {...sectionProps(service)} />)
    await waitFor(() => expect(service.status).toHaveBeenCalledOnce())
    fireEvent.change(screen.getByPlaceholderText('127.0.0.1'), { target: { value: '192.168.1.5' } })
    expect(screen.getByText(/非回环/)).toBeTruthy()
  })

  it('rejects an empty listen host without calling the API', async () => {
    const service = api()
    render(<RemoteSection {...sectionProps(service)} />)
    await waitFor(() => expect(service.status).toHaveBeenCalledOnce())
    fireEvent.change(screen.getByPlaceholderText('127.0.0.1'), { target: { value: '  ' } })
    fireEvent.click(screen.getByRole('button', { name: '应用发布地址' }))
    expect(service.setListen).not.toHaveBeenCalled()
    expect(await screen.findByText(/请输入有效的发布地址/)).toBeTruthy()
  })

  it('lists connected devices and kicks one', async () => {
    const now = Date.now()
    const device = { id: 's1', label: 'Chrome on macOS', status: 'active' as const, createdAt: now, lastSeenAt: now }
    const service = api({ sessions: vi.fn().mockResolvedValue([device]) })
    render(<RemoteSection {...sectionProps(service)} />)
    expect(await screen.findByText('Chrome on macOS')).toBeTruthy()
    expect(screen.getByText('在线')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /踢出/ }))
    await waitFor(() => expect(service.revokeSession).toHaveBeenCalledWith('s1'))
    expect(await screen.findByText('已踢出该设备。')).toBeTruthy()
  })

  it('approves a pending device from the panel', async () => {
    const now = Date.now()
    const pending = { id: 'p1', label: 'Safari on iOS', status: 'pending' as const, createdAt: now, lastSeenAt: now }
    const service = api({ sessions: vi.fn().mockResolvedValue([pending]) })
    render(<RemoteSection {...sectionProps(service)} />)
    expect(await screen.findByText('Safari on iOS')).toBeTruthy()
    expect(screen.getByText('待审批')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /批准/ }))
    await waitFor(() => expect(service.approveSession).toHaveBeenCalledWith('p1'))
    expect(await screen.findByText('已批准该设备。')).toBeTruthy()
  })

  it('shows the approval-mode hint and an empty devices state', async () => {
    const service = api({
      status: vi.fn().mockResolvedValue({ ...stopped, approvalMode: true }),
      sessions: vi.fn().mockResolvedValue([]),
    })
    render(<RemoteSection {...sectionProps(service)} />)
    expect(await screen.findByText('暂无设备。远程浏览器登录后会显示在这里。')).toBeTruthy()
    expect(await screen.findByText(/审批模式已开启/)).toBeTruthy()
  })

  it('loads and displays audit events', async () => {
    const audit = vi.fn().mockResolvedValue({
      enabled: true,
      events: [
        { ts: '2026-01-01T00:00:00.000Z', event: 'login.ok', remote: '1.2.3.4' },
      ],
    })
    const service = api({ audit })
    render(<RemoteSection {...sectionProps(service)} />)
    expect(await screen.findByText('代理尚未运行')).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('例如 login.ok'), { target: { value: 'login.ok' } })
    fireEvent.change(screen.getByPlaceholderText('50'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: '加载审计日志' }))
    await waitFor(() => expect(audit).toHaveBeenCalledWith(10, 'login.ok'))
    expect(await screen.findByText('login.ok')).toBeTruthy()
    expect(screen.getByText(/1\.2\.3\.4/)).toBeTruthy()
  })

  it('exports audit events as a download', async () => {
    const exportAudit = vi.fn().mockResolvedValue(new Blob(['[]'], { type: 'application/json' }))
    const service = api({ exportAudit })
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    URL.createObjectURL = vi.fn().mockReturnValue('blob:test') as unknown as typeof URL.createObjectURL
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL
    try {
      render(<RemoteSection {...sectionProps(service)} />)
      expect(await screen.findByText('代理尚未运行')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: '导出审计日志' }))
      await waitFor(() => expect(exportAudit).toHaveBeenCalled())
      expect(await screen.findByText('审计日志已导出。')).toBeTruthy()
    } finally {
      URL.createObjectURL = originalCreate
      URL.revokeObjectURL = originalRevoke
    }
  })

  it('copies the tunnel target via execCommand when the async Clipboard API is unavailable', async () => {
    const service = api()
    const originalExecCommand = document.execCommand
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    document.execCommand = vi.fn().mockReturnValue(true)
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    try {
      render(<RemoteSection {...sectionProps(service)} />)
      await waitFor(() => expect(service.status).toHaveBeenCalledOnce())
      expect(await screen.findByText('代理尚未运行')).toBeTruthy()
      fireEvent.click(await screen.findByRole('button', { name: /复制/ }))
      await waitFor(() => expect(document.execCommand).toHaveBeenCalledWith('copy'))
      expect(await screen.findByText('端点已复制。')).toBeTruthy()
    } finally {
      document.execCommand = originalExecCommand
      if (originalClipboard === undefined) {
        delete (navigator as { clipboard?: Clipboard }).clipboard
      } else {
        Object.defineProperty(navigator, 'clipboard', originalClipboard)
      }
    }
  })
})
