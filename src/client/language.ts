import { useSyncExternalStore } from 'react'

export type LanguagePreference = 'auto' | 'en' | 'zh'
export const LANGUAGE_STORAGE_KEY = 'dsh-full-remote.language'

function preference(value: string | null): LanguagePreference {
  return value === 'en' || value === 'zh' ? value : 'auto'
}

export function browserLanguage(): 'en' | 'zh' {
  return typeof navigator !== 'undefined' && /^zh(?:-|$)/i.test(navigator.languages?.[0] || navigator.language)
    ? 'zh' : 'en'
}

/** Per-browser override; storage failures must never prevent remote access. */
export function createLanguageController() {
  let current: LanguagePreference = 'auto'
  try { current = preference(localStorage.getItem(LANGUAGE_STORAGE_KEY)) } catch { /* storage unavailable */ }
  let revision = 0
  const listeners = new Set<() => void>()
  const notify = () => {
    revision += 1
    for (const listener of listeners) listener()
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key !== LANGUAGE_STORAGE_KEY && event.key !== null) return
    current = preference(event.newValue)
    notify()
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage)
    window.addEventListener('languagechange', notify)
  }
  return {
    getPreference: () => current,
    getSnapshot: () => revision,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    setPreference(value: LanguagePreference) {
      current = value
      try {
        if (value === 'auto') localStorage.removeItem(LANGUAGE_STORAGE_KEY)
        else localStorage.setItem(LANGUAGE_STORAGE_KEY, value)
      } catch { /* retain the in-memory choice when storage is blocked */ }
      notify()
    },
    dispose() {
      if (typeof window !== 'undefined') {
        window.removeEventListener('storage', onStorage)
        window.removeEventListener('languagechange', notify)
      }
      listeners.clear()
    },
  }
}

export type LanguageController = ReturnType<typeof createLanguageController>
const subscribeNothing = () => () => {}
const zero = () => 0

export function useLanguage(language?: LanguageController) {
  useSyncExternalStore(language?.subscribe ?? subscribeNothing, language?.getSnapshot ?? zero, zero)
}
