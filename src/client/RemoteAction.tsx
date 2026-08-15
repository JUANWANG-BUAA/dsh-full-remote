import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { createRemotePanelStore } from './store.ts'
import css from './remote.module.css'

export type RemoteActionProps =
  & PropsRuntime<'sidebar.footer.action'>
  & PropsStore<ReturnType<typeof createRemotePanelStore>>

/**
 * Official DeepSeek Harness icons are 16×16 fill glyphs; this "outgoing link"
 * icon follows the same convention so the entry lines up with the Settings
 * trigger below it.
 */
function ReverseProxyIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M6.25 2.5h6.5a.75.75 0 0 1 .75.75v6.5a.5.5 0 0 1-1 0V4.707L7.354 9.854a.5.5 0 0 1-.708-.708L11.793 4H6.25a.5.5 0 0 1 0-1Z"
        fill="currentColor"
      />
      <path
        d="M3.5 4.5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V9.75a.5.5 0 0 1 1 0v2.75a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h2.75a.5.5 0 0 1 0 1H3.5Z"
        fill="currentColor"
      />
    </svg>
  )
}

export function RemoteAction({ wide, actions }: RemoteActionProps) {
  return (
    <button
      type="button"
      className={wide ? css.sidebarAction : css.sidebarActionRail}
      aria-haspopup="dialog"
      aria-label="打开反向代理"
      title="反向代理"
      onClick={() => { actions.open() }}
    >
      <span className={css.actionIcon}>
        <ReverseProxyIcon size={wide ? 16 : 18} />
      </span>
      {wide && <span className={css.actionLabel}>反向代理</span>}
    </button>
  )
}
