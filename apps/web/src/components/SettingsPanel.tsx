import { useCallback, useEffect, useState } from 'react'
import * as api from '../lib/sessionApi'
import { fetchGatewayDiagnostic, timeOf, formatExpiry, type GatewayAccountDto, type GatewayDiagnostic } from '../lib/gatewayDiag'
import {
  loadDefaultSecurity,
  saveDefaultSecurity,
  SECURITY_HINT,
  SECURITY_LABEL,
  SECURITY_LEVELS,
} from '../lib/security'
import type { SecurityLevel } from '../lib/types'
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
 *
 * M9 : la section Passerelle montre aussi la table Comptes & sessions
 * (/u/N par compte, expiration des cookies — on voit venir l'expiration)
 * et les statistiques d'utilisation par compte.
 */
export function SettingsPanel({ open, onClose }: SettingsPanelProps) {
  const [theme, setTheme] = useState<ThemePreference>(() => (typeof document === 'undefined' ? 'auto' : loadTheme()))
  const [diag, setDiag] = useState<{ ok: true; data: GatewayDiagnostic } | { ok: false; error: string } | null>(null)
  /** M13 — default security for NEW sessions (persisted). */
  const [defaultSecurity, setDefaultSecurity] = useState<SecurityLevel>(() =>
    typeof localStorage === 'undefined' ? 'ask' : loadDefaultSecurity(),
  )
  /** M13 — the profiling logs card: listing + the tail of one log. */
  const [logs, setLogs] = useState<api.LogsDto | null>(null)
  const [logTail, setLogTail] = useState<{ name: string; tail: string } | null>(null)

  const refreshDiag = useCallback(() => {
    void fetchGatewayDiagnostic().then(setDiag)
  }, [])

  const refreshLogs = useCallback(() => {
    void api
      .listLogs()
      .then(setLogs)
      .catch(() => setLogs(null))
  }, [])

  useEffect(() => {
    if (!open) return
    refreshDiag()
    refreshLogs()
  }, [open, refreshDiag, refreshLogs])

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

  const chooseSecurity = (value: SecurityLevel): void => {
    setDefaultSecurity(value)
    saveDefaultSecurity(value)
  }

  const gw = diag?.ok ? diag.data.gateway : undefined
  const accounts = gw?.accounts ?? []
  const recent = [...(gw?.recent ?? [])].reverse().slice(0, 12) // les plus récents d'abord
  const usage = gw?.accountUsage ?? []

  // M9 : table Comptes & sessions — dès qu'il y a plusieurs comptes OU des
  // informations de session/expiration à montrer.
  const showAccounts =
    accounts.length > 1 || accounts.some((a) => a.authUser !== undefined || a.expiresAt !== undefined)
  const shortFile = (f: string): string => f.split('/').pop() || f
  const accountName = (a: GatewayAccountDto): string => a.label ?? shortFile(a.file)
  const nameByIndex = (i: number): string =>
    accounts[i] !== undefined ? accountName(accounts[i] as GatewayAccountDto) : `Compte n°${i + 1}`

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

        <section className="settings-section" aria-label="Sécurité">
          <h4>Sécurité (niveau par défaut des nouvelles sessions)</h4>
          <div className="theme-picker" role="radiogroup" aria-label="Niveau de sécurité">
            {SECURITY_LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                role="radio"
                aria-checked={defaultSecurity === level}
                data-test={`default-security-${level}`}
                className="theme-option"
                data-active={defaultSecurity === level}
                onClick={() => chooseSecurity(level)}
                title={SECURITY_HINT[level]}
              >
                {SECURITY_LABEL[level]}
              </button>
            ))}
          </div>
          <p className="diag-line">
            {SECURITY_HINT[defaultSecurity]} — le niveau de CHAQUE session se règle dans son bandeau (et à la création),
            en direct : le journal garde la vérité.
          </p>
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
            <>
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
              {gw?.authUser !== undefined && gw?.authUser !== null ? (
                <div className="diag-row">
                  <dt>Session</dt>
                  <dd>/u/{gw.authUser} · compte actif n°{(gw?.activeAccount ?? 0) + 1}</dd>
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
          {showAccounts ? (
            <>
              <h5 className="journal-title">Comptes &amp; sessions</h5>
              <table className="journal" data-test="gateway-accounts">
                <thead>
                  <tr>
                    <th>Compte</th>
                    <th>Session</th>
                    <th>Cookies</th>
                    <th>Expiration</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => {
                    const expiry = a.expiresAt !== undefined ? formatExpiry(a.expiresAt) : undefined
                    return (
                      <tr key={a.file} data-test="account-row">
                        <td className="journal-model">{accountName(a)}</td>
                        <td>{a.authUser !== undefined ? `/u/${a.authUser}` : '—'}</td>
                        <td>
                          {a.cookies ? (
                            <span className="tag tag-ok">présents</span>
                          ) : (
                            <span className="tag tag-err" title={a.error ?? 'aucun cookie exploitable'}>
                              {a.error !== undefined ? 'illisibles' : 'expirés/absents'}
                            </span>
                          )}
                        </td>
                        <td>
                          {expiry !== undefined ? (
                            <span className={`tag tag-${expiry.tone}`}>{expiry.text}</span>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </>
          ) : null}
          {usage.length > 0 ? (
            <>
              <h5 className="journal-title">Statistiques par compte</h5>
              <table className="journal" data-test="gateway-usage">
                <thead>
                  <tr>
                    <th>Compte</th>
                    <th>Tours</th>
                    <th>OK</th>
                    <th>Échecs</th>
                    <th>Dernier</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.map((u) => (
                    <tr key={u.account} data-test="usage-row">
                      <td className="journal-model">{nameByIndex(u.account)}</td>
                      <td>{u.turns}</td>
                      <td>{u.ok}</td>
                      <td>{u.failed}</td>
                      <td>{u.lastAt !== undefined ? timeOf(u.lastAt) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
          </>
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

        <section className="settings-section" aria-label="Profiling et logs">
          <h4>
            Profiling &amp; logs
            <button type="button" className="diag-refresh" data-test="logs-refresh" onClick={refreshLogs}>
              Rafraîchir
            </button>
          </h4>
          {logs === null ? (
            <p className="diag-line">Logs injoignables (serveur de sessions absent ?).</p>
          ) : (
            <>
              <p className="diag-line" data-test="logs-dir">
                Dossier : <code>{logs.dir}</code> — trois journaux JSONL, rotation à 8 Mio. Copiez-les dans le dépôt
                pour améliorer et peaufiner le harness.
              </p>
              <table className="journal" data-test="logs-table">
                <thead>
                  <tr>
                    <th>Journal</th>
                    <th>Lignes</th>
                    <th>Taille</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {logs.files.map((f) => (
                    <tr key={f.name} data-test="logs-row">
                      <td className="journal-model">{f.name}</td>
                      <td>{f.lines}</td>
                      <td>{(f.bytes / 1024).toFixed(1)} Kio</td>
                      <td>
                        <button
                          type="button"
                          className="diag-refresh"
                          onClick={() =>
                            void api
                              .tailLog(f.name, 50)
                              .then((t) => setLogTail(t.tail === '' ? { name: f.name, tail: '(vide)' } : { name: f.name, tail: t.tail }))
                              .catch(() => setLogTail(null))
                          }
                        >
                          Voir
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {logTail !== null ? (
                <pre className="log-tail" data-test="log-tail">{logTail.name} — 50 dernières lignes
{'\n'}{logTail.tail}</pre>
              ) : null}
            </>
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
