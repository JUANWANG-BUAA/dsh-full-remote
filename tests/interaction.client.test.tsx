import type { Context } from '@deepseek-ai/cordis'
import type { ComponentProps } from 'react'
import type { CockpitConnection, CockpitConnectionSnapshot } from '../src/client/cockpit-connection.ts'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InteractionOverlay } from '../src/client/InteractionOverlay.tsx'
import {
  createPendingSource,
  parseRecommendedLabel,
  planReviewOf,
  shouldUseInteractionOverlay,
  type QuestionAnswer,
  type RemotePendingItem,
  type RemotePendingState,
} from '../src/client/pending-source.ts'
import { bindTranslate, translatorFor, zh } from '../src/client/i18n.ts'

afterEach(cleanup)

const t = translatorFor(zh)

function connection(state: CockpitConnectionSnapshot['state'] = 'connected'): CockpitConnection {
  const snapshot: CockpitConnectionSnapshot = { state, refreshing: false, refreshFailed: false }
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    refresh: vi.fn().mockResolvedValue(undefined),
    reconnect: vi.fn(),
    dispose: vi.fn(),
  }
}

function openCockpit() {
  fireEvent.click(screen.getByRole('button', { name: /任务控制台，\d+ 项待办/ }))
}

function choosePending(title: string | RegExp = /Demo session/) {
  fireEvent.click(screen.getByRole('button', { name: title }))
}

function openPending(title: string | RegExp = /Demo session/) {
  openCockpit()
  choosePending(title)
}

function overlayProps(
  state: RemotePendingState,
  overrides: Partial<ComponentProps<typeof InteractionOverlay>> = {},
): ComponentProps<typeof InteractionOverlay> {
  return {
    t,
    enabled: true,
    connection: connection(),
    openSession: vi.fn(),
    answerApproval: vi.fn().mockResolvedValue(undefined),
    answerQuestion: vi.fn().mockResolvedValue(undefined),
    cancelQuestion: vi.fn().mockResolvedValue(undefined),
    useRemotePending: (selector: (snapshot: RemotePendingState) => unknown) => selector(state),
    useSessions: vi.fn(),
    useWorkspaces: vi.fn(),
    ...overrides,
  } as unknown as ComponentProps<typeof InteractionOverlay>
}

const approvalItem: RemotePendingItem = {
  key: 'a:1',
  kind: 'approval',
  presentation: 'approval',
  sessionId: 's1',
  sessionTitle: 'Demo session',
  ready: true,
  approval: { toolName: 'bash', reason: 'Run rm -rf /tmp/demo' },
}

const questionItem: RemotePendingItem = {
  key: 'q:1',
  kind: 'question',
  presentation: 'question',
  sessionId: 's1',
  sessionTitle: 'Demo session',
  ready: true,
  questions: [{
    id: 'q',
    question: 'Which branch?',
    options: [
      { label: 'main (recommended)' },
      { label: 'dev', description: 'Unstable' },
    ],
  }],
}

describe('shouldUseInteractionOverlay', () => {
  it('shows on a LAN or tunnel hostname', () => {
    expect(shouldUseInteractionOverlay('192.168.1.8', 1280)).toBe(true)
    expect(shouldUseInteractionOverlay('demo.trycloudflare.com', 1280)).toBe(true)
  })

  it('hides on the host loopback window unless the viewport is narrow', () => {
    expect(shouldUseInteractionOverlay('127.0.0.1', 1280)).toBe(false)
    expect(shouldUseInteractionOverlay('localhost', 375)).toBe(true)
  })
})

describe('planReviewOf / parseRecommendedLabel', () => {
  it('narrows a binary plan-review and strips recommendation suffixes', () => {
    expect(parseRecommendedLabel('Ship it (recommended)')).toEqual({
      label: 'Ship it',
      recommended: true,
    })
    expect(planReviewOf([{
      id: 'p',
      question: 'Review this plan',
      detail: '# Plan',
      options: [{ label: 'Approve' }, { label: 'Reject' }],
      intent: { kind: 'plan-review', approve: 'Approve' },
    }])).toEqual({
      id: 'p',
      question: 'Review this plan',
      plan: '# Plan',
      approve: 'Approve',
      decline: 'Reject',
    })
  })

  it('leaves multi-select or optionless batches to the generic flow', () => {
    expect(planReviewOf([{
      id: 'p',
      question: 'Review',
      detail: 'plan',
      multiSelect: true,
      options: [{ label: 'Approve' }, { label: 'Reject' }],
      intent: { kind: 'plan-review', approve: 'Approve' },
    }])).toBeUndefined()
  })
})

