/**
 * RemoteSection — reverse-proxy control page on the official
 * `settings.section` slot. Rhythm matches Plugins / Agent presets:
 * 18/600 title, 13px intro, grouped fields, primary action in the
 * status card. The shell owns the dialog chrome and nav.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AuditResult, InviteResult, ProxyApi, ProxyStatus, SelfCheckResult, SessionInfo, TunnelStatus } from './types.ts'
import { DevicesSection } from './DevicesSection.tsx'
import type { ReverseProxyTranslate } from './i18n.ts'
import { PanelToast } from './PanelToast.tsx'
import { ReverseProxyIcon } from './ReverseProxyIcon.tsx'
import { toastFromCaught, toastFromReason, toastFromStatus, toastFromTunnelDetail, type PanelToastModel, type ToastIntent } from './toast.ts'
import { isLoopbackHost, isWildcardHost } from '../hosts.ts'
import css from './remote.module.css'

export type RemoteSectionProps =
  & PropsRuntime<'settings.section'>
  & { api: ProxyApi, t: ReverseProxyTranslate }

/** Only render QR SVG that looks like our own generator output. */
function safeQrSvg(svg: string | undefined) {
  if (typeof svg !== 'string') return undefined
  const trimmed = svg.trim()
  if (!trimmed.startsWith('<svg') || /<script[\s>]/i.test(trimmed)) return undefined
  return trimmed
}

function isLoopbackHttpUrl(url: string) {
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && isLoopbackHost(parsed.hostname)
  } catch {
    return false
  }
}

function CopyField(props: {
  value: string
  action: string
  disabled?: boolean
  onCopy: () => void
}) {
  return (
    <button className={css.copyField} type="button" disabled={props.disabled} onClick={props.onCopy}>
      <code>{props.value}</code><span>{props.action}</span>
    </button>
  )
}

