import { useCallback } from 'react'
import { useSettingsStore, type AppLanguage } from '@/stores/settingsStore'
import { translations, type TranslationKey } from './translations'

/**
 * Hook that returns a translation function `t()` based on the current app language.
 * Usage: const t = useTranslation()
 *        <Text>{t('menu.file')}</Text>
 */
export function useTranslation() {
  const lang = useSettingsStore(s => s.appLanguage)

  return useCallback(function t(key: TranslationKey): string {
    return translations[lang]?.[key] ?? translations.en[key] ?? key
  }, [lang])
}

/**
 * Non-reactive getter for use outside React components (event handlers, services).
 * Always reads the latest language from the store.
 */
export function t(key: TranslationKey): string {
  const lang = useSettingsStore.getState().appLanguage
  return translations[lang]?.[key] ?? translations.en[key] ?? key
}

/** Detect OS language — returns 'pt' for any pt-* locale, 'en' otherwise. */
export function getOSLanguage(): AppLanguage {
  const nav = typeof navigator !== 'undefined' ? navigator.language || '' : ''
  return nav.toLowerCase().startsWith('pt') ? 'pt' : 'en'
}
