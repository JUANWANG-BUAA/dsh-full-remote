import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { createRemotePanelStore } from './store.ts'
import css from './remote.module.css'

export type RemoteActionProps =
  & PropsRuntime<'sidebar.footer.action'>
  & PropsStore<ReturnType<typeof createRemotePanelStore>>

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
      <span className={css.actionIcon} aria-hidden="true">↗</span>
      {wide && <span>反向代理</span>}
    </button>
  )
}
