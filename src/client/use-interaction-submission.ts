import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReverseProxyTranslate } from './i18n.ts'

type SubmissionKind = 'answer' | 'cancel'
type NoticeKey = 'cockpit.confirming' | 'cockpit.uncertain'

export type InteractionSubmission = {
  busy: SubmissionKind | undefined
  error?: string
  notice?: string
  run: (kind: SubmissionKind, operation: () => Promise<void>) => void
}

/** One attempt per mounted pending card; only registry removal confirms its outcome. */
export function useInteractionSubmission(t: ReverseProxyTranslate): InteractionSubmission {
  const locked = useRef(false)
  const mounted = useRef(false)
  const [busy, setBusy] = useState<SubmissionKind>()
  const [error, setError] = useState<string>()
  const [noticeKey, setNoticeKey] = useState<NoticeKey>()

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (busy === undefined) return
    const timer = setTimeout(() => {
      if (mounted.current) setNoticeKey('cockpit.uncertain')
    }, 10_000)
    return () => { clearTimeout(timer) }
  }, [busy])

  const run = useCallback((kind: SubmissionKind, operation: () => Promise<void>) => {
    // State updates are batched: the ref must fence a second click immediately.
    if (!mounted.current || locked.current) return
    locked.current = true
    setBusy(kind)
    void (async () => {
      try {
        await operation()
        if (!mounted.current) return
        // A late acknowledgement cannot override an already uncertain result.
        setNoticeKey(previous => previous === 'cockpit.uncertain' ? previous : 'cockpit.confirming')
      } catch (cause) {
        if (!mounted.current) return
        setError(cause instanceof Error ? cause.message : String(cause))
        setNoticeKey('cockpit.uncertain')
      }
      // Never unlock, replay, or retry. The parent registry owns card removal.
    })()
  }, [])

  return { busy, error, notice: noticeKey === undefined ? undefined : t(noticeKey), run }
}