describe('InteractionOverlay', () => {
  it('shows the launcher when empty and nothing when disabled', () => {
    const empty = render(<InteractionOverlay {...overlayProps({ items: [] })} />)
    expect(screen.getByRole('button', { name: '任务控制台，0 项待办' })).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    empty.unmount()
    const { container: off } = render(<InteractionOverlay {...overlayProps(
      { items: [approvalItem] },
      { enabled: false },
    )} />)
    expect(off.querySelector('[data-remote-interact]')).toBeNull()
  })

  it('lets a remote user allow or reject an approval', async () => {
    const answerApproval = vi.fn().mockResolvedValue(undefined)
    render(<InteractionOverlay {...overlayProps({ items: [approvalItem] }, { answerApproval })} />)
    openPending()
    expect(screen.getByRole('dialog', { name: '任务控制台' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '允许一次' }))
    await waitFor(() => {
      expect(answerApproval).toHaveBeenCalledWith('a:1', 'allowed-once')
    })
  })

  it('submits a selected question option', async () => {
    const answerQuestion = vi.fn<(key: string, answer: QuestionAnswer) => Promise<void>>()
      .mockResolvedValue(undefined)
    render(<InteractionOverlay {...overlayProps({ items: [questionItem] }, { answerQuestion })} />)
    openPending()
    fireEvent.click(screen.getByRole('radio', { name: 'main' }))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    await waitFor(() => {
      expect(answerQuestion).toHaveBeenCalledWith('q:1', {
        answers: [{ id: 'q', selected: ['main (recommended)'] }],
      })
    })
  })

  it('lets a custom ask_user_question answer wrap, with Shift+Enter as newline', async () => {
    const answerQuestion = vi.fn<(key: string, answer: QuestionAnswer) => Promise<void>>()
      .mockResolvedValue(undefined)
    render(<InteractionOverlay {...overlayProps({ items: [questionItem] }, { answerQuestion })} />)
    openPending()
    const field = screen.getByPlaceholderText('其他（自行输入）')
    expect(field.tagName).toBe('TEXTAREA')
    fireEvent.change(field, { target: { value: 'line1' } })
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true })
    expect(answerQuestion).not.toHaveBeenCalled()
    fireEvent.change(field, { target: { value: 'line1\nline2' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => {
      expect(answerQuestion).toHaveBeenCalledWith('q:1', {
        answers: [{ id: 'q', selected: [], custom: 'line1\nline2' }],
      })
    })
  })

  it('opens a session when the wait is not ready yet', () => {
    const openSession = vi.fn()
    render(<InteractionOverlay {...overlayProps({
      items: [{
        key: 'hint:s2',
        kind: 'question',
        presentation: 'question',
        sessionId: 's2',
        sessionTitle: 'Other',
        ready: false,
      }],
    }, { openSession })} />)
    openPending(/Other/)
    fireEvent.click(screen.getByRole('button', { name: '打开会话' }))
    expect(openSession).toHaveBeenCalledWith('s2')
  })

  it('approves a plan-review with the asker\'s own label', async () => {
    const answerQuestion = vi.fn<(key: string, answer: QuestionAnswer) => Promise<void>>()
      .mockResolvedValue(undefined)
    render(<InteractionOverlay {...overlayProps({
      items: [{
        key: 'q:plan',
        kind: 'question',
        presentation: 'plan-review',
        sessionId: 's1',
        sessionTitle: 'Demo session',
        ready: true,
        questions: [{
          id: 'p',
          question: 'Review this plan',
          detail: 'do the thing',
          options: [{ label: 'Approve' }, { label: 'Reject' }],
          intent: { kind: 'plan-review', approve: 'Approve' },
        }],
      }],
    }, { answerQuestion })} />)
    openPending()
    fireEvent.click(screen.getByRole('button', { name: '批准计划' }))
    await waitFor(() => {
      expect(answerQuestion).toHaveBeenCalledWith('q:plan', {
        answers: [{ id: 'p', selected: ['Approve'] }],
      })
    })
  })
})

