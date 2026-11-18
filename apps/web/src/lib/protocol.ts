import { AGENT_TOOLS } from './agentTools'

/**
 * M20 — LE MENTOR : la boucle de rétroaction protocole.
 *
 * Piloté par les logs réels de la session 2026-11-18-ebbe : le modèle
 * suivait le protocole trois temps… sauf quand il ne le suivait pas —
 * thinking absent aux rounds 3 et 5 de la tâche arcade (2/7), `ls .`
 * exécuté trois fois pour un « hi » (rounds 1, 4, 5 — résultats
 * identiques), gabarits relus alors que l'ICM les charge à chaque tour.
 * Le harness JOURNALISAIT ces écarts (model.jsonl, protocol.*) mais ne
 * les disait JAMAIS au modèle : il n'était jamais corrigé.
 *
 * Le mentor referme la boucle : après chaque round, le harness calcule
 * les écarts et RENVOIE au round suivant un rappel de protocole (message
 * préfixé [HARNESS — protocole], journalisé dans model.observation via le
 * champ `feedback`). Le rappel est court, factuel, actionnable — jamais
 * une leçon de morale : le modèle corrige et reprend le travail.
 *
 * Pur et déterministe : tout se teste sans modèle ni réseau.
 */

/** One round's response, as the mentor reads it (stream facts + calls). */
export interface RoundProtocol {
  round: number
  firstEvent: 'thinking' | 'text' | 'tool_calls' | 'none'
  thinkingChars: number
  thinkingTitles: readonly string[]
  text: string
  toolCalls: readonly RoundToolCall[]
}

/** One call of the round, parsed (args) AND raw (the malformed verdict). */
export interface RoundToolCall {
  tool: string
  title: string
  argsOk: boolean
  args: Record<string, unknown>
  rawArgs: string
}

/** The calls already made earlier in the SAME turn — the anti-loop memory. */
export class ProtocolMemory {
  /** canonical (tool, args) → the round that already ran it. */
  private readonly seen = new Map<string, number>()

  /** Records a round's calls (called once per round, after the stream). */
  remember(round: number, calls: readonly RoundToolCall[]): void {
    for (const c of calls) {
      const key = callKey(c)
      if (!this.seen.has(key)) this.seen.set(key, round)
    }
  }

  /** The round that already ran this exact call, when it exists. */
  ranAt(c: RoundToolCall): number | undefined {
    return this.seen.get(callKey(c))
  }
}

/** Canonical key of a call: tool + sorted-path JSON of its args. */
function callKey(c: RoundToolCall): string {
  let args = ''
  try {
    const o = c.args ?? {}
    args = JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]))
  } catch {
    args = c.rawArgs
  }
  return `${c.tool}:${args}`
}

/** The tools the harness declares — anything else is unknown. */
const KNOWN_TOOLS = new Set(AGENT_TOOLS.map((t) => t.function.name))

/** The ICM-relative context paths, normalized for the redundant-read check:
 * the model may write `.workspace/notes/CONTEXT.md`, `./notes/CONTEXT.md`
 * or `notes/CONTEXT.md` for the same already-loaded file. */
