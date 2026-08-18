/**
 * InteractionOverlay — mobile/remote confirmation sheet.
 *
 * Official question/approval UIs take over the conversation composer, which
 * only exists for the current session and is easy to miss on a phone. This
 * entry rides `shell.overlay` so a remote browser can always see and answer
 * pending host interactions.
 */
import { useEffect, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReverseProxyTranslate } from './i18n.ts'
import {
  parseRecommendedLabel,
  planReviewOf,
  shouldUseInteractionOverlay,
  type QuestionAnswer,
  type QuestionItemView,
  type RemotePendingItem,
  type RemotePendingState,
} from './pending-source.ts'
import css from './interaction.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'shell.overlay': { kind: 'list', scope: 'root' }
  }
}

/** Injected face: translate, answer callbacks, optional test override. */
export type InteractionOverlayInjected = {
  t: ReverseProxyTranslate
  /** Test seam; omit in production so the overlay follows hostname/viewport. */
  enabled?: boolean
  openSession: (sessionId: string) => void
  answerApproval: (key: string, outcome: 'allowed-once' | 'rejected') => Promise<void>
  answerQuestion: (key: string, answer: QuestionAnswer) => Promise<void>
  cancelQuestion: (key: string) => Promise<void>
  hooks: {
    remotePending: {
      getSnapshot: () => RemotePendingState
      subscribe: (fn: () => void) => () => void
    }
  }
}

export type InteractionOverlayProps =
  & PropsRuntime<'shell.overlay'>
  & InjectFace<InteractionOverlayInjected>

type DraftAnswer = {
  selected: string[]
  custom: string
  skipped: boolean
}

function isComposing(event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) {
  return event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
}

function emptyDrafts(questions: readonly QuestionItemView[]): DraftAnswer[] {
  return questions.map(() => ({ selected: [], custom: '', skipped: false }))
}

/**
 * Frame-wide confirmation sheet. Renders nothing on the host desktop window
 * unless the viewport is phone-narrow, so it does not stack on the official
 * composer there.
 */
