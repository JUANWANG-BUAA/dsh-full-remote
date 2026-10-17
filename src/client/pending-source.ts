/**
 * pending-source — project live question/approval waits for the remote overlay.
 *
 * Official composers take over `conversation.composer`, which sits at the
 * bottom of the current session. On a phone that panel is easy to miss, and
 * waits on a session that is not current never appear at all. Harness 0.2
 * publishes pending interactions through the `uiSession` registry and exposes
 * the highest-precedence request per Session on `uiSession.sessionStatus`, so
 * this source turns that registry into the stable snapshot the overlay can
 * answer from — no session instantiation on this side.
 */
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PendingApproval } from '@deepseek-ai/dsh-client-ui-approval/client'
import type {
  SessionPendingInteraction, SessionStatusSnapshot, UiSession,
} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PendingQuestion } from '@deepseek-ai/dsh-client-ui-user-questions/client'
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

function questionView(wait: PendingQuestion): QuestionItemView[] {
  return wait.questions.map(question => ({
    id: question.id,
    question: question.question,
    ...(question.detail === undefined ? {} : { detail: question.detail }),
    ...(question.header === undefined ? {} : { header: question.header }),
    ...(question.options === undefined ? {} : {
      options: question.options.map((option) => ({
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

/**
 * Project one registry entry into the overlay view. Harness 0.2 only exposes
 * answerable interactions here (the old list-row hint is gone), so every
 * projected item is ready.
 */
function projectInteraction(
  interaction: SessionPendingInteraction,
  sessionTitle: string,
): RemotePendingItem {
  if (interaction.kind === 'approval') {
    const approval = interaction as PendingApproval
    return {
      key: approval.key,
      kind: 'approval',
      presentation: 'approval',
      sessionId: approval.sessionId,
      sessionTitle,
      ready: true,
      approval: {
        toolName: approval.toolName,
        ...(approval.reason === undefined ? {} : { reason: approval.reason }),
      },
    }
  }
  const question = interaction as PendingQuestion
  const questions = questionView(question)
  return {
    key: question.key,
    kind: 'question',
    presentation: planReviewOf(questions) === undefined ? 'question' : 'plan-review',
    sessionId: question.sessionId,
    sessionTitle,
    ready: true,
    questions,
  }
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
 * Subscribe to the Session list and the `uiSession` pending-interaction
 * registry. Titles come from the list snapshot; the interactions themselves
 * arrive answerable, published by their owning domain (questions,
 * approvals) — this source never instantiates a Session.
 */
export function createPendingSource(sessions: ISessions, uiSession: UiSession): PendingSource {
  const listeners = new Set<() => void>()
  const waits = new Map<string, SessionPendingInteraction>()
  let snapshot = EMPTY_STATE
  let disposed = false

  const notify = () => {
    for (const listener of listeners) listener()
  }

  const collect = () => {
    if (disposed) return
    const list = sessions.list.getSnapshot()
    const status: SessionStatusSnapshot = uiSession.sessionStatus.getSnapshot()
    const items: RemotePendingItem[] = []
    const nextWaits = new Map<string, SessionPendingInteraction>()

    for (const [sessionId, row] of status) {
      const interaction = row.pendingInteraction
      if (interaction === undefined) continue
      nextWaits.set(interaction.key, interaction)
      const title = list.byId[sessionId]?.displayTitle ?? String(sessionId)
      items.push(projectInteraction(interaction, title))
    }

    waits.clear()
    for (const [key, wait] of nextWaits) waits.set(key, wait)

    const next = items.length === 0 ? EMPTY_STATE : { items }
    if (fingerprint(next) === fingerprint(snapshot)) return
    snapshot = next
    notify()
  }

  const listUnsub = sessions.list.subscribe(collect)
  const statusUnsub = uiSession.sessionStatus.subscribe(collect)
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
      statusUnsub()
      waits.clear()
      listeners.clear()
      snapshot = EMPTY_STATE
    },
    answerApproval: async (key, outcome) => {
      const wait = waits.get(key)
      if (wait === undefined || wait.kind !== 'approval') {
        throw new Error('approval is no longer pending')
      }
      await (wait as PendingApproval).answer(outcome)
    },
    answerQuestion: async (key, answer) => {
      const wait = waits.get(key)
      if (wait === undefined || wait.kind === 'approval') {
        throw new Error('question is no longer pending')
      }
      await (wait as PendingQuestion).answer(answer)
    },
    cancelQuestion: async (key) => {
      const wait = waits.get(key)
      if (wait === undefined || wait.kind === 'approval') {
        throw new Error('question is no longer pending')
      }
      // 0.2 semantics: a tool-call-keyed card only leaves the composer seat
      // (the request stays answerable from its tool call row); an unnamed
      // card ends the request. Both are the official dismiss behavior.
      await (wait as PendingQuestion).dismiss()
    },
  }
}
