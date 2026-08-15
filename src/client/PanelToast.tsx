/**
 * PanelToast — dismissible notice inside the reverse-proxy settings page.
 *
 * Errors and warnings stay until the user dismisses them (they carry the
 * next step). Success toasts auto-dismiss after a short delay.
 */
import { useEffect } from 'react'
import type { ReverseProxyTranslate } from './i18n.ts'
import type { PanelToastModel, ToastKind } from './toast.ts'
import css from './remote.module.css'

const KIND_LABEL: Record<ToastKind, 'toast.error' | 'toast.warn' | 'toast.success'> = {
  error: 'toast.error',
  warn: 'toast.warn',
  success: 'toast.success',
}

const KIND_CLASS: Record<ToastKind, string> = {
  error: css.toastError,
  warn: css.toastWarn,
  success: css.toastSuccess,
}

export type PanelToastProps = {
  toast: PanelToastModel
  t: ReverseProxyTranslate
  onDismiss: () => void
}

export function PanelToast({ toast, t, onDismiss }: PanelToastProps) {
  useEffect(() => {
    if (toast.kind !== 'success') return
    const timer = window.setTimeout(onDismiss, 3200)
    return () => { window.clearTimeout(timer) }
  }, [toast, onDismiss])

  return (
    <div
      className={`${css.toast} ${KIND_CLASS[toast.kind]}`}
      role={toast.kind === 'error' ? 'alert' : 'status'}
    >
      <div className={css.toastBody}>
        <strong>{t(KIND_LABEL[toast.kind])}</strong>
        <p>{toast.text}</p>
      </div>
      <button
        className={css.toastDismiss}
        type="button"
        aria-label={t('toast.dismiss')}
        onClick={onDismiss}
      >×</button>
    </div>
  )
}
