import { useCallback, useEffect, useState } from 'react'
import { fetchGatewayDiagnostic, timeOf, type GatewayDiagnostic } from '../lib/gatewayDiag'
import { loadTheme, saveTheme, applyTheme, type ThemePreference } from '../lib/theme'
import { APP_VERSION } from '../lib/version'

interface SettingsPanelProps {
  open: boolean
  onClose(): void
}

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: 'auto', label: 'Auto (système)' },
  { value: 'light', label: 'Clair' },
  { value: 'dark', label: 'Sombre' },
]

/**
 * Menu Paramètres (M8) — modale en trois sections :
 *   Apparence  : thème Auto/Clair/Sombre, persisté, appliqué à l'instant ;
 *   Passerelle : le diagnostic GET / de la webapi — cookies, comptes, bl,
 *               proxy, journal amont (les derniers échecs typés) ;
 *   À propos   : versions et guide utilisateur.
 */
export function SettingsPanel({ open, onClose }: SettingsPanelProps) {
  const [theme, setTheme] = useState<ThemePreference>(() => (typeof document === 'undefined' ? 'auto' : loadTheme()))
  const [diag, setDiag] = useState<{ ok: true; data: GatewayDiagnostic } | { ok: false; error: string } | null>(null)

  const refreshDiag = useCallback(() => {
    void fetchGatewayDiagnostic().then(setDiag)
  }, [])

  useEffect(() => {
    if (!open) return
    refreshDiag()
  }, [open, refreshDiag])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const chooseTheme = (value: ThemePreference): void => {
    setTheme(value)
    applyTheme(value)
    saveTheme(value)
  }

  const gw = diag?.ok ? diag.data.gateway : undefined
  const accounts = gw?.accounts ?? []
  const recent = [...(gw?.recent ?? [])].reverse().slice(0, 12) // les plus récents d'abord

  return (
    <div className="modal-overlay" data-test="settings-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Paramètres" data-test="settings-panel">
        <header className="modal-head">
          <h3>Paramètres</h3>
          <button type="button" className="modal-close" data-test="settings-close" aria-label="Fermer les paramètres" onClick={onClose}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
              <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <section className="settings-section" aria-label="Apparence">
          <h4>Apparence</h4>
          <div className="theme-picker" role="radiogroup" aria-label="Thème">
            {THEMES.map((t) => (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={theme === t.value}
                data-test={`theme-${t.value}`}
                className="theme-option"
                data-active={theme === t.value}
                onClick={() => chooseTheme(t.value)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section" aria-label="Passerelle">
          <h4>
            Passerelle webapi
            <button type="button" className="diag-refresh" data-test="diag-refresh" onClick={refreshDiag}>
              Rafraîchir
            </button>
          </h4>
          {diag === null ? (
            <p className="diag-line">Diagnostic en cours…</p>
          ) : !diag.ok ? (
            <p className="diag-line diag-error" data-test="diag-error">
              {diag.error} — la passerelle démarre normalement avec l'application ; vérifiez NYW_WEBAPI_EMBED ou relancez.
            </p>
          ) : (
            <dl className="diag" data-test="gateway-diag">
              <div className="diag-row">
                <dt>État</dt>
                <dd>
                  <span className="tag tag-ok">{diag.data.status}</span> {diag.data.provider} v{diag.data.version}
                </dd>
              </div>
              <div className="diag-row">
                <dt>Modèle</dt>
                <dd>
                  {diag.data.defaultModel} · {diag.data.models?.length ?? 0} modèles
                </dd>
              </div>
              <div className="diag-row">
                <dt>Cookies</dt>
                <dd>
                  {gw?.cookies ? (
                    <span className="tag tag-ok">présents</span>
                  ) : (
                    <span className="tag tag-warn" data-test="diag-no-cookies">
                      absents
                    </span>
                  )}{' '}
                  {gw?.rawCookies ? '(env NYW_WEBAPI_COOKIES)' : gw?.cookieFile}
                </dd>
              </div>
              {accounts.length > 1 ? (
                <div className="diag-row">
                  <dt>Comptes</dt>
                  <dd>
                    {accounts.filter((a) => a.cookies).length}/{accounts.length} valides · actif : n°{(gw?.activeAccount ?? 0) + 1}
                  </dd>
                </div>
              ) : null}
              <div className="diag-row">
                <dt>bl</dt>
                <dd>{gw?.bl ?? 'auto-découvert au premier tour'}</dd>
              </div>
              <div className="diag-row">
                <dt>Proxy</dt>
                <dd>{gw?.proxy ?? 'aucun'}</dd>
              </div>
            </dl>
          )}

          <h5 className="journal-title">Journal amont — derniers tours</h5>
          {recent.length === 0 ? (
            <p className="diag-line">Aucun tour encore — envoyez un message.</p>
          ) : (
            <table className="journal" data-test="gateway-journal">
              <thead>
                <tr>
                  <th>Heure</th>
                  <th>Modèle</th>
                  <th>Durée</th>
                  <th>Essais</th>
                  <th>Résultat</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r, i) => (
                  <tr key={`${r.at}-${i}`} data-test="journal-row">
                    <td>{timeOf(r.at)}</td>
                    <td className="journal-model">{r.model}</td>
                    <td>{r.ms} ms</td>
                    <td>{r.attempts}</td>
                    <td>
                      {r.ok ? (
                        <span className="tag tag-ok">ok</span>
                      ) : (
                        <span className="tag tag-err" title={r.error?.message}>
                          {r.error?.kind ?? 'erreur'}
                          {r.error?.status !== undefined ? ` ${r.error.status}` : ''}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="settings-section" aria-label="À propos">
          <h4>À propos</h4>
          <p className="diag-line">
            NyWorkflow v{APP_VERSION} — harness ICM propulsé par Gemini via la passerelle webapi intégrée. Interface inspirée de DeepSeek Harness.
            Guide complet : <code>USERGUIDE.md</code> à la racine du dépôt.
          </p>
        </section>
      </div>
    </div>
  )
}
