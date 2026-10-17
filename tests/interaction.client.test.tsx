import type { Context } from '@deepseek-ai/cordis'
import type { ComponentProps } from 'react'
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

function overlayProps(
  state: RemotePendingState,
  overrides: Partial<ComponentProps<typeof InteractionOverlay>> = {},
): ComponentProps<typeof InteractionOverlay> {
  return {
    t,
    enabled: true,
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
  it('renders nothing when disabled or empty', () => {
    const { container: empty } = render(<InteractionOverlay {...overlayProps({ items: [] })} />)
    expect(empty.querySelector('[data-remote-interact]')).toBeNull()
    const { container: off } = render(<InteractionOverlay {...overlayProps(
      { items: [approvalItem] },
      { enabled: false },
    )} />)
    expect(off.querySelector('[data-remote-interact]')).toBeNull()
  })

  it('lets a remote user allow or reject an approval', async () => {
    const answerApproval = vi.fn().mockResolvedValue(undefined)
    render(<InteractionOverlay {...overlayProps({ items: [approvalItem] }, { answerApproval })} />)
    expect(screen.getByRole('dialog', { name: '等待批准' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '允许一次' }))
    await waitFor(() => {
      expect(answerApproval).toHaveBeenCalledWith('a:1', 'allowed-once')
    })
  })

  it('submits a selected question option', async () => {
    const answerQuestion = vi.fn<(key: string, answer: QuestionAnswer) => Promise<void>>()
      .mockResolvedValue(undefined)
    render(<InteractionOverlay {...overlayProps({ items: [questionItem] }, { answerQuestion })} />)
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
    expect(screen.getByRole('button', { name: '允许一次' })).toBeTruthy()
    act(() => { binding.language.setPreference('en') })
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy()
  } finally {
    binding.dispose()
    localStorage.clear()
  }
})