export function normalizeIcmPath(raw: string): string {
  return raw.replace(/^\.\//, '').replace(/^\.workspace\//, '').replace(/^\/+/, '')
}

/** The nudge for a round that produced NOTHING (no text, no calls) — the
 * "missed tool_calls" case: the turn would otherwise end on an empty
 * answer. The mentor nudges ONCE per turn, then gives up honestly. */
export const EMPTY_RESPONSE_NUDGE =
  '[HARNESS — protocole] Ta dernière réponse était VIDE : ni texte, ni tool_calls. ' +
    'Reprends le protocole trois temps — thinking titré, puis SOIT des tool_calls groupés (avec leur title) pour agir, ' +
    'SOIT la réponse finale en prose pour le pilote. Une réponse vide n’est jamais une réponse.'

/** Compact display of a call for the reminder lines. */
function callLabel(c: RoundToolCall): string {
  const target = targetOfArgs(c.args)
  if (target !== '') return `${c.tool} « ${target} »`
  // Malformed args: the RAW string is the target — it says what broke.
  if (!c.argsOk && c.rawArgs !== '') return `${c.tool} « ${c.rawArgs.slice(0, 40)} »`
  return c.tool
}

function targetOfArgs(args: Record<string, unknown>): string {
  for (const key of ['path', 'pattern', 'command', 'query', 'url', 'jobId']) {
    const v = args?.[key]
    if (typeof v === 'string' && v !== '') return v
  }
  return ''
}

/**
 * The mentor's verdict on ONE round: null when the protocol was followed
 * (the mentor stays silent — no nagging a compliant model), the reminder
 * text otherwise. Pure: same round, same reminder, byte for byte.
 */
export function protocolFeedback(
  ctx: RoundProtocol,
  memory: ProtocolMemory,
  icmContextPaths: readonly string[],
): string | null {
  const lines: string[] = []
  const calls = ctx.toolCalls
  const saidSomething = ctx.text.trim() !== '' || ctx.thinkingChars > 0

  // 1. The titled thinking OPENS every response — the logs' most frequent
  //    violation (rounds 3 and 5 of the arcade task skipped it entirely).
  if (ctx.firstEvent !== 'thinking' && (calls.length > 0 || saidSomething)) {
    const began =
      ctx.firstEvent === 'text' ? 'du texte visible' : ctx.firstEvent === 'tool_calls' ? 'des tool_calls' : 'rien'
    lines.push(
      `Ta réponse doit S’OUVRIR par un bloc <thinking> titré — ce round-ci, elle a commencé par ${began}.`,
    )
  } else if (ctx.thinkingChars > 0 && ctx.thinkingTitles.length === 0) {
    lines.push('Ton bloc thinking n’a pas de title — donne-lui un titre court (« Comprendre la demande »…).')
  }

  // 2. Tool_calls hygiene: titles, strict JSON args, known tools.
  const untitled = calls.filter((c) => c.title === '').length
  if (untitled > 0) {
    lines.push(`${untitled === 1 ? '1 tool_call est' : `${untitled} tool_calls sont`} sans argument \`title\` — chaque appel porte son titre court.`)
  }
  const malformed = calls.filter((c) => !c.argsOk)
  if (malformed.length > 0) {
    lines.push(
      `Les arguments de ${malformed.length === 1 ? `l’appel ${callLabel(malformed[0]!)}` : `${malformed.length} appels`} ne sont pas un JSON objet valide — réémetis-les en JSON strict.`,
    )
  }
  const unknown = [...new Set(calls.filter((c) => !KNOWN_TOOLS.has(c.tool)).map((c) => c.tool))]
  if (unknown.length > 0) {
    lines.push(`Outil inconnu : ${unknown.map((t) => `« ${t} »`).join(', ')} — les outils déclarés sont ${[...KNOWN_TOOLS].join(', ')}.`)
  }

  // 3. The response STOPS after the calls: prose alongside tool_calls
  //    breaks the protocol (the text is sent before the results exist).
  if (calls.length > 0 && ctx.text.trim() !== '') {
    lines.push('Du texte visible accompagne tes tool_calls — termine ta réponse après les appels (le protocole : thinking, puis appels OU prose finale).')
  }

  // 4. Redundancy — the « hi » lesson: `ls .` three times, identical
  //    results, two rounds lost. Within the group first, then across the
  //    turn's earlier rounds, then the ICM files already in the prompt.
  const inGroup = new Map<string, number>()
  for (const c of calls) {
    const key = callKey(c)
    inGroup.set(key, (inGroup.get(key) ?? 0) + 1)
  }
  const dupes = [...inGroup.entries()].filter(([, n]) => n > 1)
  if (dupes.length > 0) {
    lines.push(`${dupes.length} appel${dupes.length > 1 ? 's sont' : ' est'} dupliqué${dupes.length > 1 ? 's' : ''} dans ton groupe — un appel identique rend le même résultat : déduplique.`)
  }
  for (const c of calls) {
    const ranAt = memory.ranAt(c)
    if (ranAt !== undefined && ranAt !== ctx.round) {
      lines.push(`Tu as déjà appelé ${callLabel(c)} au round ${ranAt} de CE tour — son résultat est dans l’observation : n’insiste pas, passe à la suite.`)
      break // one line is enough to correct the behaviour
    }
  }
  const loaded = new Set(icmContextPaths.map((p) => normalizeIcmPath(p)))
  for (const c of calls) {
    if (c.tool !== 'read') continue
    const p = typeof c.args?.path === 'string' ? c.args.path : ''
    if (p !== '' && loaded.has(normalizeIcmPath(p))) {
      lines.push(`« ${p} » est DÉJÀ chargé dans ton prompt système (ICM) — ne relis pas ce que tu as sous les yeux.`)
      break
    }
  }

  if (lines.length === 0) return null
  const head = `[HARNESS — protocole, round ${ctx.round}]`
  const tail = 'Reprends le protocole : thinking titré en premier, puis tool_calls groupés (avec leur title) ou la réponse finale.'
  return [head, ...lines.map((l) => `- ${l}`), tail].join('\n')
}
