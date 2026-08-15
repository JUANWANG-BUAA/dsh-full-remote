/**
 * RemoteOverlay — the reverse-proxy control panel dialog (shell.overlay
 * slot): status, runtime listen address, tunnel target, access token, and
 * connected-device management. All text flows through the i18n translator.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { createRemotePanelStore } from './store.ts'
import type { ProxyApi, ProxyStatus, SessionInfo } from './types.ts'
import { DevicesSection } from './DevicesSection.tsx'
import type { ReverseProxyTranslate } from './i18n.ts'
import css from './remote.module.css'

export type RemoteOverlayProps =
  & PropsRuntime<'shell.overlay'>
  & PropsStore<ReturnType<typeof createRemotePanelStore>>
  & { api: ProxyApi, t: ReverseProxyTranslate }

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : ''
}

function isWildcardListen(host: string) {
  return host === '0.0.0.0' || host === '::' || host === '::0' || host === '[::]'
}

export function RemoteOverlay({ useStore, actions, api, t }: RemoteOverlayProps) {
  const open = useStore(state => state.open)
  const [status, setStatus] = useState<ProxyStatus>()
  const [accessToken, setAccessToken] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [listenHost, setListenHost] = useState('')
  const [listenPort, setListenPort] = useState('')
  const [sessions, setSessions] = useState<SessionInfo[]>([])
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
      reason => { if (active) setError(messageOf(reason) || t('error.generic')) },
    )
    const node = dialog.current
    if (node && typeof node.showModal === 'function' && !node.open) node.showModal()
    closeButton.current?.focus()
    void api.sessions().then(list => { if (active) setSessions(list) }, () => {})
    const sessionTimer = setInterval(() => {
      void api.sessions().then(list => { if (active) setSessions(list) }, () => {})
    }, 3000)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') actions.close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      active = false
      clearInterval(sessionTimer)
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
      setError(messageOf(reason) || t('error.generic'))
    } finally {
      setBusy(false)
    }
  }

  // Remote browsers run on plain HTTP, an insecure context where the async
  // Clipboard API is unavailable. Fall back to the legacy execCommand path
  // so copying the tunnel target and access token keeps working on phones.
  const copyViaExecCommand = (value: string) => {
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      // execCommand removed by the browser: ok stays false and we report it.
    }
    textarea.remove()
    return ok
  }

  const copy = async (value: string, label: string, doneKey: 'copied.target' | 'copied.token') => {
    try {
      if (navigator.clipboard?.writeText !== undefined) {
        await navigator.clipboard.writeText(value)
      } else if (!copyViaExecCommand(value)) {
        setError(t('copy.failed', { label }))
        return
      }
      setError(t(doneKey))
    } catch {
      if (!copyViaExecCommand(value)) {
        setError(t('copy.failed', { label }))
        return
      }
      setError(t(doneKey))
    }
  }

  const revealToken = async () => {
    setBusy(true)
    setError('')
    try {
      setAccessToken(await api.token())
    } catch (reason) {
      setError(messageOf(reason) || t('error.generic'))
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
      setError(messageOf(reason) || t('error.generic'))
    } finally {
      setBusy(false)
    }
  }

  const applyListen = async () => {
    const host = listenHost.trim()
    const port = Number(listenPort)
    if (host === '' || !Number.isInteger(port) || port < 0 || port > 65535) {
      setError(t('error.invalidListen'))
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
        setError(t('error.invalidListenServer'))
      } else if (next.reason === 'listen-failed-restored') {
        setError(t('error.listenRestored'))
      } else if (next.reason !== undefined && next.reason !== '') {
        setError(t('error.listenFailed', { reason: next.reason }))
      }
    } catch (reason) {
      setError(messageOf(reason) || t('error.generic'))
    } finally {
      setBusy(false)
    }
  }

  const kick = async (id: string) => {
    setBusy(true)
    setError('')
    try {
      await api.revokeSession(id)
      setSessions(await api.sessions())
      setError(t('devices.kicked'))
    } catch (reason) {
      setError(messageOf(reason) || t('error.generic'))
    } finally {
      setBusy(false)
    }
  }

  const decide = async (id: string, approve: boolean) => {
    setBusy(true)
    setError('')
    try {
      await (approve ? api.approveSession(id) : api.revokeSession(id))
      setSessions(await api.sessions())
      setError(t(approve ? 'devices.approved' : 'devices.rejected'))
    } catch (reason) {
      setError(messageOf(reason) || t('error.generic'))
    } finally {
      setBusy(false)
    }
  }

  const wildcard = isWildcardListen(listenHost.trim())
  const nonLoopback = listenHost.trim() !== ''
    && !wildcard
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
      <button className={css.mask} type="button" aria-label={t('overlay.mask')} onClick={() => { actions.close() }} />
      <section className={css.panel}>
        <header className={css.header}>
          <div>
            <p className={css.eyebrow}>REMOTE GATEWAY</p>
            <h2 id="dsh-rp-title">{t('overlay.title')}</h2>
          </div>
          <button ref={closeButton} className={css.iconButton} type="button" aria-label={t('overlay.close')} onClick={() => { actions.close() }}>×</button>
        </header>

        <div className={css.statusCard}>
          <span className={status?.running ? css.onlineDot : css.offlineDot} aria-hidden="true" />
          <div>
            <strong>{status?.running ? t('status.running') : t('status.stopped')}</strong>
            <p>{status?.running ? t('status.runningHint') : t('status.stoppedHint')}</p>
          </div>
        </div>

        <div className={css.section}>
          <span className={css.label}>LISTEN ADDRESS</span>
          <p>{t('listen.description')}</p>
          <div className={css.listenRow}>
            <label className={css.field}>
              <span>{t('listen.host')}</span>
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
              <span>{t('listen.port')}</span>
              <input
                className={css.input}
                value={listenPort}
                onChange={event => { setListenPort(event.target.value.replace(/[^0-9]/g, '')) }}
                placeholder="3081"
                inputMode="numeric"
              />
            </label>
          </div>
          {wildcard && <p className={css.warn}>{t('listen.wildcard')}</p>}
          {nonLoopback && <p className={css.warn}>{t('listen.warn')}</p>}
          <button
            className={css.secondaryButton}
            type="button"
            disabled={busy}
            onClick={() => { void applyListen() }}
          >{t('listen.apply')}</button>
        </div>

        <div className={css.section}>
          <div className={css.sectionHeading}>
            <div>
              <span className={css.label}>TUNNEL TARGET</span>
              <p>{t('tunnel.description')}</p>
            </div>
          </div>
          <button
            className={css.copyField}
            type="button"
            disabled={status === undefined}
            onClick={() => { if (status !== undefined) void copy(status.target, t('tunnel.copy'), 'copied.target') }}
          >
            <code>{status?.target ?? t('tunnel.loading')}</code>
            <span>{t('tunnel.copy')}</span>
          </button>
          {status?.wildcard === true && status.listen !== undefined && (
            <p className={css.meta}>{t('tunnel.bound', { bind: `${status.listen.host}:${status.listen.port}` })}</p>
          )}
        </div>

        <div className={css.section}>
          <span className={css.label}>ACCESS TOKEN</span>
          <p>{t('token.description')}</p>
          {accessToken === undefined ? (
            <button className={css.secondaryButton} type="button" disabled={busy} onClick={() => { void revealToken() }}>{t('token.reveal')}</button>
          ) : (
            <div className={css.tokenBlock}>
              <button className={css.copyField} type="button" onClick={() => { void copy(accessToken, t('tunnel.copy'), 'copied.token') }}>
                <code>{accessToken}</code><span>{t('tunnel.copy')}</span>
              </button>
              <button className={css.textButton} type="button" disabled={busy} onClick={() => { void rotate() }}>{t('token.rotate')}</button>
            </div>
          )}
        </div>

        <DevicesSection
          sessions={sessions}
          approvalMode={status?.approvalMode === true}
          busy={busy}
          t={t}
          onKick={id => { void kick(id) }}
          onDecide={(id, approve) => { void decide(id, approve) }}
        />

        {error !== '' && <p className={css.notice} role="status">{error}</p>}

        <footer className={css.footer}>
          <button
            className={status?.running ? css.dangerButton : css.primaryButton}
            type="button"
            disabled={busy || status === undefined}
            onClick={() => { void run(status?.running ? api.stop : api.start) }}
          >
            {busy ? t('busy') : status?.running ? t('stop') : t('start')}
          </button>
        </footer>
      </section>
    </dialog>
  ), document.body)
}
