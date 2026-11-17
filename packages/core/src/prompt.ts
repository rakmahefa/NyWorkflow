/**
 * Prompt assembly — pure: no filesystem, no network. The engine loads the
 * inputs, then hands everything to assembleStageMessages; the result is what
 * goes to the model (and what the tests inspect).
 */
import type { InputRef, StageContract } from './index'

/** Minimal chat-message shape — structurally compatible with adapter-llm. */
export interface StageChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * What the engine needs from a model client. LlmAdapter (adapter-llm)
 * satisfies this interface structurally — core never imports it, so the
 * engine stays network-free and trivially mockable.
 */
export interface StageLlm {
  chatStream(options: {
    model: string
    messages: StageChatMessage[]
    /** Cancels the stream; the iterator then ends. */
    signal?: AbortSignal
  }): AsyncIterable<string>
}

/** One contract input, resolved: a file's content, or the run subject. */
export interface LoadedInput {
  ref: InputRef
  content: string
}

/** Workspace display name — the folder name, for prompts. */
export function workspaceName(root: string): string {
  const parts = root.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? root
}

function renderInput(input: LoadedInput): string {
  const { ref } = input
  const label = ref.origin || (ref.source === '' ? 'Sujet' : ref.source)
  const why = ref.why ? ` — ${ref.why}` : ''
  const scope = ref.scope === 'full' ? '' : `\nPortion : ${ref.scope}`
  return [`### ${label}${why}${scope}`, '', input.content].join('\n')
}

/**
 * Builds the messages of one stage call: a system preamble (role and rules)
 * plus a user message assembling the map, every declared input, the process
 * and the expected output. Stage replies are written verbatim to output/ —
 * the model is told so.
 */
export function assembleStageMessages(args: {
  workspace: string
  contract: StageContract
  map: string
  loaded: LoadedInput[]
}): StageChatMessage[] {
  const { contract, map, loaded } = args

  const system =
    `Tu exécutes l'étape « ${contract.stage} — ${contract.title} » du workflow ICM « ${args.workspace} » ` +
    '(méthode ICM : le système de fichiers est l\'orchestrateur — dossiers numérotés, contrats CONTEXT.md, sorties dans output/). ' +
    'Suis le Process indiqué, dans l\'ordre, en t\'appuyant uniquement sur les Entrées fournies. ' +
    'Réponds exclusivement par le contenu final de l\'artefact demandé, en Markdown, ' +
    'sans préambule ni explication ni clôture : ta réponse sera écrite telle quelle dans le fichier de sortie.'

  const user = [
    `# Étape ${contract.stage} — ${contract.title}`,
    '',
    '## Carte du workspace (CONTEXT.md racine)',
    '',
    map.trim(),
    '',
    '## Entrées',
    '',
    ...(loaded.length > 0 ? loaded.map(renderInput) : ['(aucune entrée déclarée)']),
    '',
    '## Process',
    '',
    ...contract.process,
    '',
    '## Sortie attendue',
    '',
    contract.outputs.length > 0
      ? `Écris uniquement le contenu du fichier \`${contract.outputs[0]}\` — ta réponse entière sera écrite à cet emplacement, sans modification.`
      : '(aucune sortie déclarée)',
    '',
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}
