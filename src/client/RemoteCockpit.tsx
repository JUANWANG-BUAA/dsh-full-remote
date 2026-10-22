/** Host-themed control-room: standard density, Sans controls, Mono counts.
 * No global theme/font ownership: all surfaces inherit Harness light/dark tokens. */
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { ReverseProxyTranslate } from './i18n.ts'
import type { RemotePendingItem, RemotePendingState, RemoteSessionView } from './pending-source.ts'
import type { CockpitConnection } from './cockpit-connection.ts'
import css from './cockpit.module.css'

const UNKNOWN = { state: 'unknown' as const, refreshing: false, refreshFailed: false }
const noSubscribe = () => () => {}
const unknownSnapshot = () => UNKNOWN

function available(element: HTMLElement) {
  return !element.closest('[hidden], [inert]') && !element.matches(':disabled')
}

function focusableWithin(panel: HTMLElement) {
  return [...panel.querySelectorAll<HTMLElement>('button, textarea, input, select, a[href], [tabindex], [contenteditable="true"]')]
    .filter(element => element.tabIndex >= 0 && available(element))
}

type Props = {
  state: RemotePendingState
  connection?: CockpitConnection
  t: ReverseProxyTranslate
  canOpenSession?: boolean
  openSession: (id: string) => void
  renderItem: (item: RemotePendingItem) => ReactNode
}

function kindLabel(item: RemotePendingItem, t: ReverseProxyTranslate) {
  return t(item.presentation === 'plan-review' ? 'interact.kind.plan'
    : item.kind === 'approval' ? 'interact.kind.approval' : 'interact.kind.question')
}

function sessionLabel(session: RemoteSessionView, t: ReverseProxyTranslate) {
  if (session.pendingKey !== undefined) return t('cockpit.pending')
  if (session.running === true) return t('cockpit.running')
  if (session.completionUnread) return t('cockpit.review')
  return t(session.running === false ? 'cockpit.stopped' : 'cockpit.unknown')
}

