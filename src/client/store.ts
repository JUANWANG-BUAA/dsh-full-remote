import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

export type RemotePanelState = {
  open: boolean
}

export type RemotePanelActions = {
  open: (draft: RemotePanelState) => void
  close: (draft: RemotePanelState) => void
}

export function createRemotePanelStore(): EngineStoreHandle<RemotePanelState, RemotePanelActions> {
  return defineStore({
    init: () => ({ open: false }),
    actions: {
      open: draft => { draft.open = true },
      close: draft => { draft.open = false },
    },
  })
}
