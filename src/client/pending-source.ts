/**
 * pending-source — project live question/approval waits for the remote overlay.
 *
 * Official composers take over `conversation.composer`, which sits at the
 * bottom of the current session. On a phone that panel is easy to miss, and
 * waits on a session that is not current never appear at all. This source
 * instantiates every listed session that has a pending interaction (via
 * `sessions.binding`, which replays buffered mux frames) and exposes a
 * stable snapshot the overlay can answer from.
 */
import type {
  ISessions,
  PendingInteraction,
  PendingWait,
  SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'
import { isLoopbackHost } from '../hosts.ts'

/** One option the asker offered. */
export type QuestionOptionView = {
  label: string
  description?: string
}

/** One question in a user-questions request, overlay-facing. */
export type QuestionItemView = {
  id: string
  question: string
  detail?: string
  header?: string
  options?: QuestionOptionView[]
  multiSelect?: boolean
  intent?: { kind: 'plan-review', approve: string }
}

/** Structured answer batch matching the official question wire encoding. */
export type QuestionAnswer = {
  answers: Array<{
    id: string
    selected: string[]
    custom?: string
  }>
}

/** Overlay-facing approval facts. */
export type ApprovalView = {
  toolName: string
  reason?: string
}

/** One pending host interaction the overlay can render or jump to. */
export type RemotePendingItem = {
  key: string
  kind: 'approval' | 'question'
  presentation: 'approval' | 'question' | 'plan-review'
  sessionId: string
  sessionTitle: string
  current: boolean
  ready: boolean
  approval?: ApprovalView
  questions?: QuestionItemView[]
}

/** Snapshot the overlay subscribes to. */
export type RemotePendingState = {
  items: RemotePendingItem[]
}

const EMPTY_STATE: RemotePendingState = { items: [] }

/**
 * Show the remote overlay when this browser is not the host loopback window,
 * or when the viewport is phone-narrow (adb reverse still looks like 127.0.0.1).
 */
export function shouldUseInteractionOverlay(
  hostname = typeof location === 'undefined' ? '127.0.0.1' : location.hostname,
  width = typeof window === 'undefined' ? 1024 : window.innerWidth,
) {
  return !isLoopbackHost(hostname) || width <= 720
}

/**
 * Narrow a question batch to a binary plan review, or undefined for the generic flow.
 */
export function planReviewOf(questions: readonly QuestionItemView[]): {
  id: string
  question: string
  plan: string
  approve: string
  decline?: string
} | undefined {
  if (questions.length !== 1) return undefined
  const question = questions[0]
  if (question === undefined) return undefined
  const intent = question.intent
  if (intent?.kind !== 'plan-review' || question.detail === undefined) return undefined
  if (question.multiSelect === true) return undefined
  const options = question.options ?? []
  if (options.length > 2) return undefined
  const approve = options.find(option => option.label === intent.approve)
  if (approve === undefined) return undefined
  const decline = options.find(option => option.label !== intent.approve)
  return {
    id: question.id,
    question: question.question,
    plan: question.detail,
    approve: approve.label,
    ...(decline === undefined ? {} : { decline: decline.label }),
  }
}

/**
 * Split a conventional "(recommended)" suffix without changing the answer value.
 */
export function parseRecommendedLabel(label: string): { label: string, recommended: boolean } {
  const suffix = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i
  return suffix.test(label)
    ? { label: label.replace(suffix, ''), recommended: true }
    : { label, recommended: false }
}

function fingerprint(state: RemotePendingState) {
  return state.items.map(item => {
    const q = item.questions?.map(question => JSON.stringify(question)).join(',') ?? ''
    const approval = item.approval === undefined ? '' : JSON.stringify(item.approval)
    return `${item.key}:${item.ready}:${item.presentation}:${q}:${approval}`
  }).join('|')
}

function questionView(wait: PendingWait<'question'>): QuestionItemView[] {
  const questions = wait.payload.questions
  return questions.map((question: QuestionItemView) => ({
    id: question.id,
    question: question.question,
    ...(question.detail === undefined ? {} : { detail: question.detail }),
    ...(question.header === undefined ? {} : { header: question.header }),
    ...(question.options === undefined ? {} : {
      options: question.options.map((option: QuestionOptionView) => ({
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      })),
    }),
    ...(question.multiSelect === true ? { multiSelect: true } : {}),
    ...(question.intent?.kind === 'plan-review'
      ? { intent: { kind: 'plan-review' as const, approve: question.intent.approve } }
      : {}),
  }))
}

function projectWait(
  wait: PendingInteraction,
  sessionTitle: string,
  current: boolean,
): RemotePendingItem {
  if (wait.kind === 'question') {
    const questions = questionView(wait as PendingWait<'question'>)
    return {
      key: wait.key,
      kind: 'question',
      presentation: planReviewOf(questions) === undefined ? 'question' : 'plan-review',
      sessionId: wait.sessionId,
      sessionTitle,
      current,
      ready: true,
      questions,
    }
  }
  const approval = wait as PendingWait<'approval'>
  return {
    key: approval.key,
    kind: 'approval',
    presentation: 'approval',
    sessionId: approval.sessionId,
    sessionTitle,
    current,
    ready: true,
    approval: {
      toolName: approval.payload.toolName,
      ...(approval.payload.reason === undefined ? {} : { reason: approval.payload.reason }),
    },
  }
}

function receiptError(receipt: { accepted: boolean, reason?: string }, action: string) {
  if (receipt.accepted) return
  throw new Error(`${action} rejected: ${receipt.reason ?? 'unknown'}`)
}

/** Live pending-interaction source the overlay hook binds to. */
export type PendingSource = {
  getSnapshot: () => RemotePendingState
  subscribe: (fn: () => void) => () => void
  dispose: () => void
  answerApproval: (key: string, outcome: 'allowed-once' | 'rejected') => Promise<void>
  answerQuestion: (key: string, answer: QuestionAnswer) => Promise<void>
  cancelQuestion: (key: string) => Promise<void>
}

/**
 * Subscribe to the session list and every pending session's conversation
 * snapshot. `binding()` instantiates the session so buffered question/approval
 * frames become answerable waits without changing the current selection.
 */
export function createPendingSource(sessions: ISessions): PendingSource {
  const listeners = new Set<() => void>()
  const sessionUnsubs = new Map<SessionId, () => void>()
  const waits = new Map<string, PendingInteraction>()
  let snapshot = EMPTY_STATE
  let disposed = false

  const notify = () => {
    for (const listener of listeners) listener()
  }

  const collect = () => {
    if (disposed) return
    const list = sessions.list.getSnapshot()
    const items: RemotePendingItem[] = []
    const nextWaits = new Map<string, PendingInteraction>()
    const pendingIds = new Set<SessionId>()

    for (const id of list.ids) {
      const row = list.byId[id]
      if (row?.pendingInteraction === undefined) continue
      pendingIds.add(id)
      const binding = sessions.binding(id)
      const pending = binding?.session.getSnapshot().pending ?? []
      if (pending.length === 0) {
        items.push({
          key: `hint:${id}`,
          kind: row.pendingInteraction === 'approval' ? 'approval' : 'question',
          presentation: row.pendingInteraction,
          sessionId: id,
          sessionTitle: row.displayTitle,
          current: list.current === id,
          ready: false,
        })
        continue
      }
      for (const wait of pending) {
        nextWaits.set(wait.key, wait)
        items.push(projectWait(wait, row.displayTitle, list.current === id))
      }
    }

    waits.clear()
    for (const [key, wait] of nextWaits) waits.set(key, wait)

    for (const [id, unsub] of sessionUnsubs) {
      if (pendingIds.has(id)) continue
      unsub()
      sessionUnsubs.delete(id)
    }
    for (const id of pendingIds) {
      if (sessionUnsubs.has(id)) continue
      const binding = sessions.binding(id)
      if (binding === undefined) continue
      sessionUnsubs.set(id, binding.session.subscribe(collect))
    }

    const next = items.length === 0 ? EMPTY_STATE : { items }
    if (fingerprint(next) === fingerprint(snapshot)) return
    snapshot = next
    notify()
  }

  const listUnsub = sessions.list.subscribe(collect)
  collect()

  return {
    getSnapshot: () => snapshot,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    dispose: () => {
      disposed = true
      listUnsub()
      for (const unsub of sessionUnsubs.values()) unsub()
      sessionUnsubs.clear()
      waits.clear()
      listeners.clear()
      snapshot = EMPTY_STATE
    },
    answerApproval: async (key, outcome) => {
      const wait = waits.get(key)
      if (wait === undefined || wait.kind !== 'approval') {
        throw new Error('approval is no longer pending')
      }
      const receipt = await wait.respond({
        ok: true,
        value: {
          sessionId: wait.sessionId,
          approvalId: wait.payload.approvalId,
          outcome,
        },
      })
      receiptError(receipt, 'approval')
    },
    answerQuestion: async (key, answer) => {
      const wait = waits.get(key)
      if (wait === undefined || wait.kind !== 'question') {
        throw new Error('question is no longer pending')
      }
      const receipt = await wait.respond({
        ok: true,
        value: { sessionId: wait.sessionId, answer },
      })
      receiptError(receipt, 'question')
    },
    cancelQuestion: async (key) => {
      const wait = waits.get(key)
      if (wait === undefined || wait.kind !== 'question') {
        throw new Error('question is no longer pending')
      }
      const receipt = await wait.respond({
        ok: false,
        error: {
          code: 'cancelled',
          message: 'the user closed this question request',
          details: {},
        },
      })
      receiptError(receipt, 'question cancel')
    },
  }
}