describe('createPendingSource', () => {
  function fakeSessions(titles: Record<string, string>) {
    const snapshot = {
      ids: Object.keys(titles),
      byId: Object.fromEntries(
        Object.entries(titles).map(([id, displayTitle]) => [id, { id, displayTitle }]),
      ),
      phase: 'ready' as const,
      projectionsBySession: {},
    }
    return {
      list: {
        getSnapshot: () => snapshot,
        subscribe: () => () => {},
      },
    }
  }

  function fakeUiSession(interactions: readonly Record<string, unknown>[]) {
    const status = new Map(interactions.map(interaction => [
      interaction.sessionId as string,
      { running: true, pendingInteraction: interaction, completionUnread: false },
    ]))
    return {
      sessionStatus: {
        getSnapshot: () => status,
        subscribe: () => () => {},
      },
    }
  }

  it('projects a pending approval and answers the published interaction', async () => {
    const answer = vi.fn().mockResolvedValue(undefined)
    const sessions = fakeSessions({ s1: 'Demo' })
    const uiSession = fakeUiSession([
      { kind: 'approval', key: 'a:9', sessionId: 's1', toolName: 'bash', reason: 'why', answerable: true, answer },
    ])
    const source = createPendingSource(sessions as never, uiSession as never)
    expect(source.getSnapshot().items).toEqual([expect.objectContaining({
      key: 'a:9',
      ready: true,
      sessionTitle: 'Demo',
      approval: { toolName: 'bash', reason: 'why' },
    })])
    await source.answerApproval('a:9', 'allowed-once')
    expect(answer).toHaveBeenCalledWith('allowed-once')
    source.dispose()
  })

  it('projects a question batch, answers it, and dismisses it', async () => {
    const answer = vi.fn().mockResolvedValue(undefined)
    const dismiss = vi.fn().mockResolvedValue(undefined)
    const sessions = fakeSessions({ s1: 'Demo' })
    const uiSession = fakeUiSession([{
      kind: 'question',
      key: 'q:1',
      sessionId: 's1',
      questions: [{ id: 'q', question: 'Which branch?', options: [{ label: 'main' }] }],
      dismissal: 'cancel',
      answer,
      dismiss,
    }])
    const source = createPendingSource(sessions as never, uiSession as never)
    expect(source.getSnapshot().items).toEqual([expect.objectContaining({
      key: 'q:1',
      presentation: 'question',
      ready: true,
      questions: [expect.objectContaining({ id: 'q', question: 'Which branch?' })],
    })])
    await source.answerQuestion('q:1', { answers: [{ id: 'q', selected: ['main'] }] })
    expect(answer).toHaveBeenCalledWith({ answers: [{ id: 'q', selected: ['main'] }] })
    await source.cancelQuestion('q:1')
    expect(dismiss).toHaveBeenCalled()
    source.dispose()
  })

  it('refuses a stale key once the interaction is gone', async () => {
    const sessions = fakeSessions({ s1: 'Demo' })
    const uiSession = fakeUiSession([])
    const source = createPendingSource(sessions as never, uiSession as never)
    await expect(source.answerApproval('gone', 'rejected')).rejects.toThrow('no longer pending')
    await expect(source.cancelQuestion('gone')).rejects.toThrow('no longer pending')
    source.dispose()
  })
})


it('updates an open approval overlay when the plugin language changes', () => {
  const binding = bindTranslate({ get: () => undefined } as unknown as Context)
  try {
    binding.language.setPreference('zh')
    render(<InteractionOverlay {...overlayProps({ items: [approvalItem] }, binding)} />)
    openPending()
    expect(screen.getByRole('button', { name: '允许一次' })).toBeTruthy()
    act(() => { binding.language.setPreference('en') })
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy()
  } finally {
    binding.dispose()
    localStorage.clear()
  }
})

