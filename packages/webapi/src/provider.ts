/**
 * Abstraction provider — « pour l'instant ça sera gemini » : l'interface est
 * là, un seul implémentateur aujourd'hui. Un deuxième provider (M10) se
 * branchera sans toucher au serveur ni au reste du monorepo.
 *
 * M12 : le flux d'un tour porte DEUX canaux — le texte et la réflexion du
 * modèle (thoughts de l'interface Gemini), chacun en deltas. Le serveur
 * OpenAI les rend en `delta.reasoning_content` (dialecte DeepSeek), le
 * Google-style en parts `thought: true`.
 */
import { GeminiError, GeminiWebClient, type GeminiClientConfig, type GeminiDescribe } from './gemini.ts'
import { messagesToPrompt, type ChatMessage } from './convert.ts'
import { TurnJournal } from './journal.ts'

export interface ProviderChatOptions {
  model: string
  messages: ChatMessage[]
  /** Annulation : l'itérateur se termine proprement. */
  signal?: AbortSignal
}

/** One streamed piece of a turn: the answer text, or the model's thinking. */
export type ProviderChatEvent =
  | { kind: 'text'; delta: string }
  | { kind: 'thought'; delta: string }

export interface Provider {
  readonly id: string
  /** Identifiants de modèles exposés par GET /v1/models. */
  listModels(): Promise<string[]>
  /** Flux d'événements — texte et réflexion (M12). */
  chatStream(options: ProviderChatOptions): AsyncIterable<ProviderChatEvent>
  /** Réponse complète : texte et réflexion. */
  chatComplete(options: ProviderChatOptions): Promise<{ text: string; reasoning: string }>
  /** Diagnostic pour GET / (aucune requête réseau). */
  describe(): GeminiDescribe
}

export function createGeminiProvider(config: GeminiClientConfig = {}, journal?: TurnJournal): Provider {
  const client = new GeminiWebClient({ ...config, journal })
  return {
    id: 'gemini',
    async listModels(): Promise<string[]> {
      return client.describe().models
    },
    async *chatStream(options: ProviderChatOptions): AsyncIterable<ProviderChatEvent> {
      const prompt = messagesToPrompt(options.messages)
      for await (const item of client.stream({ prompt, model: options.model, signal: options.signal })) {
        if (item.type === 'text') yield { kind: 'text', delta: item.delta }
        else if (item.type === 'thought') yield { kind: 'thought', delta: item.delta }
        // tool_calls restent visibles côté client Gemini (convention de
        // blocs M10) ; les métadonnées ne traversent pas l'API publique.
      }
    },
    async chatComplete(options: ProviderChatOptions): Promise<{ text: string; reasoning: string }> {
      let text = ''
      let reasoning = ''
      for await (const item of client.stream({ prompt: messagesToPrompt(options.messages), model: options.model, signal: options.signal })) {
        if (item.type === 'text') text += item.delta
        else if (item.type === 'thought') reasoning += item.delta
        else if (item.type === 'toolCall') throw new GeminiError('upstream', `Gemini a émis un appel d'outil (${item.name}) pendant une complétion texte`)
      }
      return { text, reasoning }
    },
    describe: () => client.describe(),
  }
}
