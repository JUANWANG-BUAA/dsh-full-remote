/**
 * toast — map control-surface outcomes to a panel toast.
 *
 * Start/stop/listen return HTTP 200 even when the proxy did not bind.
 * The settings page must not treat that as silence: each `reason` code gets a
 * dedicated, actionable message instead of a raw identifier.
 */
import type { ReverseProxyTranslate } from './i18n.ts'
import type { ProxyStatus } from './types.ts'

export type ToastKind = 'error' | 'warn' | 'success'
export type ToastIntent = 'start' | 'stop' | 'listen' | 'rotate'
export type PanelToastModel = { kind: ToastKind, text: string }

function bindOf(status: ProxyStatus) {
  return status.listen === undefined ? '' : `${status.listen.host}:${status.listen.port}`
}

export function toastFromReason(
  reason: string,
  status: ProxyStatus,
  t: ReverseProxyTranslate,
  intent: ToastIntent,
): PanelToastModel {
  const bind = bindOf(status)
  const backend = status.backend ?? ''
  switch (reason) {
    case 'listen-failed':
      return {
        kind: 'error',
        text: t(intent === 'listen' ? 'error.listenFailed' : 'error.startListenFailed', { bind, backend }),
      }
    case 'self-loop':
      return { kind: 'error', text: t('error.startSelfLoop', { bind, backend }) }
    case 'disposed':
      return { kind: 'error', text: t('error.startDisposed') }
    case 'invalid-listen':
      return { kind: 'error', text: t('error.invalidListenServer') }
    case 'listen-failed-restored':
      return { kind: 'warn', text: t('error.listenRestored', { bind }) }
    case 'tls-failed':
      return { kind: 'error', text: t('error.tlsFailed') }
    default:
      return { kind: 'error', text: t('error.unknownReason', { reason }) }
  }
}

export function toastFromStatus(
  status: ProxyStatus & { accessToken?: string },
  t: ReverseProxyTranslate,
  intent: ToastIntent,
): PanelToastModel {
  if (intent === 'rotate') {
    // rotateToken always mutates the token/sessions before optional restart.
    if (status.reason !== undefined && status.reason !== '') {
      return {
        kind: 'warn',
        text: t('toast.tokenRotatedWithIssue', {
          detail: toastFromReason(status.reason, status, t, intent).text,
        }),
      }
    }
    return { kind: 'success', text: t('toast.tokenRotated') }
  }
  if (status.reason !== undefined && status.reason !== '') {
    return toastFromReason(status.reason, status, t, intent)
  }
  if (intent === 'start') {
    return status.running
      ? { kind: 'success', text: t('toast.started') }
      : { kind: 'error', text: t('error.startUnknown') }
  }
  if (intent === 'stop') return { kind: 'success', text: t('toast.stopped') }
  if (intent === 'listen') return { kind: 'success', text: t('toast.listenApplied') }
  return { kind: 'success', text: t('toast.tokenRotated') }
}

export function toastFromCaught(error: unknown, t: ReverseProxyTranslate): PanelToastModel {
  const message = error instanceof Error ? error.message : ''
  if (message === 'forbidden') return { kind: 'error', text: t('error.forbidden') }
  if (message === 'loopback-required') return { kind: 'error', text: t('error.loopbackRequired') }
  if (message === 'token-read-disabled') return { kind: 'error', text: t('error.tokenReadDisabled') }
  if (message === 'invalid-request') return { kind: 'error', text: t('error.invalidRequest') }
  if (message === 'invalid-base') return { kind: 'error', text: t('error.invalidInviteBase') }
  if (message === 'not-running') return { kind: 'error', text: t('error.notRunning') }
  // Server-side action failure (500): the generic copy already tells the
  // user to retry / check the log; a raw code would not.
  if (message === 'action-failed') return { kind: 'error', text: t('error.generic') }
  if (message !== '') return { kind: 'error', text: t('error.network', { detail: message }) }
  return { kind: 'error', text: t('error.generic') }
}
