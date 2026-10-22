/** Isolated, network-free fixture around the real mobile interaction UI. */
import { useEffect, useState, type ComponentProps } from 'react'
import { InteractionOverlay } from '../../src/client/InteractionOverlay.tsx'
import type { CockpitConnection, CockpitConnectionSnapshot } from '../../src/client/cockpit-connection.ts'
import type { LanguageController } from '../../src/client/language.ts'
import type { ReverseProxyTranslate } from '../../src/client/i18n.ts'
import type { RemotePendingState } from '../../src/client/pending-source.ts'

type ChannelState = CockpitConnectionSnapshot['state']

function demoConnection(initial: ChannelState) {
  let snapshot: CockpitConnectionSnapshot = { state: initial, refreshing: false, refreshFailed: false }
  const listeners = new Set<() => void>()
  let active = true
  const setState = (state: ChannelState) => {
    if (!active || state === snapshot.state) return
    snapshot = { ...snapshot, state }
    for (const listener of listeners) listener()
  }
  const source: CockpitConnection = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      if (!active) return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    // A resolved local refresh makes no baseline/synchronization claim.
    refresh: async () => {},
    reconnect: () => { setState('connected') },
    dispose: () => { active = false; listeners.clear() },
  }
  return { source, setState }
}

function initialState(english: boolean, pending: boolean): RemotePendingState {
  const approvalTitle = english ? 'Review read-only workspace inspection' : '审核只读工作区检查'
  const questionTitle = 'MobileConsoleIntegrationWithoutSpacesAndWithAnIntentionallyVeryLongSessionTitleForNarrowViewportStressTesting0123456789'
  const planTitle = english ? 'Review mobile release plan' : '审核手机控制台发布计划'
  const approve = english ? 'Approve' : '批准'
  const decline = english ? 'Revise' : '修改'
  const plan = Array.from({ length: 14 }, (_, index) => english
    ? '## Step ' + (index + 1) + '\nVerify the public contract, preserve last-known status, and test phone-width interaction without touching host files or replaying an action. Confirm keyboard navigation, long content, and offline recovery.\n'
    : '## 第 ' + (index + 1) + ' 步\n核对公开契约并保留最近已知状态，在真实手机宽度验证确认操作。不要修改主机文件或自动重发操作。逐项检查键盘导航、超长内容、断线恢复与滚动区域。\n').join('\n')
  return {
    phase: pending ? 'pending' : 'ready',
    items: [
      { key: 'demo:approval', kind: 'approval', presentation: 'approval', sessionId: 'demo-approval', sessionTitle: approvalTitle, ready: true,
        approval: { toolName: 'read', reason: english ? 'Inspect README.md in this fictional workspace. Demo only: no tool is executed.' : '查看虚构工作区中的 README.md。仅为示例，不会执行任何工具。' } },
      { key: 'demo:question', kind: 'question', presentation: 'question', sessionId: 'demo-question', sessionTitle: questionTitle, ready: true,
        questions: [{ id: 'target', question: english ? 'Which phone layout should we verify first?' : '优先验证哪种手机布局？', options: [
          { label: english ? 'Compact (recommended)' : '紧凑布局（推荐）', description: english ? '390 CSS-pixel viewport' : '390 CSS 像素宽视口' },
          { label: english ? 'Spacious' : '宽松布局' },
        ] }] },
      { key: 'demo:plan', kind: 'question', presentation: 'plan-review', sessionId: 'demo-plan', sessionTitle: planTitle, ready: true,
        questions: [{ id: 'plan', question: english ? 'Review this mobile release plan' : '请审核手机端发布计划', detail: plan,
          intent: { kind: 'plan-review', approve }, options: [{ label: approve }, { label: decline }] }] },
    ],
    sessions: [
      { id: 'demo-approval', title: approvalTitle, running: true, pendingKey: 'demo:approval', completionUnread: false },
      { id: 'demo-question', title: questionTitle, running: true, pendingKey: 'demo:question', completionUnread: false },
      { id: 'demo-plan', title: planTitle, running: true, pendingKey: 'demo:plan', completionUnread: false },
      { id: 'demo-running', title: english ? 'Background analysis — running' : '后台分析：运行中', running: true, completionUnread: false },
      { id: 'demo-stopped', title: english ? 'Stopped outside main view — review needed' : '主视图外已停止：待查看', running: false, completionUnread: true },
    ],
  }
}

export function CockpitDemo({ t, language, params }: {
  t: ReverseProxyTranslate
  language: LanguageController
  params: URLSearchParams
}) {
  const english = language.getPreference() === 'en'
  const initialChannel = params.get('connection')
  const [channel] = useState(() => demoConnection(
    initialChannel === 'disconnected' || initialChannel === 'connecting' || initialChannel === 'unknown' ? initialChannel : 'connected',
  ))
  const [state, setState] = useState(() => initialState(english, params.get('phase') === 'pending'))
  const [currentTitle, setCurrentTitle] = useState(english ? 'Demo conversation' : '示意会话')
  useEffect(() => () => { channel.source.dispose() }, [channel])

  const resolve = async (key: string) => {
    // Immutable main state makes the selector projection rerender immediately.
    setState(previous => ({
      ...previous,
      items: previous.items.filter(item => item.key !== key),
      sessions: previous.sessions?.map(session => {
        if (session.pendingKey !== key) return session
        const { pendingKey: _pendingKey, ...rest } = session
        return rest
      }),
    }))
  }
  const useRemotePending = <Selected,>(selector: (value: RemotePendingState) => Selected) => selector(state)
  // Only the fixture boundary supplies generated slot props: createRoot has no slot renderer.
  const overlayProps = {
    enabled: true, t, language, connection: channel.source, canOpenSession: true,
    openSession: (id: string) => {
      setCurrentTitle(state.sessions?.find(session => session.id === id)?.title ?? id)
    },
    answerApproval: resolve,
    answerQuestion: resolve,
    cancelQuestion: resolve,
    useRemotePending,
    useSessions: () => undefined,
    useWorkspaces: () => undefined,
  } as unknown as ComponentProps<typeof InteractionOverlay>

  return <div className="cockpit-demo" data-shot="cockpit-demo">
    <main className="cockpit-demo-background">
      <p className="cockpit-demo-eyebrow">DeepSeek Harness · {english ? 'LOCAL FIXTURE' : '本地示例'}</p>
      <h1>{english ? 'Conversation' : '会话'}</h1>
      <p className="cockpit-demo-caption">{english ? 'Current demo session' : '当前示意会话'}</p>
      <h2 data-demo-current-session="">{currentTitle}</h2>
      <p>{english ? 'Open the control console above, then choose an item. All answers stay in memory; no host is connected.' : '点击上方控制台入口，再选择待办。所有回答仅保存在内存中，不连接真实主机。'}</p>
      <div className="cockpit-demo-controls" aria-label={english ? 'Local fixture controls' : '本地示例控制'}>
        <button type="button" onClick={() => { channel.setState('disconnected') }}>{english ? 'Simulate disconnect' : '模拟断开'}</button>
        <button type="button" onClick={() => { channel.setState('connected') }}>{english ? 'Simulate recovery' : '模拟恢复'}</button>
        <button type="button" onClick={() => { setState(initialState(english, params.get('phase') === 'pending')) }}>{english ? 'Reset pending items' : '重置待办'}</button>
      </div>
    </main>
    <InteractionOverlay {...overlayProps} />
  </div>
}
