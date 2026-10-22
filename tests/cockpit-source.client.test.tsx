import type { ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PendingApproval } from '@deepseek-ai/dsh-client-ui-approval/client'
import type { SessionStatus, SessionStatusSnapshot, UiSession } from '@deepseek-ai/dsh-client-ui-session/client'
import type { PendingQuestion } from '@deepseek-ai/dsh-client-ui-user-questions/client'
import { describe, expect, it, vi } from 'vitest'
import { createPendingSource, type RemotePendingState } from '../src/client/pending-source.ts'

type SessionId = SessionListState['ids'][number]
const id = (value: string) => value as SessionId

function store<T>(initial: T) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  const unsubscribe = vi.fn()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener); unsubscribe() }
    },
    set: (value: T, notify = true) => {
      snapshot = value
      if (notify) for (const listener of listeners) listener()
    },
    unsubscribe,
  }
}

function list(rows: Array<[string, string, boolean]> = [], phase: SessionListState['phase'] = 'ready'): SessionListState {
  return {
    ids: rows.map(([key]) => id(key)),
    byId: Object.fromEntries(rows.map(([key, displayTitle, running]) => [key, {
      id: id(key), displayTitle, running, retainedBy: {}, blank: false, updatedAt: 0,
    }])),
    phase,
    projectionsBySession: {},
  }
}

type InteractionFixture =
  | Pick<PendingApproval, 'kind' | 'key' | 'sessionId' | 'toolName' | 'answer'>
  | Pick<PendingQuestion, 'kind' | 'key' | 'sessionId' | 'questions' | 'answer' | 'dismiss'>

function status(facts: Omit<Partial<SessionStatus>, 'pendingInteraction'> & {
  pendingInteraction?: InteractionFixture
} = {}): SessionStatus {
  // Private domain state is intentionally outside this projection-level test double.
  return { running: undefined, pendingInteraction: undefined, completionUnread: false, ...facts } as SessionStatus
}

function approval(key = 'a:1', sessionId = 's1') {
  // Domain classes have private state; mock only the public projection/action boundary.
  return {
    kind: 'approval' as const, key, sessionId: id(sessionId), toolName: 'bash',
    answer: vi.fn<PendingApproval['answer']>().mockResolvedValue(undefined),
  }
}

function question(key = 'q:1') {
  return {
    kind: 'question' as const, key, sessionId: id('s1'),
    questions: [{ id: 'q', question: 'Continue?', options: [{ label: 'Yes' }] }],
    answer: vi.fn<PendingQuestion['answer']>().mockResolvedValue(undefined),
    dismiss: vi.fn<PendingQuestion['dismiss']>().mockResolvedValue(undefined),
  }
}

function harness(initialList = list(), initialStatus: SessionStatusSnapshot = new Map()) {
  const catalog = store(initialList)
  const statuses = store(initialStatus)
  const sessions = { list: catalog } as unknown as ISessions
  const uiSession = { sessionStatus: statuses } as unknown as UiSession
  return { catalog, statuses, source: createPendingSource(sessions, uiSession) }
}

const answer = { answers: [{ id: 'q', selected: ['Yes'] }] }