export function RemoteSection({ api, t }: RemoteSectionProps) {
  const [status, setStatus] = useState<ProxyStatus>()
  const [accessToken, setAccessToken] = useState<string>()
  const [busyKind, setBusyKind] = useState<'start' | 'stop' | 'listen' | 'token' | 'check' | 'invite' | 'device' | 'tunnel' | undefined>()
  const busy = busyKind !== undefined
  const [toast, setToast] = useState<(PanelToastModel & { id: number })>()
  const [listenHost, setListenHost] = useState('')
  const [listenPort, setListenPort] = useState('')
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [check, setCheck] = useState<SelfCheckResult>()
  const [inviteBase, setInviteBase] = useState('')
  const [invite, setInvite] = useState<InviteResult>()
  const [audit, setAudit] = useState<AuditResult>()
  const [auditLoading, setAuditLoading] = useState(false)
  const [auditFilter, setAuditFilter] = useState('')
  const [auditLimit, setAuditLimit] = useState('50')
  const toastSeq = useRef(0)
  const mounted = useRef(true)
  const sessionsEpoch = useRef(0)
  /** Previous tunnel snapshot so polling toasts transitions exactly once. */
  const prevTunnelRef = useRef<TunnelStatus | undefined>(undefined)
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

  // Follow the tunnel while it is starting or online: starting → online gets
  // a success toast, and a later exit/error surfaces instead of going quiet.
  useEffect(() => {
    const state = status?.tunnel?.state
    if (state !== 'starting' && state !== 'online') return
    const timer = setInterval(() => {
      void api.status().then(
        next => {
          if (!mounted.current) return
          const prev = prevTunnelRef.current
          applyTunnelStatus(next)
          const tunnel = next.tunnel
          if (tunnel === undefined) return
          if (tunnel.state === 'error' && prev?.state !== 'error') {
            const model = tunnel.detail === undefined ? undefined : toastFromTunnelDetail(tunnel.detail, t)
            showToast(model ?? { kind: 'error', text: t('tunnel.state.error') })
          } else if (tunnel.state === 'online' && prev?.state !== 'online' && tunnel.publicUrl !== undefined) {
            showToast({ kind: 'success', text: t('tunnel.toast.online', { url: tunnel.publicUrl }) })
          }
        },
        () => {
          // transient poll failure: keep the interval while starting
        },
      )
    }, 2000)
    return () => { clearInterval(timer) }
  }, [status?.tunnel?.state, api, t])

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

  const withBusy = async (
    kind: 'start' | 'stop' | 'listen' | 'token' | 'check' | 'invite' | 'device' | 'tunnel',
    work: () => Promise<void>,
  ) => {
    setBusyKind(kind)
    try {
      await work()
    } catch (reason) {
      showToast(toastFromCaught(reason, t))
    } finally {
      if (mounted.current) setBusyKind(undefined)
    }
  }

  const run = async (intent: 'start' | 'stop') => {
    await withBusy(intent, async () => {
      applyResult(await (intent === 'stop' ? api.stop() : api.start()), intent)
    })
  }

  const applyTunnelStatus = (next: ProxyStatus) => {
    if (!mounted.current) return
    prevTunnelRef.current = next.tunnel
    setStatus(next)
    // An invite minted against a dead quick-tunnel URL can no longer connect;
    // clear it whenever the tunnel leaves starting/online.
    const tunnel = next.tunnel
    if (tunnel !== undefined && tunnel.state !== 'starting' && tunnel.state !== 'online') setInvite(undefined)
  }

  const startTunnel = async () => {
    await withBusy('tunnel', async () => {
      // One click from the user's point of view: bring the proxy up first,
      // then the tunnel. The host refuses a tunnel without a listener anyway.
      let current = status
      if (!(current?.running)) {
        current = await api.start()
        if (mounted.current) {
          setStatus(current)
          setCheck(undefined)
        }
        if (!current.running) {
          showToast(toastFromStatus(current, t, 'start'))
          return
        }
      }
      applyTunnelStatus(await api.startTunnel())
    })
  }

  const stopTunnel = async () => {
    await withBusy('tunnel', async () => {
      applyTunnelStatus(await api.stopTunnel())
      showToast({ kind: 'success', text: t('tunnel.toast.stopped') })
    })
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
    await withBusy('token', async () => {
      const token = await api.token()
      if (mounted.current) setAccessToken(token)
    })
  }

  const rotate = async () => {
    await withBusy('token', async () => {
      const next = await api.rotateToken()
      sessionsEpoch.current += 1
      if (mounted.current) {
        setInvite(undefined)
        setSessions([])
        setAccessToken(next.accessToken)
      }
      applyResult(next, 'rotate')
      void refreshSessions(sessionsEpoch.current)
    })
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
    await withBusy('listen', async () => {
      if (mounted.current) setInvite(undefined)
      applyResult(await api.setListen(host, port), 'listen')
    })
  }

  const afterDeviceMutation = async (successKey: 'devices.kicked' | 'devices.approved' | 'devices.rejected' | 'devices.renamed') => {
    showToast({ kind: 'success', text: t(successKey) })
    sessionsEpoch.current += 1
    const epoch = sessionsEpoch.current
    const ok = await refreshSessions(epoch)
    if (!ok) showToast({ kind: 'warn', text: t('error.sessionsPoll') })
  }

  const mutateDevice = async (
    action: () => Promise<{ ok: boolean }>,
    successKey: 'devices.kicked' | 'devices.approved' | 'devices.rejected' | 'devices.renamed',
    failKey: 'error.sessionActionFailed' | 'devices.renameFailed',
  ) => {
    await withBusy('device', async () => {
      const result = await action()
      if (!result.ok) {
        showToast({ kind: 'error', text: t(failKey) })
        return
      }
      await afterDeviceMutation(successKey)
    })
  }

  const kick = (id: string) => mutateDevice(
    () => api.revokeSession(id),
    'devices.kicked',
    'error.sessionActionFailed',
  )

  const decide = (id: string, approve: boolean) => mutateDevice(
    () => (approve ? api.approveSession(id) : api.revokeSession(id)),
    approve ? 'devices.approved' : 'devices.rejected',
    'error.sessionActionFailed',
  )

  const rename = (id: string, label: string) => mutateDevice(
    () => api.renameSession(id, label),
    'devices.renamed',
    'devices.renameFailed',
  )

  const runSelfCheck = async () => {
    await withBusy('check', async () => {
      const result = await api.selfCheck()
      if (mounted.current) setCheck(result)
    })
  }

  const generateInvite = async () => {
    await withBusy('invite', async () => {
      const base = inviteBase.trim()
      const result = await api.invite(base === '' ? undefined : base)
      if (mounted.current) setInvite(result)
    })
  }

  const loadAudit = async () => {
    if (auditLoading) return
    setAuditLoading(true)
    try {
      const rawLimit = auditLimit.trim() === '' ? 50 : Number(auditLimit)
      const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50
      const result = await api.audit(limit, auditFilter.trim() || undefined)
      if (mounted.current) setAudit(result)
    } catch (reason) {
      showToast(toastFromCaught(reason, t))
    } finally {
      if (mounted.current) setAuditLoading(false)
    }
  }

  const exportAudit = async () => {
    try {
      const blob = await api.exportAudit(auditFilter.trim() || undefined)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'dsh-reverse-proxy-audit.json'
      document.body.appendChild(link)
      link.click()
      link.remove()
      // Revoking synchronously can cancel the download in some browsers
      // (Firefox); give the navigation a beat to start first.
      window.setTimeout(() => { URL.revokeObjectURL(url) }, 1000)
      showToast({ kind: 'success', text: t('audit.exported') })
    } catch (reason) {
      showToast(toastFromCaught(reason, t))
    }
  }

  const running = status?.running === true
  const statusReady = status !== undefined
  const host = listenHost.trim()
  const wildcard = isWildcardHost(host)
  const nonLoopback = host !== '' && !wildcard && !isLoopbackHost(host)
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
  // The recommended at-home entry: a directly connectable LAN URL when one
  // exists (listen on a LAN IP or a reachable published address).
  const lanUrl = !statusReady
    ? undefined
    : !isLoopbackHttpUrl(status.target)
      ? status.target
      : (status.reachables ?? []).find(url => !isLoopbackHttpUrl(url))
  const tunnelState = status?.tunnel?.state ?? 'off'
  const tunnelUrl = status?.tunnel?.publicUrl
  const tunnelOn = tunnelState === 'starting' || tunnelState === 'online'
  const tunnelBusy = busyKind === 'tunnel'
  const tunnelStartLabel = tunnelBusy ? t('busy') : tunnelOn ? t('tunnel.oneClick.stop') : t('tunnel.oneClick.start')
  const tunnelStage = tunnelState === 'starting'
    ? status?.tunnel?.detail === 'resolving' ? t('tunnel.state.resolving')
      : status?.tunnel?.detail === 'downloading' ? t('tunnel.state.downloading')
        : status?.tunnel?.detail === 'connecting' ? t('tunnel.state.connecting') : t('busy')
    : undefined
  const tlsBlocksTunnel = status?.tls === true
  const tunnelHint = tlsBlocksTunnel
    ? t('tunnel.hint.tlsBlocked')
    : tunnelState === 'starting'
      ? tunnelStage
      : tunnelState === 'online'
        ? t('tunnel.hint.ephemeral')
        : tunnelState === 'error'
          ? t('tunnel.state.error')
          : !running ? t('tunnel.hint.requiresProxy') : undefined
  const copyTarget = (url: string) => { void copy(url, t('tunnel.copy'), 'copied.target') }

  return (
    <div className={css.section} data-shot="section">
      <h2 className={css.title}>{t('section.title')}</h2>
      <p className={css.intro}>{t('section.intro')}</p>

      {toast !== undefined && (
        <PanelToast key={toast.id} toast={toast} t={t} onDismiss={dismissToast} />
      )}

      <div className={css.hero} data-shot="hero">
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
        <section className={css.group} data-shot="check">
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
          <p className={css.hint}>{check.allowTokenRead ? t('check.tokenReadOn') : t('check.tokenReadOff')}</p>
          {proxyStoppedHint && <p className={css.hint}>{t('check.proxyStopped')}</p>}
        </section>
      )}

      <section className={css.group} data-shot="listen">
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

      <section className={css.group} data-shot="guide">
        <h3 className={css.groupHead}>{t('guide.label')}</h3>
        <p className={css.hint}>{t('guide.description')}</p>
        <p className={css.hint}>{lanUrl !== undefined ? t('guide.wifi', { url: lanUrl }) : t('guide.wifiNone')}</p>
        <p className={css.hint}>{t('guide.outside')}</p>
        <p className={css.warn}>{t('guide.quick')}</p>
      </section>

      <section className={css.group} data-shot="tunnel">
        <h3 className={css.groupHead}>{t('tunnel.label')}</h3>
        <CopyField
          value={status?.target ?? t('tunnel.loading')}
          action={t('tunnel.copy')}
          disabled={status === undefined}
          onCopy={() => { if (status !== undefined) copyTarget(status.target) }}
        />
        {status?.wildcard === true && status.listen !== undefined && (
          <p className={css.hint}>{t('tunnel.bound', { bind: `${status.listen.host}:${status.listen.port}` })}</p>
        )}
        {lanUrl !== undefined && (
          <p className={css.hint}>{t('tunnel.target.recommended')}</p>
        )}
        {extraReachables.length > 0 && (
          <>
            <p className={css.hint}>{t('tunnel.reachables')}</p>
            {extraReachables.map(url => (
              <CopyField key={url} value={url} action={t('tunnel.copy')} onCopy={() => { copyTarget(url) }} />
            ))}
          </>
        )}
      </section>

      <section className={css.group} data-shot="oneClick">
        <h3 className={css.groupHead}>{t('tunnel.oneClick.label')} <span className={css.badge}>{t('tunnel.oneClick.badge')}</span></h3>
        <p className={css.hint}>{t('tunnel.oneClick.description')}</p>
        <div className={css.tokenRow}>
          <button
            className={tunnelOn ? css.dangerButton : css.secondaryButton}
            type="button"
            disabled={busy || tlsBlocksTunnel}
            onClick={() => { void (tunnelOn ? stopTunnel() : startTunnel()) }}
          >
            {tunnelStartLabel}
          </button>
          {tunnelState === 'online' && tunnelUrl !== undefined && (
            <CopyField value={tunnelUrl} action={t('tunnel.copy')} onCopy={() => { copyTarget(tunnelUrl) }} />
          )}
        </div>
        {tunnelHint !== undefined && (
          <p className={tunnelState === 'error' || tlsBlocksTunnel ? css.warn : css.hint}>{tunnelHint}</p>
        )}
      </section>

      <section className={css.group} data-shot="invite">
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
          <button
            className={css.secondaryButton}
            type="button"
            disabled={busy || (statusReady && !running)}
            onClick={() => { void generateInvite() }}
          >{inviteLabel}</button>
          {invite !== undefined && (
            <button className={css.secondaryButton} type="button" onClick={() => { void copy(invite.inviteUrl, t('invite.copy'), 'invite.copied') }}>{t('invite.copy')}</button>
          )}
        </div>
        {statusReady && !running && (
          <p className={css.hint}>{t('invite.requiresRunning')}</p>
        )}
        {tunnelState === 'online' && (
          <p className={css.hint}>{t('tunnel.hint.inviteUsesTunnel')}</p>
        )}
        {tunnelState === 'off' && statusReady && running && (
          <p className={css.hint}>{t('invite.lanHint')}</p>
        )}
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

      <section className={css.group} data-shot="token">
        <h3 className={css.groupHead}>{t('token.label')}</h3>
        <p className={css.hint}>{t('token.description')}</p>
        {accessToken === undefined ? (
          <button className={css.secondaryButton} type="button" disabled={busy} onClick={() => { void revealToken() }}>
            {busyKind === 'token' ? t('busy') : t('token.reveal')}
          </button>
        ) : (
          <div className={css.tokenRow}>
            <CopyField value={accessToken} action={t('tunnel.copy')} onCopy={() => { void copy(accessToken, t('token.copyLabel'), 'copied.token') }} />
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

      <section className={css.group} data-shot="audit">
        <h3 className={css.groupHead}>{t('audit.label')}</h3>
        <p className={css.hint}>{t('audit.description')}</p>
        <div className={css.auditRow}>
          <label className={css.field}>
            <span>{t('audit.filter')}</span>
            <input
              className={css.input}
              value={auditFilter}
              onChange={event => { setAuditFilter(event.target.value) }}
              placeholder={t('audit.filterPlaceholder')}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <label className={css.field}>
            <span>{t('audit.limit')}</span>
            <input
              className={css.input}
              value={auditLimit}
              onChange={event => { setAuditLimit(event.target.value.replace(/[^0-9]/g, '')) }}
              inputMode="numeric"
              placeholder="50"
            />
          </label>
        </div>
        <div className={css.auditActions}>
          <button
            className={css.secondaryButton}
            type="button"
            disabled={busy || auditLoading}
            onClick={() => { void loadAudit() }}
          >
            {auditLoading ? t('busy') : t('audit.load')}
          </button>
          <button
            className={css.secondaryButton}
            type="button"
            disabled={busy || auditLoading}
            onClick={() => { void exportAudit() }}
          >
            {t('audit.export')}
          </button>
        </div>
        {audit !== undefined && !audit.enabled && <p className={css.warn}>{t('audit.disabled')}</p>}
        {audit !== undefined && audit.enabled && audit.events.length === 0 && (
          <p className={css.hint}>{t('audit.empty')}</p>
        )}
        {audit !== undefined && audit.events.length > 0 && (
          <ul className={css.auditList}>
            {audit.events.map((event, index) => (
              <li key={`${event.ts}-${index}`} className={css.auditItem}>
                <code>{event.ts}</code>
                <strong>{event.event}</strong>
                <pre className={css.auditDetail}>{JSON.stringify(event, null, 2)}</pre>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
