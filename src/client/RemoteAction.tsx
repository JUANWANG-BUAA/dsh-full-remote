import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { createRemotePanelStore } from './store.ts'
import { findSidebarFootArea, insertSidebarActionRow } from './sidebarFoot.ts'
import type { ReverseProxyTranslate } from './i18n.ts'
import css from './remote.module.css'

export type RemoteActionProps =
  & PropsRuntime<'sidebar.footer.action'>
  & PropsStore<ReturnType<typeof createRemotePanelStore>>
  & { t: ReverseProxyTranslate }

/**
 * "Relay ring" glyph: a hollow hexagonal gateway node with an inbound arrow
 * on the left and an outbound arrow on the right — traffic enters, is relayed
 * by the proxy, and exits. Pure 16×16 fill paths in the official DeepSeek Harness icon
 * language (fill-based, currentColor); no emoji, no stroke outlines.
 */
function ReverseProxyIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      {/* Hollow hexagonal relay node (outer + inner cut, evenodd). */}
      <path
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8 3.2 12.2 5.6v4.8L8 12.8 3.8 10.4V5.6L8 3.2Zm0 1.2-3.2 1.9v3.4L8 11.6l3.2-1.9V6.3L8 4.4Z"
      />
      {/* Inbound arrow (left, pointing right into the node). */}
      <path
        fill="currentColor"
        d="M.3 7.15h1.1v1.7H.3V7.15Zm1.1-1.15 2.1 2-2.1 2V6Z"
      />
      {/* Outbound arrow (right, pointing right away from the node). */}
      <path
        fill="currentColor"
        d="M12.3 6l2.1 2-2.1 2V6Zm2.1 1.15h1.3v1.7h-1.3V7.15Z"
      />
    </svg>
  )
}

export function RemoteAction({ wide, actions, t }: RemoteActionProps) {
  // `sidebar.footer.action` is a nowrap flex row shared with other plugins'
  // footer buttons. On the standard DeepSeek Harness sidebar layout we promote our button
  // to a dedicated full-width row above the other actions by portaling it
  // into a holder inserted at the top of the foot area. Only our own subtree
  // moves; the host DOM structure is left untouched otherwise, and unknown
  // host layouts degrade to the inline (in-row) button.
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const [holder, setHolder] = useState<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const foot = findSidebarFootArea(anchorRef.current)
    if (foot === null) return
    const node = insertSidebarActionRow(foot)
    node.className = css.actionRow
    // The holder must still be attached (StrictMode double-invoke can run a
    // stale cleanup after a re-run; only the live node gets the state).
    if (node.isConnected) setHolder(node)
    return () => {
      setHolder(null)
      node.remove()
    }
  }, [])

  useLayoutEffect(() => {
    if (holder === null) return
    holder.style.display = 'flex'
    holder.style.justifyContent = wide ? 'flex-start' : 'center'
    // The foot area pads its content by 12px, while the official Settings
    // control bleeds 4px past it on BOTH sides (x=8, width 264). Match that
    // so our row spans the same full-width hit area as the official control.
    holder.style.margin = wide ? '0 -4px' : '0'
    holder.style.width = wide ? 'calc(100% + 8px)' : '100%'
  }, [holder, wide])

  const button = (
    <button
      type="button"
      className={wide ? css.sidebarAction : css.sidebarActionRail}
      aria-haspopup="dialog"
      aria-label={t('action.open')}
      title={t('action.label')}
      onClick={() => { actions.open() }}
    >
      <span className={css.actionIcon}>
        <ReverseProxyIcon size={wide ? 16 : 18} />
      </span>
      {wide && <span className={css.actionLabel}>{t('action.label')}</span>}
    </button>
  )

  return (
    <>
      <div ref={anchorRef} style={{ display: 'none' }} aria-hidden="true" />
      {holder === null ? button : createPortal(button, holder)}
    </>
  )
}
