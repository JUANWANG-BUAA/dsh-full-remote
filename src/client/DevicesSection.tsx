/**
 * DevicesSection — connected-device management inside the settings page.
 *
 * Pure presentational slice: renders the session list (online / pending)
 * and delegates every action through the passed callbacks. Polling and API
 * state live in RemoteSection.
 */
import { useState } from 'react'
import type { SessionInfo } from './types.ts'
import type { ReverseProxyTranslate } from './i18n.ts'
import css from './remote.module.css'

export type DevicesSectionProps = {
  sessions: SessionInfo[]
  approvalMode: boolean
  busy: boolean
  t: ReverseProxyTranslate
  onKick: (id: string) => void
  onDecide: (id: string, approve: boolean) => void
  onRename: (id: string, label: string) => void
}

export function DevicesSection({
  sessions, approvalMode, busy, t, onKick, onDecide, onRename,
}: DevicesSectionProps) {
  const [renamingId, setRenamingId] = useState<string>()
  const [draft, setDraft] = useState('')

  const beginRename = (session: SessionInfo) => {
    setRenamingId(session.id)
    setDraft(session.label)
  }

  const cancelRename = () => {
    setRenamingId(undefined)
    setDraft('')
  }

  const submitRename = (id: string) => {
    const next = draft.trim()
    if (next === '') return
    onRename(id, next)
    cancelRename()
  }

  return (
    <section className={css.group} data-shot="devices">
      <h3 className={css.groupHead}>{t('devices.title')}</h3>
      {approvalMode && <p className={css.hint}>{t('devices.approvalHint')}</p>}
      {sessions.length === 0 ? (
        <p className={css.emptyText}>{t('devices.empty')}</p>
      ) : (
        <ul className={css.deviceList}>
          {sessions.map(session => (
            <li key={session.id} className={css.deviceItem}>
              <div className={css.deviceInfo}>
                <strong>{session.label}</strong>
                <span className={session.status === 'pending' ? css.pendingBadge : css.onlineBadge}>
                  {session.status === 'pending' ? t('devices.pending') : t('devices.active')}
                </span>
                <span className={css.deviceMeta}>
                  {t('devices.lastSeen', { time: new Date(session.lastSeenAt).toLocaleString() })}
                </span>
                {session.lastSeenIp !== undefined && (
                  <span className={css.deviceMeta}>
                    {t('devices.lastSeenIp', { ip: session.lastSeenIp })}
                  </span>
                )}
              </div>
              <div className={css.deviceActions}>
                {session.status === 'pending' ? (
                  <>
                    <button
                      className={css.textButton}
                      type="button"
                      disabled={busy}
                      aria-label={`${t('devices.approve')}: ${session.label}`}
                      onClick={() => { onDecide(session.id, true) }}
                    >{t('devices.approve')}</button>
                    <button
                      className={css.textButton}
                      type="button"
                      disabled={busy}
                      aria-label={`${t('devices.reject')}: ${session.label}`}
                      onClick={() => { onDecide(session.id, false) }}
                    >{t('devices.reject')}</button>
                  </>
                ) : renamingId === session.id ? (
                  <form
                    className={css.deviceRename}
                    onSubmit={event => {
                      event.preventDefault()
                      submitRename(session.id)
                    }}
                  >
                    <input
                      className={css.input}
                      value={draft}
                      maxLength={64}
                      disabled={busy}
                      aria-label={t('devices.renamePrompt')}
                      autoFocus
                      onChange={event => { setDraft(event.target.value) }}
                      onKeyDown={event => { if (event.key === 'Escape') cancelRename() }}
                    />
                    <button className={css.textButton} type="submit" disabled={busy || draft.trim() === ''}>
                      {t('devices.renameSave')}
                    </button>
                    <button className={css.textButton} type="button" disabled={busy} onClick={cancelRename}>
                      {t('devices.renameCancel')}
                    </button>
                  </form>
                ) : (
                  <>
                    <button
                      className={css.textButton}
                      type="button"
                      disabled={busy}
                      aria-label={`${t('devices.rename')}: ${session.label}`}
                      onClick={() => { beginRename(session) }}
                    >{t('devices.rename')}</button>
                    <button
                      className={css.textButton}
                      type="button"
                      disabled={busy}
                      aria-label={`${t('devices.kick')}: ${session.label}`}
                      onClick={() => { onKick(session.id) }}
                    >{t('devices.kick')}</button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
