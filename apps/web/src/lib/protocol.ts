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
  /** M21 — the thinking TEXT: the PLAN announcement lives at its end. */
  thinking: string
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

/** M21 — no_tool was emitted WITHOUT the final prose it must accompany:
 * nudged once, then the turn ends honestly. */
export const NO_TOOL_EMPTY_PROSE_NUDGE =
  '[HARNESS — protocole] Tu as émis no_tool SANS la prose finale : l’appel no_tool ACCOMPAGNE ta réponse au pilote ' +
    'dans la MÊME réponse (thinking titré, puis no_tool, puis la prose). Écris maintenant cette réponse finale.'

/**
 * M21 — LE CONTRAT D’APPELS. Le thinking de chaque round se TERMINE par
 * une ligne d’annonce :
 *
 *   PLAN: 3 tool_calls — [Lire le plan] [Lister inbox] [Vérifier uv]
 *   PLAN: no_tool
 *
 * Le harness compare cette annonce au groupe réellement émis : un groupe
 * qui ne tient pas son contrat n’est PAS exécuté — le modèle relit et
 * réémet. Pur et tolérant aux petites variations (espaces, tirets,
 * « appels » au lieu de « tool_calls »).
 */
export type CallPlan = { kind: 'calls'; count: number; titles: readonly string[] } | { kind: 'no_tool' }

/** Parses the PLAN announcement out of a thinking block — null when absent. */
export function parseCallPlan(thinking: string): CallPlan | null {
  if (thinking === '') return null
  const lines = thinking.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    const head = line.match(/^\s*PLAN\s*[:：]\s*/i)
    if (head === null) continue
    const rest = line.slice(head[0].length)
    if (/no[\s_-]*tool/i.test(rest)) return { kind: 'no_tool' }
    const n = rest.match(/\d+/)
    if (n === null) return null // annonce présente mais illisible — traitée comme absente
    const titles = [...rest.matchAll(/\[([^\]]*)\]/g)].map((t) => t[1]!.trim()).filter((t) => t !== '')
    return { kind: 'calls', count: Number.parseInt(n[0]!, 10), titles }
  }
  return null
}

/** Compact render of a plan, for the reminder lines. */
function planLabel(plan: CallPlan): string {
  return plan.kind === 'no_tool'
    ? 'PLAN: no_tool'
    : `PLAN: ${plan.count} tool_calls${plan.titles.length > 0 ? ` — ${plan.titles.map((t) => `« ${t} »`).join(' ')}` : ''}`
}

/** Compact display of a call for the reminder lines. */
function callLabel(c: RoundToolCall): string {
  const target = targetOfArgs(c.args)
  if (target !== '') return `${c.tool} « ${target} »`
  // Malformed args: the RAW string is the target — it says what broke.
  if (!c.argsOk && c.rawArgs !== '') return `${c.tool} « ${c.rawArgs.slice(0, 40)} »`
  return c.tool
}

function targetOfArgs(args: Record<string, unknown>): string {
  for (const key of ['path', 'pattern', 'command', 'query', 'url', 'jobId', 'reason']) {
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
  const lines = protocolLines(ctx, memory, icmContextPaths)
  if (lines.length === 0) return null
  const head = `[HARNESS — protocole, round ${ctx.round}]`
  const tail = 'Reprends le protocole : thinking titré en premier, puis tool_calls groupés (avec leur title) ou la réponse finale.'
  return [head, ...lines.map((l) => `- ${l}`), tail].join('\n')
}

/**
 * M21 — the REDO note: the group did NOT hold its contract, the harness
 * did NOT execute it. The model must re-read what it did and re-emit the
 * complete group. All the round's other deviations ride along (one note,
 * not two).
 */
export function planRedoNote(round: number, lines: readonly string[]): string {
  return [
    `[HARNESS — protocole, round ${round}]`,
    ...lines.map((l) => `- ${l}`),
    'Ce groupe d’appels n’a PAS été exécuté (contrat non tenu). Relis ce que tu as fait, relis ton PLAN, puis RÉÉMETS le groupe complet : le nombre d’appels annoncé, chacun avec son `title` — la logique du tour reprendra proprement.',
  ].join('\n')
}

/** The mentor's bullet lines for one round — pure, exported for the redo
 * note (M21): same deviations, two wrappings. */
export function protocolLines(
  ctx: RoundProtocol,
  memory: ProtocolMemory,
  icmContextPaths: readonly string[],
): string[] {
  const lines: string[] = []
  const calls = ctx.toolCalls
  const saidSomething = ctx.text.trim() !== '' || ctx.thinkingChars > 0
  const plan = parseCallPlan(ctx.thinking)
  const realCalls = calls.filter((c) => c.tool !== 'no_tool')
  const hasNoTool = calls.some((c) => c.tool === 'no_tool')
  const onlyNoTool = hasNoTool && realCalls.length === 0

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

  // 1bis. M21 — LE CONTRAT D’APPELS : l’annonce PLAN clôt le thinking, le
  // groupe émis doit la tenir. (Le refus pur et simple du groupe — le
  // « réémet » — est décidé par la boucle, pas ici : ces lignes documentent
  // l’écart, y compris quand la boucle exécute malgré tout.)
  if (calls.length > 0 && !onlyNoTool) {
    if (plan === null) {
      lines.push(
        'Ton thinking ne se termine pas par l’annonce du plan — dernière ligne attendue : « PLAN: 3 tool_calls — [Titre A] [Titre B] [Titre C] » (ou « PLAN: no_tool » avant la prose finale).',
      )
    } else if (plan.kind === 'no_tool') {
      lines.push(
        `Tu as annoncé « PLAN: no_tool » puis émis ${realCalls.length} tool_call${realCalls.length > 1 ? 's' : ''} — l’un ou l’autre : no_tool s’émet SEUL, en fin de tour, sans autre appel.`,
      )
    } else {
      if (hasNoTool) {
        lines.push('`no_tool` est mélangé à de vrais appels — il s’émet SEUL, jamais dans un groupe de travail.')
      }
      if (plan.count !== realCalls.length) {
        lines.push(
          `Ton plan annonçait ${plan.count} tool_call${plan.count > 1 ? 's' : ''} et tu en as émis ${realCalls.length} — le compte annoncé et le groupe émis doivent coïncider EXACTEMENT.`,
        )
      }
      if (plan.titles.length === 0 && realCalls.length > 0) {
        lines.push('Ton annonce PLAN: ne liste pas les titres — « PLAN: 2 tool_calls — [Titre A] [Titre B] » les porte entre crochets.')
      }
    }
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
  //    M21 — EXCEPT no_tool: its final prose follows the call in the same
  //    response (nothing to wait for) — that IS the designed ending.
  if (calls.length > 0 && !onlyNoTool && ctx.text.trim() !== '') {
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

  return lines
}