describe('cockpit selection and recovery', () => {
  const second: RemotePendingItem = { ...questionItem, key: 'q:2', sessionId: 's2', sessionTitle: 'Second session' }

  it('answers the explicitly selected second pending key rather than the first queue entry', async () => {
    const answerQuestion = vi.fn().mockResolvedValue(undefined)
    render(<InteractionOverlay {...overlayProps({ items: [approvalItem, second] }, { answerQuestion })} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    openPending(/Second session/)
    fireEvent.click(screen.getByRole('radio', { name: 'dev' }))
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    await waitFor(() => {
      expect(answerQuestion).toHaveBeenCalledWith('q:2', { answers: [{ id: 'q', selected: ['dev'] }] })
    })
    expect(answerQuestion).toHaveBeenCalledTimes(1)
  })

  it('retains each visited question draft across the list, another form and minimization', () => {
    const cancelQuestion = vi.fn()
    render(<InteractionOverlay {...overlayProps({ items: [questionItem, second] }, { cancelQuestion })} />)
    openPending()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'first draft' } })
    fireEvent.click(screen.getByRole('button', { name: '返回待办列表' }))
    choosePending(/Second session/)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'second draft' } })
    fireEvent.click(screen.getByRole('button', { name: '稍后处理' }))
    choosePending()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('first draft')
    fireEvent.click(screen.getByRole('button', { name: '收起控制台' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(cancelQuestion).not.toHaveBeenCalled()
    openCockpit()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('first draft')
    fireEvent.click(screen.getByRole('button', { name: '返回待办列表' }))
    choosePending(/Second session/)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('second draft')
    expect(cancelQuestion).not.toHaveBeenCalled()
  })

  it('keeps submission locked when its mounted form is hidden and shown again', async () => {
    const answerApproval = vi.fn().mockResolvedValue(undefined)
    render(<InteractionOverlay {...overlayProps({ items: [approvalItem, second] }, { answerApproval })} />)
    openPending()
    fireEvent.click(screen.getByRole('button', { name: '允许一次' }))
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe(t('cockpit.confirming')) })
    fireEvent.click(screen.getByRole('button', { name: '返回待办列表' }))
    choosePending(/Second session/)
    fireEvent.click(screen.getByRole('button', { name: '返回待办列表' }))
    choosePending()
    const buttons = screen.getAllByRole('button').filter(button => button.textContent === t('interact.busy'))
    expect(buttons.length).toBeGreaterThan(0)
    for (const button of buttons) fireEvent.click(button)
    expect(answerApproval).toHaveBeenCalledTimes(1)
  })

  it('reports removal of the selected item instead of automatically opening the next pending', async () => {
    const answerApproval = vi.fn().mockResolvedValue(undefined)
    const answerQuestion = vi.fn().mockResolvedValue(undefined)
    const props = { answerApproval, answerQuestion }
    const { rerender } = render(<InteractionOverlay {...overlayProps({ items: [approvalItem, second] }, props)} />)
    openPending()
    fireEvent.click(screen.getByRole('button', { name: '允许一次' }))
    await waitFor(() => { expect(answerApproval).toHaveBeenCalledTimes(1) })
    rerender(<InteractionOverlay {...overlayProps({ items: [second] }, props)} />)
    expect(screen.getByText(t('cockpit.resolved'))).toBeTruthy()
    expect(screen.getByRole('button', { name: /Second session/ })).toBeTruthy()
    expect(screen.queryByRole('radio')).toBeNull()
    expect(answerQuestion).not.toHaveBeenCalled()
  })

  it('keeps multiple visited forms mounted without duplicate DOM ids or visible duplicate controls', () => {
    const { container } = render(<InteractionOverlay {...overlayProps({ items: [questionItem, second] })} />)
    openPending()
    fireEvent.click(screen.getByRole('button', { name: '返回待办列表' }))
    choosePending(/Second session/)
    expect(container.querySelectorAll('textarea')).toHaveLength(2)
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    const ids = [...container.querySelectorAll('[id]')].map(element => element.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const element of container.querySelectorAll('[aria-labelledby]')) {
      for (const labelId of element.getAttribute('aria-labelledby')!.split(' ')) {
        expect(document.getElementById(labelId)).toBeTruthy()
      }
    }
  })

  it('disables offline actions and never dispatches answer or cancel callbacks', () => {
    const answerApproval = vi.fn()
    const answerQuestion = vi.fn()
    const cancelQuestion = vi.fn()
    render(<InteractionOverlay {...overlayProps({ items: [approvalItem, second] }, {
      connection: connection('disconnected'), answerApproval, answerQuestion, cancelQuestion,
    })} />)
    openPending()
    const allow = screen.getByRole('button', { name: '允许一次' }) as HTMLButtonElement
    expect(allow.matches(':disabled')).toBe(true)
    fireEvent.click(allow)
    fireEvent.click(screen.getByRole('button', { name: '返回待办列表' }))
    choosePending(/Second session/)
    for (const control of [screen.getByRole('button', { name: '提交' }), screen.getByRole('button', { name: t('interact.question.cancel') })]) {
      expect(control.matches(':disabled')).toBe(true)
      fireEvent.click(control)
    }
    expect(screen.getByText(t('cockpit.offlineHint'))).toBeTruthy()
    expect(answerApproval).not.toHaveBeenCalled()
    expect(answerQuestion).not.toHaveBeenCalled()
    expect(cancelQuestion).not.toHaveBeenCalled()
  })

  it('disables context and session navigation without a navigation service', () => {
    const openSession = vi.fn()
    render(<InteractionOverlay {...overlayProps({
      items: [approvalItem],
      sessions: [{ id: 's1', title: 'Demo session', running: true, completionUnread: false }],
    }, { canOpenSession: false, openSession })} />)
    openPending()
    const context = screen.getByRole('button', { name: '查看会话上下文' }) as HTMLButtonElement
    expect(context.disabled).toBe(true)
    fireEvent.click(context)
    fireEvent.click(screen.getByRole('button', { name: '会话' }))
    const open = screen.getByRole('button', { name: '打开会话' }) as HTMLButtonElement
    expect(open.disabled).toBe(true)
    fireEvent.click(open)
    expect(openSession).not.toHaveBeenCalled()
  })

  it('presents unknown running as unknown and completionUnread as an observed stop, not completion', () => {
    render(<InteractionOverlay {...overlayProps({ items: [], phase: 'ready', sessions: [
      { id: 'unknown', title: 'Unknown', running: undefined, completionUnread: false },
      { id: 'stopped', title: 'Stopped', running: false, completionUnread: true },
    ] })} />)
    openCockpit()
    fireEvent.click(screen.getByRole('button', { name: '会话' }))
    expect(screen.getByText(t('cockpit.unknown'))).toBeTruthy()
    expect(screen.getByText(t('cockpit.review'))).toBeTruthy()
    expect(screen.queryByText(/已完成/)).toBeNull()
  })

  it('distinguishes the first-list pending phase from an empty session baseline', () => {
    render(<InteractionOverlay {...overlayProps({ items: [], phase: 'pending', sessions: [] })} />)
    openCockpit()
    fireEvent.click(screen.getByRole('button', { name: '会话' }))
    expect(screen.getByText(t('cockpit.loading'))).toBeTruthy()
    expect(screen.queryByText(t('cockpit.emptySessions'))).toBeNull()
  })

  it('restores launcher focus on Escape and traps Tab at both dialog boundaries', () => {
    render(<InteractionOverlay {...overlayProps({ items: [approvalItem] })} />)
    const launcher = screen.getByRole('button', { name: '任务控制台，1 项待办' })
    launcher.focus()
    openCockpit()
    const first = screen.getByRole('button', { name: '收起控制台' })
    const last = screen.getByRole('button', { name: /Demo session/ })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(launcher)
  })
})