describe('cockpit source projection', () => {
  it('keeps the old empty fixture valid and distinguishes pending from ready arrival', () => {
    const fixture: RemotePendingState = { items: [] }
    expect(fixture.sessions).toBeUndefined()
    const { source, catalog } = harness(list([], 'pending'))
    const notify = vi.fn()
    source.subscribe(notify)
    expect(source.getSnapshot()).toEqual({ items: [], sessions: [], phase: 'pending' })
    catalog.set(list())
    expect(source.getSnapshot()).toEqual({ items: [], sessions: [], phase: 'ready' })
    expect(notify).toHaveBeenCalledTimes(1)
    source.dispose()
  })

  it('includes running sessions without pending and follows ids rather than byId or Map order', () => {
    const initial = list([['s2', 'Second', true], ['s1', 'First', false]])
    initial.byId[id('retained')] = list([['retained', 'Not catalogued', true]]).byId[id('retained')]!
    const { source } = harness(initial, new Map([
      [id('s1'), status({ running: false })],
      [id('s2'), status({ running: true })],
      [id('retained'), status({ running: true })],
    ]))
    expect(source.getSnapshot().items).toEqual([])
    expect(source.getSnapshot().sessions).toEqual([
      { id: 's2', title: 'Second', running: true, completionUnread: false },
      { id: 's1', title: 'First', running: false, completionUnread: false },
    ])
    source.dispose()
  })

  it('falls back to catalog running only when status is unknown, without inferring completion', () => {
    const { source } = harness(list([['s1', 'First', true]]), new Map([
      [id('s1'), status()],
      [id('unknown'), status({ pendingInteraction: approval('a:unknown', 'unknown') })],
    ]))
    expect(source.getSnapshot().sessions).toEqual([
      { id: 's1', title: 'First', running: true, completionUnread: false },
      { id: 'unknown', title: 'unknown', running: undefined, completionUnread: false, pendingKey: 'a:unknown' },
    ])
    source.dispose()
  })

  it('orders pending items by catalog ids and appends off-list pending once', () => {
    const a1 = approval('a:1', 's1')
    const a2 = approval('a:2', 's2')
    const off = approval('a:off', 'off')
    const { source } = harness(list([['s2', 'Second', true], ['s1', 'First', true]]), new Map([
      [id('off'), status({ pendingInteraction: off })],
      [id('s1'), status({ pendingInteraction: a1 })],
      [id('s2'), status({ pendingInteraction: a2 })],
    ]))
    expect(source.getSnapshot().items.map(item => item.key)).toEqual(['a:2', 'a:1', 'a:off'])
    expect(source.getSnapshot().sessions?.map(row => row.id)).toEqual(['s2', 's1', 'off'])
    expect(source.getSnapshot().sessions?.[2]).toMatchObject({ title: 'off', pendingKey: 'a:off' })
    source.dispose()
  })

  it('notifies for titles with and without pending while identical projections retain snapshot identity', () => {
    const pending = approval()
    const { source, catalog } = harness(list([['s1', 'Before', true], ['s2', 'Other', false]]), new Map([
      [id('s1'), status({ pendingInteraction: pending })],
    ]))
    const notify = vi.fn()
    source.subscribe(notify)
    const before = source.getSnapshot()
    source.refresh()
    expect(source.getSnapshot()).toBe(before)
    expect(notify).not.toHaveBeenCalled()
    catalog.set(list([['s1', 'After', true], ['s2', 'Other', false]]))
    expect(source.getSnapshot().items[0]?.sessionTitle).toBe('After')
    catalog.set(list([['s1', 'After', true], ['s2', 'Renamed', false]]))
    expect(source.getSnapshot().sessions?.[1]?.title).toBe('Renamed')
    expect(notify).toHaveBeenCalledTimes(2)
    source.dispose()
  })

  it('notifies for independent running and unread changes and preserves explicit false', () => {
    const { source, statuses } = harness(list([['s1', 'First', true]]))
    const notify = vi.fn()
    source.subscribe(notify)
    statuses.set(new Map([[id('s1'), status({ running: false, completionUnread: false })]]))
    expect(source.getSnapshot().sessions?.[0]?.running).toBe(false)
    statuses.set(new Map([[id('s1'), status({ running: false, completionUnread: true })]]))
    expect(source.getSnapshot().sessions?.[0]?.completionUnread).toBe(true)
    statuses.set(new Map([[id('s1'), status({ running: false, completionUnread: false })]]))
    expect(notify).toHaveBeenCalledTimes(3)
    source.dispose()
  })

  it('includes sessionId in pending fingerprints even when the key and presentation stay equal', () => {
    const pending = approval('same', 'before')
    const { source, statuses } = harness(list(), new Map([
      [id('slot'), status({ pendingInteraction: pending })],
    ]))
    const notify = vi.fn()
    source.subscribe(notify)
    statuses.set(new Map([[id('slot'), status({
      pendingInteraction: { ...pending, sessionId: id('after') },
    })]]))
    expect(source.getSnapshot().items[0]?.sessionId).toBe('after')
    expect(notify).toHaveBeenCalledTimes(1)
    source.dispose()
  })

  it('removes catalog members and withdrawn off-list pending, ignoring retained non-pending status', () => {
    const pending = approval('a:off', 'off')
    const { source, catalog, statuses } = harness(list([['s1', 'First', false]]), new Map([
      [id('off'), status({ pendingInteraction: pending })],
    ]))
    catalog.set(list())
    expect(source.getSnapshot().sessions?.map(row => row.id)).toEqual(['off'])
    statuses.set(new Map([[id('off'), status({ running: false, completionUnread: true })]]))
    expect(source.getSnapshot()).toEqual({ items: [], sessions: [], phase: 'ready' })
    source.dispose()
  })

  it('refreshes local snapshots without notification delivery or remote calls', () => {
    const { source, catalog } = harness(list())
    const notify = vi.fn()
    source.subscribe(notify)
    catalog.set(list([['new', 'New', true]]), false)
    expect(source.getSnapshot().sessions).toEqual([])
    expect(source.refresh()).toBeUndefined()
    expect(source.getSnapshot().sessions?.[0]?.id).toBe('new')
    expect(notify).toHaveBeenCalledTimes(1)
    source.dispose()
  })

  it.each(['approval', 'answer', 'dismiss'] as const)('rejects stale %s keys before dispatch, without replaying the replacement', async (action) => {
    const oldApproval = approval()
    const oldQuestion = question()
    const old = action === 'approval' ? oldApproval : oldQuestion
    const replacement = action === 'approval' ? approval('new') : question('new')
    const { source, statuses } = harness(list([['s1', 'First', true]]), new Map([
      [id('s1'), status({ pendingInteraction: old })],
    ]))
    // Simulate another device consuming the old key before this subscriber runs.
    statuses.set(new Map([[id('s1'), status({ pendingInteraction: replacement })]]), false)
    const operation = action === 'approval' ? source.answerApproval(old.key, 'allowed-once')
      : action === 'answer' ? source.answerQuestion(old.key, answer) : source.cancelQuestion(old.key)
    await expect(operation).rejects.toThrow('no longer pending')
    expect(old.answer).not.toHaveBeenCalled()
    expect(replacement.answer).not.toHaveBeenCalled()
    expect(oldQuestion.dismiss).not.toHaveBeenCalled()
    expect(source.getSnapshot().items[0]?.key).toBe('new')
    source.dispose()
  })

  it('rejects a withdrawn question before delivery even without a subscriber event', async () => {
    const pending = question()
    const { source, statuses } = harness(list(), new Map([
      [id('s1'), status({ pendingInteraction: pending })],
    ]))
    statuses.set(new Map(), false)
    await expect(source.answerQuestion(pending.key, answer)).rejects.toThrow('no longer pending')
    expect(pending.answer).not.toHaveBeenCalled()
    expect(source.getSnapshot().items).toEqual([])
    source.dispose()
  })

  it('recollects current callback identity and propagates domain failure once, never retrying', async () => {
    const old = question()
    const current = question()
    current.answer.mockRejectedValue(new Error('answered elsewhere'))
    const { source, statuses } = harness(list(), new Map([
      [id('s1'), status({ pendingInteraction: old })],
    ]))
    statuses.set(new Map([[id('s1'), status({ pendingInteraction: current })]]), false)
    await expect(source.answerQuestion(current.key, answer)).rejects.toThrow('answered elsewhere')
    expect(current.answer).toHaveBeenCalledTimes(1)
    expect(old.answer).not.toHaveBeenCalled()
    source.refresh()
    expect(current.answer).toHaveBeenCalledTimes(1)
    source.dispose()
  })

  it('preserves published approval, question answer and dismiss behavior', async () => {
    const a = approval()
    const q = question()
    const { source, statuses } = harness(list(), new Map([
      [id('s1'), status({ pendingInteraction: a })],
    ]))
    await source.answerApproval(a.key, 'allowed-once')
    expect(a.answer).toHaveBeenCalledWith('allowed-once')
    statuses.set(new Map([[id('s1'), status({ pendingInteraction: q })]]))
    await source.answerQuestion(q.key, answer)
    await source.cancelQuestion(q.key)
    expect(q.answer).toHaveBeenCalledWith(answer)
    expect(q.dismiss).toHaveBeenCalledTimes(1)
    source.dispose()
  })

  it('unsubscribes idempotently, stays inert after disposal and rejects actions', async () => {
    const pending = question()
    const { source, catalog, statuses } = harness(list(), new Map([
      [id('s1'), status({ pendingInteraction: pending })],
    ]))
    const notify = vi.fn()
    const unsubscribe = source.subscribe(notify)
    source.dispose()
    source.dispose()
    unsubscribe()
    source.subscribe(notify)
    catalog.set(list([['s1', 'Changed', true]]))
    statuses.set(new Map())
    source.refresh()
    expect(catalog.unsubscribe).toHaveBeenCalledTimes(1)
    expect(statuses.unsubscribe).toHaveBeenCalledTimes(1)
    expect(notify).not.toHaveBeenCalled()
    expect(source.getSnapshot()).toEqual({ items: [] })
    await expect(source.answerQuestion(pending.key, answer)).rejects.toThrow('no longer pending')
    await expect(source.cancelQuestion(pending.key)).rejects.toThrow('no longer pending')
    await expect(source.answerApproval('a:1', 'rejected')).rejects.toThrow('no longer pending')
    expect(pending.answer).not.toHaveBeenCalled()
    expect(pending.dismiss).not.toHaveBeenCalled()
  })
})
