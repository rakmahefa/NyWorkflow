export interface StreamHandle {
  stop(): void
  done: Promise<void>
}

/**
 * Deterministic canned reply — M1 runs without any model.
 * Real answers arrive with M2 (LlmAdapter → gemini-web2api).
 */
export function fakeReply(prompt: string): string {
  const subject = prompt.trim().slice(0, 120) || '(message vide)'
  return [
    'Réponse simulée — aucun modèle connecté en M1.',
    `Vous avez écrit : « ${subject} »`,
    'Les réponses réelles arriveront avec M2 (adaptateur LLM vers gemini-web2api).',
  ].join('\n\n')
}

/**
 * Streams `text` token by token (a token = one word with its leading
 * spaces). delayMs = 0 streams synchronously — used by the unit tests.
 */
export function streamText(
  text: string,
  onToken: (token: string) => void,
  delayMs = 24,
): StreamHandle {
  const tokens = text.match(/\s*\S+/g) ?? []
  let i = 0
  let stopped = false
  let finish: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })

  if (delayMs <= 0) {
    while (!stopped && i < tokens.length) onToken(tokens[i++] ?? '')
    finish()
  } else {
    const step = () => {
      if (stopped || i >= tokens.length) {
        finish()
        return
      }
      onToken(tokens[i++] ?? '')
      setTimeout(step, delayMs)
    }
    setTimeout(step, 0)
  }

  return {
    stop: () => {
      stopped = true
    },
    done,
  }
}
