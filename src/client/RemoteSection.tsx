/**
 * RemoteSection — reverse-proxy control page on the official
 * `settings.section` slot. Rhythm matches Plugins / Agent presets:
 * 18/600 title, 13px intro, grouped fields, primary action in the
 * status card. The shell owns the dialog chrome and nav.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProxyApi, ProxyStatus, SessionInfo } from './types.ts'
import { DevicesSection } from './DevicesSection.tsx'
import type { ReverseProxyTranslate } from './i18n.ts'
import { PanelToast } from './PanelToast.tsx'
import { ReverseProxyIcon } from './ReverseProxyIcon.tsx'
import { toastFromCaught, toastFromReason, toastFromStatus, type PanelToastModel, type ToastIntent } from './toast.ts'
import css from './remote.module.css'

export type RemoteSectionProps =
  & PropsRuntime<'settings.section'>
  & { api: ProxyApi, t: ReverseProxyTranslate }

function isWildcardListen(host: string) {
  return host === '0.0.0.0' || host === '::' || host === '::0' || host === '[::]'
}

export function RemoteSection({ api, t }: RemoteSectionProps) {
  const [status, setStatus] = useState<ProxyStatus>()
  const [accessToken, setAccessToken] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<(PanelToastModel & { id: number })>()
  const [listenHost, setListenHost] = useState('')
  const [listenPort, setListenPort] = useState('')
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const toastSeq = useRef(0)
  const showToast = (model: PanelToastModel) => {
    toastSeq.current += 1
    setToast({ ...model, id: toastSeq.current })
  }
  const dismissToast = useCallback(() => { setToast(undefined) }, [])

  useEffect(() => {
    let active = true
    setToast(undefined)
    void api.status().then(
      value => {
        if (!active) return
        setStatus(value)
        if (value.listen) {
          setListenHost(prev => (prev === '' ? value.listen!.host : prev))
          setListenPort(prev => (prev === '' ? String(value.listen!.port) : prev))
        }
        if (value.reason !== undefined && value.reason !== '' && value.running !== true) {
          showToast(toastFromReason(value.reason, value, t, 'start'))
        }
      },
      reason => { if (active) showToast(toastFromCaught(reason, t)) },
    )
    void api.sessions().then(list => { if (active) setSessions(list) }, () => {})
    const sessionTimer = setInterval(() => {
      void api.sessions().then(list => { if (active) setSessions(list) }, () => {})
    }, 3000)
    return () => {
      active = false
      clearInterval(sessionTimer)
    }
  }, [api, t])

  const applyResult = (next: ProxyStatus, intent: ToastIntent) => {
    setStatus(next)
    if (next.listen) {
      setListenHost(next.listen.host)
      setListenPort(String(next.listen.port))
    }
    showToast(toastFromStatus(next, t, intent))
  }

  const run = async (intent: 'start' | 'stop') => {
    setBusy(true)
    try {
      applyResult(await (intent === 'stop' ? api.stop() : api.start()), intent)
    } catch (reason) {
      showToast(toastFromCaught(reason, t))
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
        showToast({ kind: 'error', text: t('copy.failed', { label }) })
        return
      }
      showToast({ kind: 'success', text: t(doneKey) })
    } catch {
      if (!copyViaExecCommand(value)) {
        showToast({ kind: 'error', text: t('copy.failed', { label }) })
        return
      }
      showToast({ kind: 'success', text: t(doneKey) })
    }
  }

  const revealToken = async () => {
    setBusy(true)
    try {
      setAccessToken(await api.token())
    } catch (reason) {
      showToast(toastFromCaught(reason, t))
    } finally {
      setBusy(false)
    }
  }

  const rotate = async () => {
    setBusy(true)
    try {
      const next = await api.rotateToken()
      applyResult(next, 'rotate')
      setAccessToken(next.accessToken)
    } catch (reason) {
      showToast(toastFromCaught(reason, t))
    } finally {
      setBusy(false)
    }
  }

  const applyListen = async () => {
    const host = listenHost.trim()
    const port = Number(listenPort)
    if (host === '' || !Number.isInteger(port) || port < 0 || port > 65535) {
      showToast({ kind: 'error', text: t('error.invalidListen') })
      return
    }
    setBusy(true)
    try {
      applyResult(await api.setListen(host, port), 'listen')
    } catch (reason) {
      showToast(toastFromCaught(reason, t))
    } finally {
      setBusy(false)
    }
  }

  const kick = async (id: string) => {
    setBusy(true)
    try {
      await api.revokeSession(id)
      setSessions(await api.sessions())
      showToast({ kind: 'success', text: t('devices.kicked') })
    } catch (reason) {
      showToast(toastFromCaught(reason, t))
    } finally {
      setBusy(false)
    }
  }

  const decide = async (id: string, approve: boolean) => {
    setBusy(true)
    try {
      await (approve ? api.approveSession(id) : api.revokeSession(id))
      setSessions(await api.sessions())
      showToast({ kind: 'success', text: t(approve ? 'devices.approved' : 'devices.rejected') })
    } catch (reason) {
      showToast(toastFromCaught(reason, t))
    } finally {
      setBusy(false)
    }
  }

  const running = status?.running === true
  const wildcard = isWildcardListen(listenHost.trim())
  const nonLoopback = listenHost.trim() !== ''
    && !wildcard
    && !['127.0.0.1', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1'].includes(listenHost.trim())

  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('section.title')}</h2>
      <p className={css.intro}>{t('section.intro')}</p>

      {toast !== undefined && (
        <PanelToast key={toast.id} toast={toast} t={t} onDismiss={dismissToast} />
      )}

      <div className={css.hero}>
        <div className={css.heroMain}>
          <span className={css.brand} data-online={running ? 'true' : undefined}>
            <ReverseProxyIcon />
          </span>
          <div className={css.heroCopy}>
            <strong>{running ? t('status.running') : t('status.stopped')}</strong>
            <p className={css.hint}>{running ? t('status.runningHint') : t('status.stoppedHint')}</p>
          </div>
        </div>
        <button
          className={running ? css.dangerButton : css.primaryButton}
          type="button"
          disabled={busy || status === undefined}
          onClick={() => { void run(running ? 'stop' : 'start') }}
        >
          {busy ? t('busy') : running ? t('stop') : t('start')}
        </button>
      </div>

      <section className={css.group}>
        <h3 className={css.groupHead}>{t('tunnel.label')}</h3>
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
          <p className={css.hint}>{t('tunnel.bound', { bind: `${status.listen.host}:${status.listen.port}` })}</p>
        )}
      </section>

      <section className={css.group}>
        <h3 className={css.groupHead}>{t('listen.label')}</h3>
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
          <button
            className={css.secondaryButton}
            type="button"
            disabled={busy}
            onClick={() => { void applyListen() }}
          >{t('listen.apply')}</button>
        </div>
        {wildcard && <p className={css.warn}>{t('listen.wildcard')}</p>}
        {nonLoopback && <p className={css.warn}>{t('listen.warn')}</p>}
      </section>

      <section className={css.group}>
        <h3 className={css.groupHead}>{t('token.label')}</h3>
        <p className={css.hint}>{t('token.description')}</p>
        {accessToken === undefined ? (
          <button className={css.secondaryButton} type="button" disabled={busy} onClick={() => { void revealToken() }}>{t('token.reveal')}</button>
        ) : (
          <div className={css.tokenRow}>
            <button className={css.copyField} type="button" onClick={() => { void copy(accessToken, t('tunnel.copy'), 'copied.token') }}>
              <code>{accessToken}</code><span>{t('tunnel.copy')}</span>
            </button>
            <button className={css.textButton} type="button" disabled={busy} onClick={() => { void rotate() }}>{t('token.rotate')}</button>
          </div>
        )}
      </section>

      <DevicesSection
        sessions={sessions}
        approvalMode={status?.approvalMode === true}
        busy={busy}
        t={t}
        onKick={id => { void kick(id) }}
        onDecide={(id, approve) => { void decide(id, approve) }}
      />
    </div>
  )
}
