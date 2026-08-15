import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { RemoteAction } from '../src/client/RemoteAction.tsx'
import { RemoteOverlay } from '../src/client/RemoteOverlay.tsx'
import { findSidebarFootArea, insertSidebarActionRow } from '../src/client/sidebarFoot.ts'
import type { ProxyApi, ProxyStatus } from '../src/client/types.ts'
import { translatorFor, zh, en } from '../src/client/i18n.ts'

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open')
  }
})

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
    ...overrides,
  }
}

/**
 * The real slot contracts extend GlobalStandardProps with session/workspace
 * hooks the panel never reads. The one cast lives here so every render call
 * below stays fully typed and readable.
 */
function overlayProps(service: ProxyApi, close = vi.fn()): ComponentProps<typeof RemoteOverlay> {
  return {
    api: service,
    t: translatorFor(zh),
    actions: { open: vi.fn(), close },
    useStore: (selector: (state: { open: boolean }) => boolean) => selector({ open: true }),
    useSessions: vi.fn(),
    useWorkspaces: vi.fn(),
  } as unknown as ComponentProps<typeof RemoteOverlay>
}

function actionProps(open = vi.fn(), wide = true): ComponentProps<typeof RemoteAction> {
  return {
    wide,
    t: translatorFor(zh),
    actions: { open, close: vi.fn() },
    useStore: vi.fn(),
    useSessions: vi.fn(),
    useWorkspaces: vi.fn(),
  } as unknown as ComponentProps<typeof RemoteAction>
}

describe('i18n dictionaries', () => {
  it('covers the same keys in both locales', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('translates through the active dictionary and keeps the zh fallback default', () => {
    expect(translatorFor(en)('start')).toBe('Start proxy')
    expect(translatorFor(zh)('start')).toBe('启动代理')
    expect(translatorFor(en)('error.listenFailed', { reason: 'x' })).toBe('Failed to update listen address: x')
  })
})

describe('sidebar foot promotion', () => {
  it('returns null on a flat tree without a column-flex ancestor', () => {
    let leaf = document.createElement('div')
    for (let i = 0; i < 8; i++) {
      const parent = document.createElement('div')
      parent.appendChild(leaf)
      leaf = parent
    }
    expect(findSidebarFootArea(leaf)).toBeNull()
  })

  it('finds the nearest column-flex ancestor within the depth budget', () => {
    const getComputedStyle = vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element) => {
      const column = element instanceof HTMLElement && element.dataset.column === '1'
      return { flexDirection: column ? 'column' : 'row' } as CSSStyleDeclaration
    })
    try {
      const foot = document.createElement('div')
      foot.dataset.column = '1'
      const actionsRow = document.createElement('div')
      const wrapper = document.createElement('div')
      const anchor = document.createElement('div')
      wrapper.appendChild(anchor)
      actionsRow.appendChild(wrapper)
      foot.appendChild(actionsRow)
      expect(findSidebarFootArea(anchor)).toBe(foot)
    } finally {
      getComputedStyle.mockRestore()
    }
  })

  it('inserts a marked holder row as the first child of the foot area', () => {
    const foot = document.createElement('div')
    const first = document.createElement('div')
    foot.appendChild(first)
    const holder = insertSidebarActionRow(foot)
    expect(foot.firstElementChild).toBe(holder)
    expect(holder.getAttribute('data-dsh-reverse-proxy-action-row')).toBe('1')
  })
})

describe('remote client UI', () => {
  it('opens from the sidebar action with official-control geometry', () => {
    const open = vi.fn()
    render(<RemoteAction {...actionProps(open)} />)
    fireEvent.click(screen.getByRole('button', { name: '打开反向代理' }))
    expect(open).toHaveBeenCalledOnce()
    expect(screen.getByText('反向代理')).toBeTruthy()
  })

  it('loads status, starts the proxy, and closes with Escape', async () => {
    const service = api()
    const close = vi.fn()
    render(<RemoteOverlay {...overlayProps(service, close)} />)
    await waitFor(() => expect(service.status).toHaveBeenCalledOnce())
    const dialog = document.querySelector('dialog')
    expect(dialog).toBeTruthy()
    expect(document.body.contains(dialog)).toBe(true)
    expect(await screen.findByText('代理尚未运行')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '启动代理' }))
    await waitFor(() => expect(service.start).toHaveBeenCalledOnce())
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(close).toHaveBeenCalledOnce()
  })

  it('reveals the access token only after an explicit gesture', async () => {
    const service = api()
    render(<RemoteOverlay {...overlayProps(service)} />)
    expect(screen.queryByText('secret-token')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '显示访问令牌' }))
    expect(await screen.findByText('secret-token')).toBeTruthy()
  })

  it('applies a custom listen address and warns about non-loopback binds', async () => {
    const service = api({
      setListen: vi.fn().mockResolvedValue({ ...stopped, listen: { host: '0.0.0.0', port: 9081 } }),
    })
    render(<RemoteOverlay {...overlayProps(service)} />)
    await waitFor(() => expect(service.status).toHaveBeenCalledOnce())
    fireEvent.change(screen.getByPlaceholderText('127.0.0.1'), { target: { value: '0.0.0.0' } })
    fireEvent.change(screen.getByPlaceholderText('3081'), { target: { value: '9081' } })
    expect(screen.getByText(/非回环/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '应用发布地址' }))
    await waitFor(() => expect(service.setListen).toHaveBeenCalledWith('0.0.0.0', 9081))
  })

  it('rejects an empty listen host without calling the API', async () => {
    const service = api()
    render(<RemoteOverlay {...overlayProps(service)} />)
    await waitFor(() => expect(service.status).toHaveBeenCalledOnce())
    fireEvent.change(screen.getByPlaceholderText('127.0.0.1'), { target: { value: '  ' } })
    fireEvent.click(screen.getByRole('button', { name: '应用发布地址' }))
    expect(service.setListen).not.toHaveBeenCalled()
    expect(await screen.findByText(/请输入有效的发布地址/)).toBeTruthy()
  })

  it('copies the tunnel target via execCommand when the async Clipboard API is unavailable', async () => {
    // Remote browsers run on plain HTTP (insecure context): navigator.clipboard
    // is undefined there. The panel must fall back to execCommand('copy').
    const service = api()
    const originalExecCommand = document.execCommand
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    document.execCommand = vi.fn().mockReturnValue(true)
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    try {
      render(<RemoteOverlay {...overlayProps(service)} />)
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
