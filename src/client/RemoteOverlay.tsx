import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { createRemotePanelStore } from './store.ts'
import type { ProxyApi, ProxyStatus } from './types.ts'
import css from './remote.module.css'

export type RemoteOverlayProps =
  & PropsRuntime<'shell.overlay'>
  & PropsStore<ReturnType<typeof createRemotePanelStore>>
  & { api: ProxyApi }

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请稍后重试。'
}

export function RemoteOverlay({ useStore, actions, api }: RemoteOverlayProps) {
  const open = useStore(state => state.open)
  const [status, setStatus] = useState<ProxyStatus>()
  const [accessToken, setAccessToken] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dialog = useRef<HTMLDialogElement | null>(null)
  const closeButton = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    let active = true
    setError('')
    void api.status().then(
      value => { if (active) setStatus(value) },
      reason => { if (active) setError(messageOf(reason)) },
    )
    const node = dialog.current
    if (node && typeof node.showModal === 'function' && !node.open) node.showModal()
    closeButton.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') actions.close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      active = false
      document.removeEventListener('keydown', onKeyDown)
      if (node && typeof node.close === 'function' && node.open) node.close()
    }
  }, [actions, api, open])

  if (!open) return null

  const run = async (operation: () => Promise<ProxyStatus>) => {
    setBusy(true)
    setError('')
    try {
      setStatus(await operation())
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setError(`${label}已复制。`)
    } catch {
      setError(`无法复制${label}。`)
    }
  }

  const revealToken = async () => {
    setBusy(true)
    setError('')
    try {
      setAccessToken(await api.token())
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }

  const rotate = async () => {
    setBusy(true)
    setError('')
    try {
      const next = await api.rotateToken()
      setStatus(next)
      setAccessToken(next.accessToken)
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }

  return createPortal((
    <dialog
      ref={dialog}
      className={css.overlay}
      aria-labelledby="dsh-rp-title"
      onCancel={event => {
        event.preventDefault()
        actions.close()
      }}
    >
      <button className={css.mask} type="button" aria-label="关闭反向代理面板" onClick={() => { actions.close() }} />
      <section className={css.panel}>
        <header className={css.header}>
          <div>
            <p className={css.eyebrow}>REMOTE GATEWAY</p>
            <h2 id="dsh-rp-title">反向代理</h2>
          </div>
          <button ref={closeButton} className={css.iconButton} type="button" aria-label="关闭" onClick={() => { actions.close() }}>×</button>
        </header>

        <div className={css.statusCard}>
          <span className={status?.running ? css.onlineDot : css.offlineDot} aria-hidden="true" />
          <div>
            <strong>{status?.running ? '代理正在运行' : '代理尚未运行'}</strong>
            <p>{status?.running ? '现在可以让任意 tunnel 指向下方本地端点。' : '启动后会创建受令牌保护的本地入口。'}</p>
          </div>
        </div>

        <div className={css.section}>
          <div className={css.sectionHeading}>
            <div>
              <span className={css.label}>TUNNEL TARGET</span>
              <p>将 frp、ngrok、cloudflared 或 SSH 隧道的本地目标设为：</p>
            </div>
          </div>
          <button
            className={css.copyField}
            type="button"
            disabled={status === undefined}
            onClick={() => { if (status !== undefined) void copy(status.target, '端点') }}
          >
            <code>{status?.target ?? '正在读取…'}</code>
            <span>复制</span>
          </button>
        </div>

        <div className={css.section}>
          <span className={css.label}>ACCESS TOKEN</span>
          <p>远程浏览器首次访问时必须输入此令牌。轮换后，现有远程会话会失效。</p>
          {accessToken === undefined ? (
            <button className={css.secondaryButton} type="button" disabled={busy} onClick={() => { void revealToken() }}>显示访问令牌</button>
          ) : (
            <div className={css.tokenBlock}>
              <button className={css.copyField} type="button" onClick={() => { void copy(accessToken, '令牌') }}>
                <code>{accessToken}</code><span>复制</span>
              </button>
              <button className={css.textButton} type="button" disabled={busy} onClick={() => { void rotate() }}>轮换令牌</button>
            </div>
          )}
        </div>

        {error !== '' && <p className={css.notice} role="status">{error}</p>}

        <footer className={css.footer}>
          <button
            className={status?.running ? css.dangerButton : css.primaryButton}
            type="button"
            disabled={busy || status === undefined}
            onClick={() => { void run(status?.running ? api.stop : api.start) }}
          >
            {busy ? '处理中…' : status?.running ? '停止代理' : '启动代理'}
          </button>
        </footer>
      </section>
    </dialog>
  ), document.body)
}
