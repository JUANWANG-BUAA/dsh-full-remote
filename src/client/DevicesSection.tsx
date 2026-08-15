/**
 * DevicesSection — connected-device management inside the settings page.
 *
 * Pure presentational slice: renders the session list (online / pending)
 * and delegates every action through the passed callbacks. Polling and API
 * state live in RemoteSection.
 */
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
}

export function DevicesSection({ sessions, approvalMode, busy, t, onKick, onDecide }: DevicesSectionProps) {
  return (
    <section className={css.group}>
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
              </div>
              <div className={css.deviceActions}>
                {session.status === 'pending' ? (
                  <>
                    <button className={css.textButton} type="button" disabled={busy} onClick={() => { onDecide(session.id, true) }}>{t('devices.approve')}</button>
                    <button className={css.textButton} type="button" disabled={busy} onClick={() => { onDecide(session.id, false) }}>{t('devices.reject')}</button>
                  </>
                ) : (
                  <button className={css.textButton} type="button" disabled={busy} onClick={() => { onKick(session.id) }}>{t('devices.kick')}</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
