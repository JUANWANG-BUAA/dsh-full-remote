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
  const [listenHost, setListenHost] = useState('')
  const [listenPort, setListenPort] = useState('')
  const dialog = useRef<HTMLDialogElement | null>(null)
  const closeButton = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    let active = true
    setError('')
    void api.status().then(
      value => {
        if (!active) return
        setStatus(value)
        // Seed the editable drafts from the effective listen address once.
        if (value.listen) {
          setListenHost(prev => (prev === '' ? value.listen!.host : prev))
          setListenPort(prev => (prev === '' ? String(value.listen!.port) : prev))
        }
      },
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

  const applyListen = async () => {
    const host = listenHost.trim()
    const port = Number(listenPort)
    if (host === '' || !Number.isInteger(port) || port < 0 || port > 65535) {
      setError('请输入有效的发布地址和端口（0–65535）。')
      return
    }
    setBusy(true)
    setError('')
    try {
      const next = await api.setListen(host, port)
      setStatus(next)
      if (next.listen) {
        setListenHost(next.listen.host)
        setListenPort(String(next.listen.port))
      }
      if (next.reason === 'invalid-listen') {
        setError('发布地址或端口无效。')
      } else if (next.reason === 'listen-failed-restored') {
        setError('新地址无法监听，已恢复到原来的发布地址。')
      } else if (next.reason !== undefined && next.reason !== '') {
        setError(`更新发布地址失败：${next.reason}`)
      }
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }

  const nonLoopback = listenHost.trim() !== ''
    && !['127.0.0.1', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1'].includes(listenHost.trim())

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
          <span className={css.label}>LISTEN ADDRESS</span>
          <p>指定反向代理发布的 IP 与端口。端口填 0 表示自动选择空闲端口；修改后正在运行的代理会自动重启并生效。</p>
          <div className={css.listenRow}>
            <label className={css.field}>
              <span>IP / 主机</span>
              <input
                className={css.input}
                value={listenHost}
                onChange={event => { setListenHost(event.target.value) }}
                placeholder="127.0.0.1"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>
            <label className={css.field}>
              <span>端口</span>
              <input
                className={css.input}
                value={listenPort}
                onChange={event => { setListenPort(event.target.value.replace(/[^0-9]/g, '')) }}
                placeholder="3081"
                inputMode="numeric"
              />
            </label>
          </div>
          {nonLoopback && <p className={css.warn}>绑定非回环地址会直接暴露端口，请确保防火墙与 tunnel 配置正确。</p>}
          <button
            className={css.secondaryButton}
            type="button"
            disabled={busy}
            onClick={() => { void applyListen() }}
          >应用发布地址</button>
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
