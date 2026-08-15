import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { RemoteAction } from '../src/client/RemoteAction.tsx'
import { RemoteOverlay } from '../src/client/RemoteOverlay.tsx'
import type { ProxyApi, ProxyStatus } from '../src/client/types.ts'

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

describe('remote client UI', () => {
  it('opens from the sidebar action with a 44px-accessible control', () => {
    const open = vi.fn()
    render(<RemoteAction wide={true} actions={{ open, close: vi.fn() }} useStore={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '打开反向代理' }))
    expect(open).toHaveBeenCalledOnce()
    expect(screen.getByText('反向代理')).toBeTruthy()
  })

  it('loads status, starts the proxy, and closes with Escape', async () => {
    const service = api()
    const close = vi.fn()
    render(
      <RemoteOverlay
        api={service}
        actions={{ open: vi.fn(), close }}
        useStore={selector => selector({ open: true })}
      />,
    )
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
    render(
      <RemoteOverlay
        api={service}
        actions={{ open: vi.fn(), close: vi.fn() }}
        useStore={selector => selector({ open: true })}
      />,
    )
    expect(screen.queryByText('secret-token')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '显示访问令牌' }))
    expect(await screen.findByText('secret-token')).toBeTruthy()
  })

  it('applies a custom listen address and warns about non-loopback binds', async () => {
    const service = api({
      setListen: vi.fn().mockResolvedValue({ ...stopped, listen: { host: '0.0.0.0', port: 9081 } }),
    })
    render(
      <RemoteOverlay
        api={service}
        actions={{ open: vi.fn(), close: vi.fn() }}
        useStore={selector => selector({ open: true })}
      />,
    )
    await waitFor(() => expect(service.status).toHaveBeenCalledOnce())
    fireEvent.change(screen.getByPlaceholderText('127.0.0.1'), { target: { value: '0.0.0.0' } })
    fireEvent.change(screen.getByPlaceholderText('3081'), { target: { value: '9081' } })
    expect(screen.getByText(/非回环/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '应用发布地址' }))
    await waitFor(() => expect(service.setListen).toHaveBeenCalledWith('0.0.0.0', 9081))
  })

  it('rejects an empty listen host without calling the API', async () => {
    const service = api()
    render(
      <RemoteOverlay
        api={service}
        actions={{ open: vi.fn(), close: vi.fn() }}
        useStore={selector => selector({ open: true })}
      />,
    )
    await waitFor(() => expect(service.status).toHaveBeenCalledOnce())
    fireEvent.change(screen.getByPlaceholderText('127.0.0.1'), { target: { value: '  ' } })
    fireEvent.click(screen.getByRole('button', { name: '应用发布地址' }))
    expect(service.setListen).not.toHaveBeenCalled()
    expect(await screen.findByText(/请输入有效的发布地址/)).toBeTruthy()
  })
})