export function InteractionOverlay({
  t,
  enabled,
  openSession,
  answerApproval,
  answerQuestion,
  cancelQuestion,
  useRemotePending,
}: InteractionOverlayProps) {
  const [autoEnabled, setAutoEnabled] = useState(() => enabled ?? shouldUseInteractionOverlay())
  useEffect(() => {
    if (enabled !== undefined) {
      setAutoEnabled(enabled)
      return
    }
    const sync = () => { setAutoEnabled(shouldUseInteractionOverlay()) }
    sync()
    window.addEventListener('resize', sync)
    return () => { window.removeEventListener('resize', sync) }
  }, [enabled])

  const items = useRemotePending(state => state.items)
  const show = enabled ?? autoEnabled
  const item = items[0]
  if (!show || item === undefined) return null

  const remaining = items.length
  return (
    <div className={css.layer} data-remote-interact={item.presentation}>
      <div className={css.backdrop} />
      <div
        className={css.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dsh-remote-interact-title"
      >
        <div className={css.handle} aria-hidden="true" />
        {remaining > 1 && (
          <p className={css.queue}>{t('interact.queue', { count: remaining })}</p>
        )}
        <InteractBody
          item={item}
          t={t}
          openSession={openSession}
          answerApproval={answerApproval}
          answerQuestion={answerQuestion}
          cancelQuestion={cancelQuestion}
        />
      </div>
    </div>
  )
}

function InteractBody(props: {
  item: RemotePendingItem
  t: ReverseProxyTranslate
  openSession: (sessionId: string) => void
  answerApproval: (key: string, outcome: 'allowed-once' | 'rejected') => Promise<void>
  answerQuestion: (key: string, answer: QuestionAnswer) => Promise<void>
  cancelQuestion: (key: string) => Promise<void>
}) {
  const { item, t } = props
  if (!item.ready) {
    return (
      <section className={css.card}>
        <header className={css.header}>
          <span className={css.badge}>{t(item.kind === 'approval' ? 'interact.kind.approval' : 'interact.kind.question')}</span>
          <h2 className={css.title} id="dsh-remote-interact-title">{t('interact.open.title')}</h2>
        </header>
        <p className={css.session}>{item.sessionTitle}</p>
        <p className={css.lede}>{t('interact.open.hint')}</p>
        <div className={css.actions}>
          <button
            className={css.primary}
            type="button"
            onClick={() => { props.openSession(item.sessionId) }}
          >
            {t('interact.open.action')}
          </button>
        </div>
      </section>
    )
  }
  if (item.kind === 'approval' && item.approval !== undefined) {
    return (
      <ApprovalFlow
        key={item.key}
        itemKey={item.key}
        sessionTitle={item.sessionTitle}
        toolName={item.approval.toolName}
        reason={item.approval.reason}
        t={t}
        onAnswer={props.answerApproval}
      />
    )
  }
  const questions = item.questions ?? []
  const review = planReviewOf(questions)
  if (review !== undefined) {
    return (
      <PlanReviewFlow
        key={item.key}
        itemKey={item.key}
        sessionTitle={item.sessionTitle}
        review={review}
        t={t}
        onAnswer={props.answerQuestion}
        onCancel={props.cancelQuestion}
      />
    )
  }
  return (
    <QuestionFlow
      key={item.key}
      itemKey={item.key}
      sessionTitle={item.sessionTitle}
      questions={questions}
      t={t}
      onAnswer={props.answerQuestion}
      onCancel={props.cancelQuestion}
    />
  )
}

function ApprovalFlow(props: {
  itemKey: string
  sessionTitle: string
  toolName: string
  reason?: string
  t: ReverseProxyTranslate
  onAnswer: (key: string, outcome: 'allowed-once' | 'rejected') => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const answer = (outcome: 'allowed-once' | 'rejected') => {
    setBusy(true)
    setError(undefined)
    void props.onAnswer(props.itemKey, outcome).catch((cause: unknown) => {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }
  return (
    <section className={css.card}>
      <header className={css.header}>
        <span className={css.badge}>{props.t('interact.kind.approval')}</span>
        <h2 className={css.title} id="dsh-remote-interact-title">{props.t('interact.approval.title')}</h2>
      </header>
      <p className={css.session}>{props.sessionTitle}</p>
      <div className={css.body}>
        <p className={css.lede}>{props.reason ?? props.t('interact.approval.fallback', { tool: props.toolName })}</p>
        <p className={css.meta}>{props.t('interact.approval.tool', { tool: props.toolName })}</p>
      </div>
      {error !== undefined && <p className={css.error} role="alert">{error}</p>}
      <div className={css.actions}>
        <button className={css.danger} type="button" disabled={busy} onClick={() => { answer('rejected') }}>
          {props.t('interact.approval.reject')}
        </button>
        <button className={css.primary} type="button" disabled={busy} onClick={() => { answer('allowed-once') }}>
          {busy ? props.t('interact.busy') : props.t('interact.approval.allow')}
        </button>
      </div>
    </section>
  )
}

function PlanReviewFlow(props: {
  itemKey: string
  sessionTitle: string
  review: { id: string, question: string, plan: string, approve: string, decline?: string }
  t: ReverseProxyTranslate
  onAnswer: (key: string, answer: QuestionAnswer) => Promise<void>
  onCancel: (key: string) => Promise<void>
}) {
  const [busy, setBusy] = useState<'answer' | 'cancel'>()
  const [error, setError] = useState<string>()
  const send = (label: string) => {
    setBusy('answer')
    setError(undefined)
    void props.onAnswer(props.itemKey, {
      answers: [{ id: props.review.id, selected: [label] }],
    }).catch((cause: unknown) => {
      setBusy(undefined)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }
  const cancel = () => {
    setBusy('cancel')
    setError(undefined)
    void props.onCancel(props.itemKey).catch((cause: unknown) => {
      setBusy(undefined)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }
  return (
    <section className={css.card}>
      <header className={css.header}>
        <span className={css.badge}>{props.t('interact.kind.plan')}</span>
        <h2 className={css.title} id="dsh-remote-interact-title">{props.review.question}</h2>
        <button
          className={css.icon}
          type="button"
          aria-label={props.t('interact.question.cancel')}
          disabled={busy !== undefined}
          onClick={cancel}
        >×</button>
      </header>
      <p className={css.session}>{props.sessionTitle}</p>
      <div className={css.body}>
        <pre className={css.plan}>{props.review.plan}</pre>
      </div>
      {error !== undefined && <p className={css.error} role="alert">{error}</p>}
      <div className={css.actions}>
        {props.review.decline !== undefined && (
          <button
            className={css.secondary}
            type="button"
            disabled={busy !== undefined}
            onClick={() => {
              const decline = props.review.decline
              if (decline !== undefined) send(decline)
            }}
          >
            {props.t('interact.plan.decline')}
          </button>
        )}
        <button
          className={css.primary}
          type="button"
          disabled={busy !== undefined}
          onClick={() => { send(props.review.approve) }}
        >
          {busy === 'answer' ? props.t('interact.busy') : props.t('interact.plan.approve')}
        </button>
      </div>
    </section>
  )
}

function QuestionFlow(props: {
  itemKey: string
  sessionTitle: string
  questions: QuestionItemView[]
  t: ReverseProxyTranslate
  onAnswer: (key: string, answer: QuestionAnswer) => Promise<void>
  onCancel: (key: string) => Promise<void>
}) {
  const questions = props.questions
  const [index, setIndex] = useState(0)
  const [drafts, setDrafts] = useState(() => emptyDrafts(questions))
  const [busy, setBusy] = useState<'answer' | 'cancel'>()
  const [error, setError] = useState<string>()
  const question = questions[index] ?? questions[0]
  const draft = drafts[index] ?? drafts[0]
  if (question === undefined || draft === undefined) return null
  const hasOptions = (question.options?.length ?? 0) > 0

  const updateDraft = (next: (current: DraftAnswer) => DraftAnswer) => {
    setDrafts(current => current.map((item, itemIndex) => itemIndex === index ? next(item) : item))
    setError(undefined)
  }

  const choose = (label: string) => {
    updateDraft((current) => {
      if (question.multiSelect === true) {
        const selected = current.selected.includes(label)
          ? current.selected.filter(item => item !== label)
          : [...current.selected, label]
        return { ...current, selected, skipped: false }
      }
      return { selected: [label], custom: '', skipped: false }
    })
    if (question.multiSelect !== true && index < questions.length - 1) {
      setIndex(current => current + 1)
    }
  }

  const answered = (item: DraftAnswer) => item.selected.length > 0 || item.custom.trim() !== ''
  const completed = (item: DraftAnswer) => answered(item) || item.skipped

  const submitDrafts = (values: DraftAnswer[]) => {
    const missing = values.findIndex(item => !completed(item))
    if (missing >= 0) {
      setIndex(missing)
      setError(props.t('interact.question.incomplete'))
      return
    }
    const answer: QuestionAnswer = {
      answers: questions.map((item, itemIndex) => {
        const value = values[itemIndex] ?? { selected: [], custom: '', skipped: true }
        if (value.skipped) return { id: item.id, selected: [] }
        const custom = value.custom.trim()
        return {
          id: item.id,
          selected: custom === '' || item.multiSelect === true ? value.selected : [],
          ...(custom === '' ? {} : { custom }),
        }
      }),
    }
    setBusy('answer')
    setError(undefined)
    void props.onAnswer(props.itemKey, answer).catch((cause: unknown) => {
      setBusy(undefined)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  const continueFlow = () => {
    if (!answered(draft)) {
      setError(props.t('interact.question.unanswered'))
      return
    }
    if (index < questions.length - 1) {
      setIndex(current => current + 1)
      setError(undefined)
      return
    }
    submitDrafts(drafts)
  }

  const draftCustom = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const value = event.target.value
    updateDraft(current => ({
      ...current,
      selected: question.multiSelect === true ? current.selected : [],
      custom: value,
      skipped: false,
    }))
  }

  const continueFromCustom = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || isComposing(event)) return
    event.preventDefault()
    continueFlow()
  }

  const skipQuestion = () => {
    const nextDrafts = drafts.map((item, itemIndex) => itemIndex === index
      ? { selected: [], custom: '', skipped: true }
      : item)
    setDrafts(nextDrafts)
    setError(undefined)
    if (index < questions.length - 1) {
      setIndex(current => current + 1)
      return
    }
    submitDrafts(nextDrafts)
  }

  const cancel = () => {
    setBusy('cancel')
    setError(undefined)
    void props.onCancel(props.itemKey).catch((cause: unknown) => {
      setBusy(undefined)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  return (
    <section className={css.card}>
      <header className={css.header}>
        <span className={css.badge}>{props.t('interact.kind.question')}</span>
        <div className={css.heading}>
          {question.header !== undefined && <p className={css.eyebrow}>{question.header}</p>}
          <h2 className={css.title} id="dsh-remote-interact-title">{question.question}</h2>
        </div>
        <button
          className={css.icon}
          type="button"
          aria-label={props.t('interact.question.cancel')}
          disabled={busy !== undefined}
          onClick={cancel}
        >×</button>
      </header>
      <p className={css.session}>{props.sessionTitle}</p>
      <div className={css.body}>
        {question.detail !== undefined && <p className={css.detail}>{question.detail}</p>}
        <div className={css.options} role={question.multiSelect === true ? 'group' : 'radiogroup'}>
          {(question.options ?? []).map((option, optionIndex) => {
            const selected = draft.selected.includes(option.label)
            const display = parseRecommendedLabel(option.label)
            return (
              <button
                key={`${option.label}-${String(optionIndex)}`}
                className={selected ? `${css.option} ${css.optionOn}` : css.option}
                type="button"
                role={question.multiSelect === true ? 'checkbox' : 'radio'}
                aria-checked={selected}
                aria-label={display.label}
                disabled={busy !== undefined}
                onClick={() => { choose(option.label) }}
              >
                <span className={css.optionMark} aria-hidden="true">
                  {question.multiSelect === true ? (selected ? '✓' : '') : String(optionIndex + 1)}
                </span>
                <span className={css.optionCopy}>
                  <span className={css.optionLabel}>{display.label}</span>
                  {display.recommended && (
                    <span className={css.recommend} aria-hidden="true">
                      {props.t('interact.question.recommended')}
                    </span>
                  )}
                  {option.description !== undefined && (
                    <span className={css.optionHint}>{option.description}</span>
                  )}
                </span>
              </button>
            )
          })}
          {hasOptions ? (
            <label className={draft.custom !== '' ? `${css.customRow} ${css.customOn}` : css.customRow}>
              <span className={css.optionMark} aria-hidden="true">{hasOptions ? '+' : ''}</span>
              <input
                className={css.customInput}
                type="text"
                value={draft.custom}
                disabled={busy !== undefined}
                placeholder={props.t('interact.question.custom')}
                onChange={draftCustom}
                onKeyDown={continueFromCustom}
              />
            </label>
          ) : (
            <textarea
              className={css.customTextarea}
              value={draft.custom}
              disabled={busy !== undefined}
              rows={3}
              placeholder={props.t('interact.question.custom')}
              onChange={draftCustom}
              onKeyDown={continueFromCustom}
            />
          )}
        </div>
      </div>
      {error !== undefined && <p className={css.error} role="alert">{error}</p>}
      <div className={css.footer}>
        <div className={css.pager}>
          <button
            className={css.icon}
            type="button"
            aria-label={props.t('interact.question.prev')}
            disabled={index === 0 || busy !== undefined}
            onClick={() => { setIndex(index - 1); setError(undefined) }}
          >‹</button>
          <span className={css.progress}>{index + 1} / {questions.length}</span>
          <button
            className={css.icon}
            type="button"
            aria-label={props.t('interact.question.nextNav')}
            disabled={index === questions.length - 1 || busy !== undefined}
            onClick={() => { setIndex(index + 1); setError(undefined) }}
          >›</button>
        </div>
        <div className={css.actions}>
          <button className={css.secondary} type="button" disabled={busy !== undefined} onClick={skipQuestion}>
            {props.t('interact.question.skip')}
          </button>
          <button
            className={css.primary}
            type="button"
            disabled={busy !== undefined || !answered(draft)}
            onClick={continueFlow}
          >
            {busy === 'answer'
              ? props.t('interact.busy')
              : index === questions.length - 1
                ? props.t('interact.question.submit')
                : props.t('interact.question.next')}
          </button>
        </div>
      </div>
    </section>
  )
}
