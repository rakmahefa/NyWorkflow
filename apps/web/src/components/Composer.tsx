import { useRef, useState } from 'react'

/**
 * Composer façon DeepSeek Harness : carte flottante rayon 16 (bordure +
 * ombre légère), textarea qui grandit, rangée basse avec indice à gauche et
 * bouton d'envoi circulaire à droite. Entrée = envoyer.
 *
 * M12 : pendant un tour agentique, le textarea reste ACTIF (on prépare la
 * suite) mais l'envoi attend — et le bouton devient STOP : annuler le tour
 * en vol (le flux s'interrompt proprement, le texte partiel est journalisé).
 */
export function Composer({
  onSend,
  onStop,
  running = false,
}: {
  onSend(text: string): void
  /** M12 — cancels the running turn (shown as the stop button). */
  onStop(): void
  running?: boolean
}) {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  const submit = () => {
    const text = value.trim()
    if (!text) return
    // Pendant un tour, l'App met le message en file (jamais perdu).
    onSend(text)
    setValue('')
    if (ref.current) ref.current.style.height = 'auto'
  }

  return (
    <footer className="composer">
      <div className="composer-card">
        <textarea
          ref={ref}
          rows={1}
          value={value}
          aria-label="Message"
          placeholder={running ? 'Tour agentique en cours… (vous pouvez déjà écrire)' : 'Écrivez un message — /help pour les commandes'}
          onChange={(e) => {
            setValue(e.target.value)
            e.target.style.height = 'auto'
            e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="composer-row">
          <span className="composer-hint">Entrée pour envoyer · Maj+Entrée pour un saut de ligne</span>
          {running ? (
            <button
              className="stop-btn"
              data-test="stop-btn"
              aria-label="Arrêter le tour en cours"
              title="Arrêter le tour en cours (le texte reçu est conservé)"
              onClick={onStop}
            >
              <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
                <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
              </svg>
            </button>
          ) : (
            <button
              className="send-btn"
              data-test="send-btn"
              aria-label="Envoyer"
              onClick={submit}
              disabled={!value.trim()}
            >
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M8 12.5V3.5M8 3.5L3.5 8M8 3.5L12.5 8"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </div>
      </div>
    </footer>
  )
}