export function RemoteCockpit({ state, connection, t, canOpenSession = true, openSession, renderItem }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [tab, setTab] = useState<'pending' | 'sessions'>('pending')
  const [selected, setSelected] = useState<string>()
  const [recentSession, setRecentSession] = useState<string>()
  const [visited, setVisited] = useState<Set<string>>(() => new Set())
  const panelRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const launcherRef = useRef<HTMLButtonElement>(null)
  const focusRoute = useRef({ selected, tab })
  const restoreLauncher = useRef(false)
  const id = useId()
  const channel = useSyncExternalStore(connection?.subscribe ?? noSubscribe,
    connection?.getSnapshot ?? unknownSnapshot, unknownSnapshot)
  const offline = channel.state !== 'connected'
  const items = state.items
  const sessions = state.sessions ?? []
  const activeItem = items.find(item => item.key === selected)
  const missing = selected !== undefined && activeItem === undefined
  const running = sessions.filter(session => session.running === true).length

  // Keep visited forms mounted for in-memory drafts, but remove resolved waits.
  useEffect(() => {
    const live = new Set(items.map(item => item.key))
    setVisited(current => {
      const next = new Set([...current].filter(key => live.has(key)))
      return next.size === current.size ? current : next
    })
  }, [items])
  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!expanded) {
      // Layout cleanup runs before React unhides the launcher; restore after commit.
      if (restoreLauncher.current) launcherRef.current?.focus()
      restoreLauncher.current = false
      return
    }
    if (panel === null) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    // Isolate every background branch up to body, never the modal's ancestors.
    // Keep the cockpit root's own backdrop active so pointer dismissal still works.
    const isolated = new Map<HTMLElement, string | null>()
    let branch: HTMLElement | null = panel.parentElement
    while (branch !== null && branch !== document.body) {
      const parent: HTMLElement | null = branch.parentElement
      if (parent === null) break
      for (const sibling of parent.children) {
        if (sibling === branch || !(sibling instanceof HTMLElement)) continue
        isolated.set(sibling, sibling.getAttribute('inert'))
        sibling.setAttribute('inert', '')
      }
      branch = parent
    }
    const containFocus = (event: FocusEvent) => {
      const target = event.target
      if (target instanceof HTMLElement && panel.contains(target) && available(target)) return
      ;(closeRef.current ?? panel).focus()
    }
    document.addEventListener('focusin', containFocus, true)
    ;(closeRef.current ?? panel).focus()
    return () => {
      document.removeEventListener('focusin', containFocus, true)
      for (const [element, original] of isolated) {
        if (original === null) element.removeAttribute('inert')
        else element.setAttribute('inert', original)
      }
      // Restore only after releasing containment and background isolation.
      restoreLauncher.current = true
      const launcher = launcherRef.current
      if (launcher?.isConnected && available(launcher)) launcher.focus()
      else if (previous?.isConnected && available(previous)) previous.focus()
    }
  }, [expanded])
  useLayoutEffect(() => {
    const changed = focusRoute.current.selected !== selected || focusRoute.current.tab !== tab
    focusRoute.current = { selected, tab }
    const panel = panelRef.current
    if (!expanded || panel === null) return
    const focused = document.activeElement
    // Navigation gets a stable focus target; ordinary updates leave draft typing alone.
    if (!changed && !missing && focused instanceof HTMLElement && panel.contains(focused) && available(focused)) return
    const detail = panel.querySelector<HTMLElement>('[data-cockpit-detail]:not([hidden])')
    const target = missing ? closeRef.current
      : detail === null ? panel.querySelector<HTMLElement>('[data-cockpit-tab="' + tab + '"]')
        : focusableWithin(detail)[0]
    ;(target ?? closeRef.current ?? panel).focus()
  }, [expanded, selected, tab, missing, offline])

  const minimize = () => { setExpanded(false) }
  const choose = (key: string) => {
    setVisited(current => new Set([...current, key]))
    setSelected(key)
    setTab('pending')
  }
  const navigate = (sessionId: string) => {
    if (!canOpenSession) return
    openSession(sessionId)
    setRecentSession(sessionId)
    minimize()
  }
  const channelLabel = t(channel.state === 'connected' ? 'cockpit.connected'
    : channel.state === 'connecting' ? 'cockpit.connecting'
      : channel.state === 'disconnected' ? 'cockpit.disconnected' : 'cockpit.connectionUnknown')

  return <div className={css.root} data-remote-cockpit="" data-remote-interact={activeItem?.presentation ?? 'console'}>
    <button ref={launcherRef} type="button" className={css.launcher} hidden={expanded}
      aria-label={t('cockpit.launch', { count: items.length })} aria-expanded={expanded} aria-controls={id}
      onClick={() => { setExpanded(true) }}>
      <span className={css.indicator} data-state={channel.state} aria-hidden="true" />
      <span>{t('cockpit.title')}</span><span className={css.count} aria-live="polite">{items.length}</span>
    </button>
    <div className={css.backdrop} hidden={!expanded} aria-hidden="true" onClick={minimize} />
    <section ref={panelRef} tabIndex={-1} data-detail={activeItem !== undefined && tab === 'pending'} id={id} hidden={!expanded} className={css.panel} role="dialog"
      aria-modal="true" aria-labelledby={id + '-title'} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); minimize() }
        if (event.key !== 'Tab') return
        const panel = panelRef.current
        if (panel === null) return
        const focusable = focusableWithin(panel)
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        const active = document.activeElement
        const outside = !(active instanceof HTMLElement) || !panel.contains(active) || !available(active) || active === panel
        if (focusable.length === 0) { event.preventDefault(); panel.focus() }
        else if (event.shiftKey && (outside || active === first)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && (outside || active === last)) { event.preventDefault(); first?.focus() }
      }}>
      <header className={css.header}>
        <div><p className={css.eyebrow}>DeepSeek Harness</p><h2 id={id + '-title'}>{t('cockpit.title')}</h2></div>
        <button ref={closeRef} type="button" className={css.icon} aria-label={t('cockpit.close')} onClick={minimize}>×</button>
      </header>
      <div className={css.connection}>
        <span className={css.channel}><span className={css.indicator} data-state={channel.state} aria-hidden="true" />{channelLabel}</span>
        {connection !== undefined && <button type="button" className={css.textButton} disabled={channel.refreshing}
          onClick={() => { if (offline) connection.reconnect(); else void connection.refresh() }}>
          {channel.refreshing ? t('cockpit.refreshing') : t(offline ? 'cockpit.reconnect' : 'cockpit.refresh')}
        </button>}
      </div>
      <p className={css.hint}>{t(offline ? 'cockpit.offlineHint' : 'cockpit.snapshotHint')}</p>
      {channel.refreshFailed && <p className={css.warning} role="status">{t('cockpit.refreshFailed')}</p>}
      <div className={css.summary}>
        <span><b>{items.length}</b>{t('cockpit.pending')}</span>
        <span><b>{running}</b>{t('cockpit.running')}</span>
        <span><b>{sessions.length}</b>{t('cockpit.sessions')}</span>
      </div>
      <nav className={css.tabs} aria-label={t('cockpit.title')}>
        <button type="button" data-cockpit-tab="pending" aria-pressed={tab === 'pending'} onClick={() => { setTab('pending'); setSelected(undefined) }}>{t('cockpit.pending')}</button>
        <button type="button" data-cockpit-tab="sessions" aria-pressed={tab === 'sessions'} onClick={() => { setTab('sessions'); setSelected(undefined) }}>{t('cockpit.sessions')}</button>
      </nav>
      <div className={css.content}>
        {tab === 'pending' && activeItem === undefined && <div className={css.list}>
          {missing && <p className={css.warning} role="status">{t('cockpit.resolved')}</p>}
          {state.phase === 'pending' && <p className={css.hint} role="status">{t('cockpit.loading')}</p>}
          {state.phase !== 'pending' && items.length === 0 && <div className={css.empty}><h3>{t('cockpit.empty')}</h3><p>{t('cockpit.emptyHint')}</p></div>}
          {items.map(item => <button type="button" key={item.key} className={css.row} onClick={() => { choose(item.key) }}>
            <span className={css.rowTop}><span className={css.kind}>{kindLabel(item, t)}</span><span aria-hidden="true">↗</span></span>
            <strong>{item.sessionTitle}</strong><span className={css.preview}>{item.approval?.reason ?? item.approval?.toolName ?? item.questions?.[0]?.question ?? t('interact.open.hint')}</span>
          </button>)}
        </div>}
        {tab === 'sessions' && <div className={css.list}>
          {state.phase === 'pending' && <p className={css.hint} role="status">{t('cockpit.loading')}</p>}
          {state.phase !== 'pending' && sessions.length === 0 && <p className={css.empty}>{t('cockpit.emptySessions')}</p>}
          {sessions.map(session => <div key={session.id} className={css.sessionRow}>
            <span className={css.kind} data-running={session.running}>{sessionLabel(session, t)}</span><strong>{session.title}</strong>
            {session.id === recentSession && <span className={css.kind}>{t('cockpit.recent')}</span>}
            <div className={css.rowActions}>
              {session.pendingKey !== undefined && <button className={css.textButton} type="button" onClick={() => { if (session.pendingKey !== undefined) choose(session.pendingKey) }}>{t('cockpit.pending')}</button>}
              <button className={css.textButton} type="button" disabled={!canOpenSession} title={!canOpenSession ? t('cockpit.openUnavailable') : undefined}
                onClick={() => { navigate(session.id) }}>{t('interact.open.action')}</button>
            </div>
          </div>)}
        </div>}
        {items.filter(item => visited.has(item.key)).map(item => <div className={css.detail} data-cockpit-detail="" key={item.key} hidden={tab !== 'pending' || selected !== item.key}>
          <div className={css.detailNav}>
            <button type="button" className={css.textButton} onClick={() => { setSelected(undefined) }}>{t('cockpit.back')}</button>
            <button type="button" className={css.textButton} disabled={!canOpenSession} onClick={() => { navigate(item.sessionId) }}>{t('cockpit.context')}</button>
          </div>
          <fieldset className={css.form} disabled={offline}>{renderItem(item)}</fieldset>
          <button type="button" className={css.textButton} onClick={() => { setSelected(undefined) }}>{t('cockpit.later')}</button>
        </div>)}
      </div>
    </section>
  </div>
}