describe('cockpit modal focus isolation', () => {
  it('moves selection focus to detail navigation and returns it to a stable list control', () => {
    render(<><button>Host control</button><InteractionOverlay {...overlayProps({ items: [questionItem] })} /></>)
    openCockpit()
    const row = screen.getByRole('button', { name: /Demo session/ })
    row.focus()
    fireEvent.click(row)
    const back = screen.getByRole('button', { name: '返回待办列表' })
    expect(document.activeElement).toBe(back)
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
    const last = screen.getByRole('button', { name: '稍后处理' })
    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '收起控制台' }))
    back.focus()
    fireEvent.click(back)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '待我处理' }))
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
  })

  it('recaptures outside programmatic focus and never moves into hidden drafts', () => {
    const second = { ...questionItem, key: 'q:2', sessionId: 's2', sessionTitle: 'Second session' }
    render(<><button>Host control</button><InteractionOverlay {...overlayProps({ items: [questionItem, second] })} /></>)
    const host = screen.getByRole('button', { name: 'Host control' })
    openPending()
    const firstDraft = screen.getByRole('textbox')
    firstDraft.focus()
    fireEvent.change(firstDraft, { target: { value: 'still typing' } })
    expect(document.activeElement).toBe(firstDraft)
    fireEvent.click(screen.getByRole('button', { name: '返回待办列表' }))
    choosePending(/Second session/)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '返回待办列表' }))
    firstDraft.focus()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '收起控制台' }))
    host.focus()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '收起控制台' }))
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '收起控制台' }))
    host.focus()
    expect(document.activeElement).toBe(host)
  })

  it('temporarily isolates background branches and restores original inert attributes on close and unmount', () => {
    const props = overlayProps({ items: [approvalItem] })
    const { container, unmount } = render(<>
      <aside data-testid="prior-inert"><button>Previously inert</button></aside>
      <main data-testid="host"><button>Host control</button></main>
      <div data-testid="modal-owner"><InteractionOverlay {...props} /></div>
    </>)
    const prior = screen.getByTestId('prior-inert')
    const host = screen.getByTestId('host')
    const owner = screen.getByTestId('modal-owner')
    prior.setAttribute('inert', 'preserved')
    const outside = document.createElement('section')
    document.body.append(outside)
    try {
      openCockpit()
      expect(prior.hasAttribute('inert')).toBe(true)
      expect(host.hasAttribute('inert')).toBe(true)
      expect(outside.hasAttribute('inert')).toBe(true)
      expect(owner.hasAttribute('inert')).toBe(false)
      expect(container.hasAttribute('inert')).toBe(false)
      expect(screen.getByRole('dialog').closest('[inert]')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: '收起控制台' }))
      expect(prior.getAttribute('inert')).toBe('preserved')
      expect(host.hasAttribute('inert')).toBe(false)
      expect(outside.hasAttribute('inert')).toBe(false)
      expect(document.activeElement).toBe(screen.getByRole('button', { name: '任务控制台，1 项待办' }))
      openCockpit()
      expect(outside.hasAttribute('inert')).toBe(true)
      unmount()
      expect(outside.hasAttribute('inert')).toBe(false)
      expect(prior.getAttribute('inert')).toBe('preserved')
      expect(host.hasAttribute('inert')).toBe(false)
    } finally {
      outside.remove()
    }
  })

  it('handles Tab from the panel fallback and excludes disabled offline fields and hidden forms', () => {
    render(<InteractionOverlay {...overlayProps({ items: [questionItem] }, { connection: connection('disconnected') })} />)
    openPending()
    const panel = screen.getByRole('dialog')
    expect(panel.tabIndex).toBe(-1)
    panel.focus()
    fireEvent.keyDown(panel, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '收起控制台' }))
    panel.focus()
    fireEvent.keyDown(panel, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '稍后处理' }))
    fireEvent.click(screen.getByRole('button', { name: '返回待办列表' }))
    const close = screen.getByRole('button', { name: '收起控制台' })
    close.focus()
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Demo session/ }))
    expect(document.activeElement?.closest('[hidden]')).toBeNull()
    expect(document.activeElement?.matches(':disabled')).toBe(false)
  })
})
