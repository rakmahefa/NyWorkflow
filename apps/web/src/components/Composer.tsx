import { useState } from 'react'

/** Single-line input + send button. Enter submits, empty input is ignored. */
export function Composer({ onSend }: { onSend(text: string): void }) {
  const [value, setValue] = useState('')

  const submit = () => {
    const text = value.trim()
    if (!text) return
    onSend(text)
    setValue('')
  }

  return (
    <footer className="composer">
      <input
        value={value}
        aria-label="Message"
        placeholder="Écrivez un message — /help pour les commandes"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
      />
      <button onClick={submit} disabled={!value.trim()}>
        Envoyer
      </button>
    </footer>
  )
}
