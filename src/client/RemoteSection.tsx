/**
 * RemoteSection — reverse-proxy control page on the official
 * `settings.section` slot. Rhythm matches Plugins / Agent presets:
 * 18/600 title, 13px intro, grouped fields, primary action in the
 * status card. The shell owns the dialog chrome and nav.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { InviteResult, ProxyApi, ProxyStatus, SelfCheckResult, SessionInfo } from './types.ts'
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

/** Only render QR SVG that looks like our own generator output. */
function safeQrSvg(svg: string | undefined) {
  if (typeof svg !== 'string') return undefined
  const trimmed = svg.trim()
  if (!trimmed.startsWith('<svg') || /<script[\s>]/i.test(trimmed)) return undefined
  return trimmed
}

export function RemoteSection({ api, t }: RemoteSectionProps) {
  const [status, setStatus] = useState<ProxyStatus>()
  const [accessToken, setAccessToken] = useState<string>()
  const [busyKind, setBusyKind] = useState<'start' | 'stop' | 'listen' | 'token' | 'check' | 'invite' | 'device' | undefined>()
  const busy = busyKind !== undefined
  const [toast, setToast] = useState<(PanelToastModel & { id: number })>()
  const [listenHost, setListenHost] = useState('')
  const [listenPort, setListenPort] = useState('')
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [check, setCheck] = useState<SelfCheckResult>()
  const [inviteBase, setInviteBase] = useState('')
  const [invite, setInvite] = useState<InviteResult>()
  const toastSeq = useRef(0)
  const mounted = useRef(true)
  const sessionsEpoch = useRef(0)
  const showToast = (model: PanelToastModel) => {
    if (!mounted.current) return
    toastSeq.current += 1
    setToast({ ...model, id: toastSeq.current })
  }
  const dismissToast = useCallback(() => { setToast(undefined) }, [])

  const applySessions = (list: SessionInfo[], epoch: number) => {
    if (!mounted.current || epoch !== sessionsEpoch.current) return
    setSessions(list)
  }

  const refreshSessions = async (epoch = sessionsEpoch.current) => {
    try {
      const list = await api.sessions()
      applySessions(list, epoch)
      return true
    } catch {
      return false
    }
  }

  useEffect(() => {
    mounted.current = true
    let active = true
    let pollFailed = false
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
    const poll = () => {
      const epoch = sessionsEpoch.current
      void api.sessions().then(
        list => {
          if (!active) return
          pollFailed = false
          applySessions(list, epoch)
        },
        () => {
          if (!active || pollFailed) return
          pollFailed = true
          showToast({ kind: 'warn', text: t('error.sessionsPoll') })
        },
      )
    }
    poll()
    const sessionTimer = setInterval(poll, 3000)
    return () => {
      active = false
      mounted.current = false
      clearInterval(sessionTimer)
    }
  }, [api, t])

  const applyResult = (next: ProxyStatus, intent: ToastIntent) => {
    if (!mounted.current) return
    setStatus(next)
    setCheck(undefined)
    if (next.listen) {
      setListenHost(next.listen.host)
      setListenPort(String(next.listen.port))
    }
    showToast(toastFromStatus(next, t, intent))
  }

  const run = async (intent: 'start' | 'stop') => {
    setBusyKind(intent)
    try {
      applyResult(await (intent === 'stop' ? api.stop() : api.start()), intent)
    } catch (reason) {
      showToast(toastFromCaught(reason, t))
    } finally {
      if (mounted.current) setBusyKind(undefined)
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

  const copy = async (value: string, label: string, doneKey: 'copied.target' | 'copied.token' | 'invite.copied') => {
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
    setBusyKind('token')
    try {
      const token = await api.token()
      if (mounted.current) setAccessToken(token)
    } catch (reason) {
      showToast(toastFromCaught(reason, t))
    } finally {
      if (mounted.current) setBusyKind(undefined)
    }
  }

  const rotate = async () => {
    setBusyKind('token')
    try {
      const next = await api.rotateToken()
      sessionsEpoch.current += 1
      if (mounted.current) {
        setInvite(undefined)
        setSessions([])
        setAccessToken(next.accessToken)
      }
      applyResult(next, 'rotate')
      void refreshSessions(sessionsEpoch.current)
    } catch (reason) {
      showToast(toastFromCaught(reason, t))
    } finally {
      if (mounted.current) setBusyKind(undefined)
    }
  }

  const applyListen = async () => {
    const host = listenHost.trim()
    const portText = listenPort.trim()
    if (host === '' || portText === '') {
      showToast({ kind: 'error', text: t('error.invalidListen') })
      return
    }
    const port = Number(portText)
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      showToast({ kind: 'error', text: t('error.invalidListen') })
      return
    }
    setBusyKind('listen')
    try {
      if (mounted.current) setInvite(undefined)
      applyResult(await api.setListen(host, port), 'listen')
    } catch (reason) {
      showToast(toastFromCaught(reason, t))
    } finally {
      if (mounted.current) setBusyKind(undefined)
    }
  }

  const afterDeviceMutation = async (successKey: 'devices.kicked' | 'devices.approved' | 'devices.rejected' | 'devices.renamed') => {
    showToast({ kind: 'success', text: t(successKey) })
    sessionsEpoch.current += 1
    const epoch = sessionsEpoch.current
    const ok = await refreshSessions(epoch)
    if (!ok) showToast({ kind: 'warn', text: t('error.sessionsPoll') })
  }

  const kick = async (id: string) => {
    setBusyKind('device')
    try {
      const result = await api.revokeSession(id)
      if (!result.ok) {
        showToast({ kind: 'error', text: t('error.sessionActionFailed') })
        return
      }
      await afterDeviceMutation('devices.kicked')
    } catch (reason) {
      showToast(toastFromCaught(reason, t))
    } finally {
      if (mounted.current) setBusyKind(undefined)
    }
  }

  const decide = async (id: string, approve: boolean) => {
    setBusyKind('device')
    try {
      const result = await (approve ? api.approveSession(id) : api.revokeSession(id))
      if (!result.ok) {
        showToast({ kind: 'error', text: t('error.sessionActionFailed') })
        return
      }
      await afterDeviceMutation(approve ? 'devices.approved' : 'devices.rejected')
    } catch (reason) {
      showToast(toastFromCaught(reason, t))
    } finally {
      if (mounted.current) setBusyKind(undefined)
    }
  }

  const rename = async (id: string, label: string) => {
    setBusyKind('device')
    try {
      const result = await api.renameSession(id, label)
      if (!result.ok) {
        showToast({ kind: 'error', text: t('devices.renameFailed') })
        return
      }
      await afterDeviceMutation('devices.renamed')
    } catch (reason) {
      showToast(toastFromCaught(reason, t))
    } finally {
      if (mounted.current) setBusyKind(undefined)
    }
  }

  const runSelfCheck = async () => {
    setBusyKind('check')
    try {
      const result = await api.selfCheck()
      if (mounted.current) setCheck(result)
    } catch (reason) {
      showToast(toastFromCaught(reason, t))
    } finally {
      if (mounted.current) setBusyKind(undefined)
    }
  }

  const generateInvite = async () => {
    setBusyKind('invite')
    try {
      const base = inviteBase.trim()
      const result = await api.invite(base === '' ? undefined : base)
      if (mounted.current) setInvite(result)
    } catch (reason) {
      showToast(toastFromCaught(reason, t))
    } finally {
      if (mounted.current) setBusyKind(undefined)
    }
  }

  const running = status?.running === true
  const statusReady = status !== undefined
  const wildcard = isWildcardListen(listenHost.trim())
  const nonLoopback = listenHost.trim() !== ''
    && !wildcard
    && !['127.0.0.1', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1'].includes(listenHost.trim())
  const startStopLabel = busyKind === 'start' || busyKind === 'stop'
    ? t('busy')
    : running ? t('stop') : t('start')
  const checkLabel = busyKind === 'check' ? t('check.running') : t('check.run')
  const inviteLabel = busyKind === 'invite' ? t('busy') : t('invite.generate')
  const listenLabel = busyKind === 'listen' ? t('busy') : t('listen.apply')
  const heroTitle = !statusReady
    ? t('status.loading')
    : running ? t('status.running') : t('status.stopped')
  const heroHint = !statusReady
    ? t('status.loadingHint')
    : running ? t('status.runningHint') : t('status.stoppedHint')
  const qrSvg = safeQrSvg(invite?.qrSvg)

  const fenceDetail = check === undefined
    ? undefined
    : check.fence.ok
      ? t('check.fenceOk', { method: check.fence.method, status: check.fence.status })
      : t('check.fenceFail', {
        method: check.fence.method,
        status: check.fence.status,
        detail: check.fence.detail ? ` — ${check.fence.detail}` : '',
      })

  const extraReachables = (status?.reachables ?? []).filter(url => url !== status?.target)
  const proxyStoppedHint = check !== undefined && statusReady && !running

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
            <strong>{heroTitle}</strong>
            <p className={css.hint}>{heroHint}</p>
          </div>
        </div>
        <div className={css.heroActions}>
          <button
            className={css.secondaryButton}
            type="button"
            disabled={busy || !statusReady}
            onClick={() => { void runSelfCheck() }}
          >
            {checkLabel}
          </button>
          <button
            className={running ? css.dangerButton : css.primaryButton}
            type="button"
            disabled={busy || !statusReady}
            onClick={() => { void run(running ? 'stop' : 'start') }}
          >
            {startStopLabel}
          </button>
        </div>
      </div>

      {check !== undefined && (
        <section className={css.group}>
          <h3 className={css.groupHead}>{t('check.label')}</h3>
          {fenceDetail !== undefined && (
            <p className={check.fence.ok ? css.hint : css.warn}>{fenceDetail}</p>
          )}
          {check.bootstrapFailed === true ? (
            <p className={css.warn}>{t('check.bootstrapFail')}</p>
          ) : check.trustBootstrap === true ? (
            <p className={css.hint}>{t('check.bootstrapOk')}</p>
          ) : (
            <p className={css.hint}>{t('check.bootstrapMissing')}</p>
          )}
          <p className={css.hint}>{check.tls ? t('check.tlsOn') : t('check.tlsOff')}</p>
          <p className={css.hint}>{check.auditLog ? t('check.auditOn') : t('check.auditOff')}</p>
          <p className={css.hint}>{check.trustForwardedFor ? t('check.trustForwardedForOn') : t('check.trustForwardedForOff')}</p>
          {check.allowTokenRead !== true && <p className={css.hint}>{t('check.tokenReadOff')}</p>}
          {proxyStoppedHint && <p className={css.hint}>{t('check.proxyStopped')}</p>}
        </section>
      )}

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
        {extraReachables.length > 0 && (
          <>
            <p className={css.hint}>{t('tunnel.reachables')}</p>
            {extraReachables.map(url => (
              <button
                key={url}
                className={css.copyField}
                type="button"
                onClick={() => { void copy(url, t('tunnel.copy'), 'copied.target') }}
              >
                <code>{url}</code>
                <span>{t('tunnel.copy')}</span>
              </button>
            ))}
          </>
        )}
      </section>

      <section className={css.group}>
        <h3 className={css.groupHead}>{t('invite.label')}</h3>
        <p className={css.hint}>{t('invite.description')}</p>
        <label className={css.field}>
          <span>{t('invite.base')}</span>
          <input
            className={css.input}
            value={inviteBase}
            onChange={event => { setInviteBase(event.target.value) }}
            placeholder={t('invite.placeholder')}
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        <div className={css.tokenRow}>
          <button className={css.secondaryButton} type="button" disabled={busy} onClick={() => { void generateInvite() }}>{inviteLabel}</button>
          {invite !== undefined && (
            <button className={css.secondaryButton} type="button" onClick={() => { void copy(invite.inviteUrl, t('invite.copy'), 'invite.copied') }}>{t('invite.copy')}</button>
          )}
        </div>
        {qrSvg !== undefined && (
          <div
            className={css.qr}
            // SVG is generated by our own qrToSvg / uqr — not user HTML.
            dangerouslySetInnerHTML={{ __html: qrSvg }}
          />
        )}
        {invite !== undefined && (
          <p className={css.hint}><code className={css.inviteUrl}>{invite.inviteUrl}</code></p>
        )}
      </section>

      <section className={css.group}>
        <h3 className={css.groupHead}>{t('listen.label')}</h3>
        <p className={css.hint}>{t('listen.description')}</p>
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
          >{listenLabel}</button>
        </div>
        {wildcard && <p className={css.warn}>{t('listen.wildcard')}</p>}
        {nonLoopback && <p className={css.warn}>{t('listen.warn')}</p>}
      </section>

      <section className={css.group}>
        <h3 className={css.groupHead}>{t('token.label')}</h3>
        <p className={css.hint}>{t('token.description')}</p>
        {accessToken === undefined ? (
          <button className={css.secondaryButton} type="button" disabled={busy} onClick={() => { void revealToken() }}>
            {busyKind === 'token' ? t('busy') : t('token.reveal')}
          </button>
        ) : (
          <div className={css.tokenRow}>
            <button className={css.copyField} type="button" onClick={() => { void copy(accessToken, t('token.copyLabel'), 'copied.token') }}>
              <code>{accessToken}</code><span>{t('tunnel.copy')}</span>
            </button>
            <button className={css.textButton} type="button" disabled={busy} onClick={() => { void rotate() }}>
              {busyKind === 'token' ? t('busy') : t('token.rotate')}
            </button>
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
        onRename={(id, label) => { void rename(id, label) }}
      />
    </div>
  )
}
