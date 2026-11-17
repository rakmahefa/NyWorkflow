import { useRef, useState } from 'react'

/**
 * Composer façon DeepSeek Harness : carte flottante rayon 16 (bordure +
 * ombre légère), textarea qui grandit, rangée basse avec indice à gauche et
 * bouton d'envoi circulaire à droite. Entrée = envoyer. Désactivé pendant
 * qu'un tour agentique est en vol (M11) — l'agent terminera d'abord.
 */
export function Composer({ onSend, disabled = false }: { onSend(text: string): void; disabled?: boolean }) {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  const submit = () => {
    if (disabled) return
    const text = value.trim()
    if (!text) return
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
          placeholder={disabled ? 'Tour agentique en cours…' : 'Écrivez un message — /help pour les commandes'}
          disabled={disabled}
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
          <button
            className="send-btn"
            data-test="send-btn"
            aria-label="Envoyer"
            onClick={submit}
            disabled={disabled || !value.trim()}
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
        </div>
      </div>
    </footer>
  )
}
