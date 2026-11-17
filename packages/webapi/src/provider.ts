/**
 * Abstraction provider — « pour l'instant ça sera gemini » : l'interface est
 * là, un seul implémentateur aujourd'hui. Un deuxième provider (M10) se
 * branchera sans toucher au serveur ni au reste du monorepo.
 */
import { GeminiWebClient, type GeminiClientConfig, type GeminiDescribe } from './gemini.ts'
import { messagesToPrompt, type ChatMessage } from './convert.ts'
import { TurnJournal } from './journal.ts'

export interface ProviderChatOptions {
  model: string
  messages: ChatMessage[]
  /** Annulation : l'itérateur se termine proprement. */
  signal?: AbortSignal
}

export interface Provider {
  readonly id: string
  /** Identifiants de modèles exposés par GET /v1/models. */
  listModels(): Promise<string[]>
  /** Flux de tokens. */
  chatStream(options: ProviderChatOptions): AsyncIterable<string>
  /** Réponse complète. */
  chatComplete(options: ProviderChatOptions): Promise<string>
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
    async *chatStream(options: ProviderChatOptions): AsyncIterable<string> {
      const prompt = messagesToPrompt(options.messages)
      for await (const item of client.stream({ prompt, model: options.model, signal: options.signal })) {
        // v1 : seuls les deltas de texte traversent — métadonnées et tool_calls
        // restent visibles côté client Gemini, ignorés par l'API publique.
        if (item.type === 'text') yield item.delta
      }
    },
    async chatComplete(options: ProviderChatOptions): Promise<string> {
      return client.complete({ prompt: messagesToPrompt(options.messages), model: options.model, signal: options.signal })
    },
    describe: () => client.describe(),
  }
}
