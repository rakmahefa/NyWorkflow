/**
 * Préférence de thème (M8) — Auto (système) / Clair / Sombre, persistée en
 * localStorage, appliquée via data-theme sur <html>. Le CSS garde
 * prefers-color-scheme pour « auto » : les deux blocs de tokens sombres
 * (media query et attribut) sont maintenus synchrones à la main.
 */
export type ThemePreference = 'auto' | 'light' | 'dark'

const STORAGE_KEY = 'nyw-theme'

/** Lit la préférence stockée — défaut « auto ». Source injectable (tests). */
export function loadTheme(source: Pick<Storage, 'getItem'> = window.localStorage): ThemePreference {
  const raw = source.getItem(STORAGE_KEY)
  return raw === 'light' || raw === 'dark' ? raw : 'auto'
}

/** Applique la préférence : attribut data-theme sur <html> (absent = auto). */
export function applyTheme(preference: ThemePreference, target: { dataset: DOMStringMap } = document.documentElement): void {
  if (preference === 'auto') delete target.dataset.theme
  else target.dataset.theme = preference
}

/** Persiste la préférence. Cible injectable (tests). */
export function saveTheme(preference: ThemePreference, target: Pick<Storage, 'setItem'> = window.localStorage): void {
  target.setItem(STORAGE_KEY, preference)
}
