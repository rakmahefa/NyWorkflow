import { AGENT_TOOLS } from './agentTools'

/**
 * M22 — LES CINQ PHASES DU TOUR, chacune née d'un EN-TÊTE EXACT.
 *
 * Demandé par le pilote au retour du M21 : le contrat d'appels tenait
 * l'annonce dans le thinking (une ligne PLAN:), mais le modèle qui « miss »
 * restait visible — un appel mal formé redevenait de la prose, une prose
 * sans signature terminait le tour, et rien ne séparait les phases. M22
 * refonde le tour en CINQ PHASES SÉPARÉES, dans le backend comme dans les
 * deux UI :
 *
 *   1. THINKING      — en-tête exact : <thinking title="…">…</thinking>
 *   2. TOOL_LISTING  — en-tête exact : [TOOL_LISTING] N tool_calls — [Titres]
 *                      (ou [TOOL_LISTING] no_tool) — section du TEXTE visible
 *   3. MESSAGE       — en-tête exact : [MESSAGE] puis la prose au pilote
 *   4. TOOL_CALLS    — en-tête exact : {{tool {"name": …, "arguments": {…} }} }
 *                      un bloc par appel — le listing ENGAGE le groupe
 *   5. FEEDBACK      — en-tête exact : [HARNESS — feedback] — le HARNESS
 *                      seul écrit cette phase (codée, jamais modelisée)
 *
 * La règle du pilote : « chacun devra avoir un entête precis sinon rejete
 * et ne sera pas affiché nulle part ». Une phase sans son en-tête est
 * REJETÉE — pas affichée, pas exécutée — et le feedback engine la liste au
 * modèle : toutes les erreurs, tous les manques droppés (mauvais formatage,
 * incohérence entre le listing et les appels réels). Le tour ne se termine
 * QUE par la signature no_tool + [MESSAGE] : le modèle attend le feedback
 * du harness pour décider de la suite — lui seul ne « s'arrête » plus.
 *
 * Pur et déterministe : tout se teste sans modèle ni réseau.
 */

/** M22 — les EN-TÊTES EXACTS des cinq phases (le contrat orthographique). */
export const TOOL_LISTING_HEADER = '[TOOL_LISTING]'
export const MESSAGE_HEADER = '[MESSAGE]'
export const FEEDBACK_HEADER = '[HARNESS — feedback'

/** M23 — LE BRIEFING, première ligne du thinking du PREMIER round d'un tour.
 * Le pilote l'a demandé : le modèle ne doit pas « travailler simplement » —
 * il ESTIME le niveau d'exigence et les skills nécessaires, puis l'état de
 * l'ICM, AVANT de s'attaquer à la tâche. La ligne vit dans le thinking
 * (phase 1) : c'est le plan de vol du professionnel, pas de la prose au
 * pilote. */
export const ASSESSMENT_PREFIX = 'EXIGENCE:'

/** Le gabarit exact, tel que le prompt l'enseigne et le feedback le rappelle. */
export const ASSESSMENT_EXAMPLE =
  'EXIGENCE: exigeante — skills: python, packaging — ICM: à renforcer (skills/uv à construire)'

/** M22 — LE FORMAT EXACT d'un appel d'outil, tel que le harness le décode.
 * La passerelle enseigne la convention en amont (préambule [Tool calling]) ;
 * le feedback la RAPPELE au moment exact où le modèle se trompe — un appel
 * en prose n'est jamais exécuté, c'est la leçon des tours cassés. */
export const TOOL_CALL_FORMAT =
  '{{tool {"name": "ls", "arguments": {"path": ".", "title": "Lister la racine"}} }}'

/** One round's response, as the feedback engine reads it (stream facts + phases + calls). */
export interface RoundProtocol {
  round: number
  firstEvent: 'thinking' | 'text' | 'tool_calls' | 'none'
  thinkingChars: number
  thinkingTitles: readonly string[]
  /** The thinking TEXT (phase 1, streamed through its <thinking> tags). */
  thinking: string
  /** The RAW visible text of the round (listing + message + drops, en-têtes compris). */
  text: string
  /** M22 — the same text, cut into phases by their exact headers. */
  phases: RoundPhases
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

/**
 * M22 — the visible text of one round, cut into its phases. Anything that
 * does not carry an exact header is DROPPED material: never displayed,
 * never executed — the feedback engine reports it.
 */
export interface RoundPhases {
  /** Phase 2 — the listing parsed from [TOOL_LISTING] (null when absent). */
  listing: CallPlan | null
  /** The listing's raw content line (the activity tab shows it as-is). */
  listingRaw: string
  /** True when the [TOOL_LISTING] header was present (even if unreadable). */
  listingPresent: boolean
  /** Phase 3 — the prose after [MESSAGE] ('' when absent). */
  message: string
  /** Headerless prose: DROPPED (never displayed). */
  droppedText: string
  /** Characters of dropped prose (the feedback's counter). */
  droppedChars: number
  /** Malformed tool blocks that stayed in the text (dropped by the decoder). */
  brokenToolBlocks: number
}

/**
 * Parses the visible text of a round into its phases, by exact headers.
 * Tolerant while streaming (a half-written header simply does not match
 * yet); idempotent and pure. The FIRST [TOOL_LISTING] wins, every
 * [MESSAGE] (re)opens the prose section, header lines are never prose.
 */
export function parseRoundPhases(text: string): RoundPhases {
  const lines = text.split('\n')
  let listingRaw: string | null = null
  const messageLines: string[] = []
  const droppedLines: string[] = []
  let inMessage = false
  for (const line of lines) {
    const head = line.match(/^\s*\[(?:tool_listing|message)\]\s*/i)
    if (head !== null) {
      if (/^\s*\[\s*tool_listing\s*\]/i.test(line)) {
        if (listingRaw === null) listingRaw = line.slice(head[0].length)
        inMessage = false // le listing ne fait pas partie de la prose
      } else {
        inMessage = true
        const rest = line.slice(head[0].length)
        if (rest.trim() !== '') messageLines.push(rest)
      }
      continue
    }
    ;(inMessage ? messageLines : droppedLines).push(line)
  }
  const droppedText = droppedLines.join('\n').trim()
  return {
    listing: listingRaw === null ? null : parseCallPlan(listingRaw),
    listingRaw: listingRaw ?? '',
    listingPresent: listingRaw !== null,
    message: messageLines.join('\n').trim(),
    droppedText,
    droppedChars: droppedText.length,
    brokenToolBlocks: (text.match(/\{\{tool/g) ?? []).length,
  }
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

/**
 * M22 — the contract's plan, as the listing announces it. Pur et tolérant
 * aux petites variations (espaces, « appels », tirets, majuscules) — but
 * the header itself must have been exact.
 */
export type CallPlan = { kind: 'calls'; count: number; titles: readonly string[] } | { kind: 'no_tool' }

/** Parses the CONTENT of a [TOOL_LISTING] line — null when unreadable. */
export function parseCallPlan(content: string): CallPlan | null {
  if (content.trim() === '') return null
  const rest = content.trim()
  if (/no[\s_-]*tool/i.test(rest)) return { kind: 'no_tool' }
  const n = rest.match(/\d+/)
  if (n === null) return null // annonce présente mais illisible — traitée comme absente
  const titles = [...rest.matchAll(/\[([^\]]*)\]/g)].map((t) => t[1]!.trim()).filter((t) => t !== '')
  return { kind: 'calls', count: Number.parseInt(n[0]!, 10), titles }
}

/** Compact render of a plan, for the reminder lines. */
function planLabel(plan: CallPlan): string {
  return plan.kind === 'no_tool'
    ? `${TOOL_LISTING_HEADER} no_tool`
    : `${TOOL_LISTING_HEADER} ${plan.count} tool_calls${plan.titles.length > 0 ? ` — ${plan.titles.map((t) => `[${t}]`).join(' ')}` : ''}`
}

/** Compact display of a call for the reminder lines. */
function callLabel(c: RoundToolCall): string {
  const target = targetOfArgs(c.args)
  if (target !== '') return `${c.tool} « ${target} »`
  // Malformed args: the RAW string is the target — it says what broke.
  if (!c.argsOk && c.rawArgs !== '') return `${c.tool} « ${c.rawArgs.slice(0, 40)} »`
  return c.tool
}

/**
 * M23 — the PRE-TASK BRIEFING, parsed from the round-1 thinking: the
 * EXIGENCE: line (level, required skills, ICM state). Tolerant — anywhere
 * in the thinking, any case, spaced or not — because the check must catch
 * the model that forgot it, not punish the one that wrote it slightly
 * differently. Returns the line's CONTENT (after the prefix), '' when the
 * line is present but empty, null when absent.
 */
export function parseAssessment(thinking: string): string | null {
  for (const line of thinking.split('\n')) {
    // Audit — tolérance markdown : **EXIGENCE**, __EXIGENCE__, > EXIGENCE,
    // - EXIGENCE… le marqueur doit être attrapé, pas puni pour sa mise en
    // forme (les modèles gras-sent souvent leurs en-têtes). Le lookahead
    // (et non \b) laisse passer le souligné de __EXIGENCE__.
    const m = line.match(/^\s*[>#\s-]*(?:\*\*|__)?exIGENCE(?![A-Za-z0-9À-ÿ])(?:\*\*|__)?[\s:*_-]*(.*)$/i)
    if (m !== null) return m[1]!.trim().slice(0, 300)
  }
  return null
}

/**
 * M23 — L'ANTI-RENONCEMENT : detects the identity-level capitulation the
 * pilot reported (« le modèle dit qu'il n'est pas programmé pour faire ce
 * type de chose »). These are NOT local impossibilities (« je ne peux pas
 * lire ce fichier binaire » is honest) — they are wholesale refusals of
 * what the agent IS: programmed for exactly this harness, with ten real
 * tools, an ICM and a work folder. Returns the matched snippet for the
 * feedback to quote, null when the prose holds no capitulation.
 *
 * La classe `[\wÀ-ÿ]` couvre les accents français (programmé, conçu,
 * capacité…) que `\w` ASCII ignore ; les deux apostrophes (' et ') sont
 * admises partout où le français s'écrit.
 *
 * Audit — resserrage des faux positifs remontés : (1) les patterns 1-2
 * exigent un sujet à la PREMIÈRE PERSONNE — « xargs n'a pas été conçu
 * pour parser du JSON » est une limite d'outil honnête, pas un
 * renoncement ; (2) « autorisé » a quitté le pattern 1 : après un refus
 * d'approbation du pilote, « je ne suis pas autorisé à écrire ici » est
 * l'ÉTAT réel, le contester serait faux ; (3) le lexème « conçu » est
 * fermé (con[çc]u…) pour ne plus attraper « concerné ».
 */
const CAPITULATION_PATTERNS: readonly RegExp[] = [
  /je\s+(?:ne\s+|n['’]\s*)?(?:suis|serais|étais)\s+pas\s+(?:un\s+|une\s+)?(?:programm[\wÀ-ÿ]*|con[çc]u[\wÀ-ÿ]*|fait[\wÀ-ÿ]*)/i,
  /je\s+(?:ne\s+|n['’]\s*)?(?:suis|serais|étais|ai|avais)\s+(?:pas|jamais)\s+(?:été\s+)?(?:programm[\wÀ-ÿ]*|con[çc]u[\wÀ-ÿ]*|fait[\wÀ-ÿ]*)\s+(?:pour|à)/i,
  /je\s+(?:ne\s+|n['’]\s*)?(?:suis|serais)\s+qu['’](?:un|une)\s+(?:[\wÀ-ÿ]+\s+){0,2}?(?:mod[eè]le|IA|intelligence|chatbot|assistant\s+basique)/i,
  /en\s+tant\s+qu(?:e\b|['’])?\s*(?:une?\s+)?(?:IA|mod[eè]le(?:\s+de\s+langage)?|intelligence\s+artificielle)\b[^.\n]{0,120}?\b(?:je\s+ne\s+peux|je\s+n['’]arrive|je\s+ne\s+sais\s+pas|je\s+ne\s+suis\s+pas\s+capable|incapable|impossible)/i,
  /(?:hors|au[- ]delà|en\s+dehors)\s+(?:de\s+)?(?:ma|mes)\s+(?:port[\wÀ-ÿ]*|capacit[\wÀ-ÿ]*|comp[ée]tences|possibilit[\wÀ-ÿ]*|fonctions|attributions)/i,
  /impossible\s+(?:pour\s+moi|de\s+ma\s+part)/i,
  /(?:il\s+)?m['’]est\s+impossible/i,
  /je\s+(?:ne\s+|n['’]\s*)?ai\s+pas\s+(?:la|les)\s+(?:capacit[\wÀ-ÿ]*|comp[ée]tence|autorisation|possibilit[ée])\s+(?:de\s|d['’]|pour)/i,
  /je\s+(?:ne\s+|n['’]\s*)?(?:suis|serais)\s+pas\s+(?:en\s+mesure|capable)\s+de\s+(?:faire|réaliser|realiser|créer|creer|gérer|gerer|écrire|ecrire)/i,
]

/** The matched capitulation snippet (≤ 90 chars), or null. */
export function detectCapitulation(text: string): string | null {
  if (text.trim() === '') return null
  for (const re of CAPITULATION_PATTERNS) {
    const m = re.exec(text)
    if (m !== null) {
      const from = Math.max(0, m.index - 10)
      return text.slice(from, from + 90).replace(/\s+/g, ' ').trim()
    }
  }
  return null
}

/**
 * M23 — the note that answers a capitulation: the model control the pilot
 * asked for. It quotes the offending snippet, states what the agent IS
 * (programmed for exactly this work), and re-teaches the professional
 * move — estimate (EXIGENCE), navigate the ICM, build the missing skill,
 * act — with the honest exception: a REAL blocker is named precisely,
 * never renounced vaguely.
 */
export function capitulationNote(snippet: string): string {
  return [
    `${FEEDBACK_HEADER}] Ta réponse déclare ne pas être programmée ou capable de ce travail : « ${snippet} ».`,
    `C'est FAUX dans ce harness : tu es l'agent NyWorkflow, programmé pour EXACTEMENT ce travail — dix outils réels (read, write, ls, glob, mkdir, shell, websearch, shell_output, shell_kill, no_tool), une ICM vivante et un dossier de travail sur la machine du pilote.`,
    `Une information qui manque se CHERCHE (websearch, read) ; une compétence qui manque se CONSTRUIT (skills/) ; un outillage qui manque se FABRIQUE (shell, write). Reprends le travail : ${ASSESSMENT_EXAMPLE}, navigue ton ICM, construis le manque, agis.`,
    `Si un blocage RÉEL existe, nomme-le précisément — quoi, pourquoi, ce que tu as tenté et ce qu'il faudrait pour le lever — jamais un renoncement vague.`,
  ].join('\n')
}

function targetOfArgs(args: Record<string, unknown>): string {
  for (const key of ['path', 'pattern', 'command', 'query', 'url', 'jobId', 'reason']) {
    const v = args?.[key]
    if (typeof v === 'string' && v !== '') return v
  }
  return ''
}

/**
 * The nudge for a round that produced NOTHING (no text, no calls) — the
 * "missed tool_calls" case: the turn would otherwise end on an empty
 * answer. Nudged ONCE per turn, then the turn ends honestly.
 */
export const EMPTY_RESPONSE_NUDGE =
  `${FEEDBACK_HEADER}] Ta dernière réponse était VIDE : ni texte, ni tool_calls. ` +
    'Reprends le protocole cinq phases — <thinking title="…">…</thinking>, puis [TOOL_LISTING] (N appels ou no_tool), ' +
    'puis [MESSAGE] avec ta prose, puis les blocs {{tool …}}. Une réponse vide n’est jamais une réponse.'

/** no_tool was emitted WITHOUT the final prose it must accompany:
 * nudged once, then the turn ends honestly. */
export const NO_TOOL_EMPTY_PROSE_NUDGE =
  `${FEEDBACK_HEADER}] Tu as émis no_tool SANS la prose finale : l’appel no_tool ACCOMPAGNE ta réponse au pilote ` +
    'dans la MÊME réponse — thinking titré, [TOOL_LISTING] no_tool, [MESSAGE] avec la prose, puis l’appel no_tool. ' +
    'Écris maintenant cette réponse finale.'

/**
 * M22 — the UNSIGNED final: prose (even well-headered) without the no_tool
 * signature does NOT end a turn. The model must wait for the harness's
 * feedback — and the feedback asks for the signature.
 */
export const UNSIGNED_FINAL_NUDGE =
  `${FEEDBACK_HEADER}] Ta réponse finale n’est pas SIGNÉE : le protocole exige ${TOOL_LISTING_HEADER} no_tool, ` +
    `puis ${MESSAGE_HEADER} avec ta prose, puis l’appel unique no_tool. Une prose seule ne termine jamais un tour — ` +
    'réémets la réponse complète, signée, ou continue le travail avec de vrais appels.'

/** The five phases, as the feedback's tail teaches them back. */
const PROTOCOL_TAIL =
  'Reprends le protocole cinq phases : <thinking title="…">…</thinking>, puis [TOOL_LISTING] N tool_calls — [Titres] ' +
    '(ou [TOOL_LISTING] no_tool), puis [MESSAGE] (ta prose au pilote, AVANT les appels), puis un bloc {{tool {…} }} par appel. ' +
    'Le harness exécute le groupe et te répond — c’est son feedback qui décide de la suite.'

/**
 * The feedback engine's verdict on ONE round: null when every phase held
 * (a compliant model is never nagged), the reminder text otherwise. Pure:
 * same round, same reminder, byte for byte. M22 — the header is the phase-5
 * one, and the verdict lists the DROPS (headerless prose, malformed blocks,
 * broken contract) alongside the mentor's form deviations.
 */
export function protocolFeedback(
  ctx: RoundProtocol,
  memory: ProtocolMemory,
  icmContextPaths: readonly string[],
): string | null {
  const lines = protocolLines(ctx, memory, icmContextPaths)
  if (lines.length === 0) return null
  return [`${FEEDBACK_HEADER}, round ${ctx.round}]`, ...lines.map((l) => `- ${l}`), PROTOCOL_TAIL].join('\n')
}

/**
 * M21/M22 — the REDO note: the group did NOT hold its contract, the harness
 * did NOT execute it. The model must re-read what it did and re-emit the
 * complete group. All the round's other deviations ride along (one note,
 * not two).
 */
export function planRedoNote(round: number, lines: readonly string[]): string {
  return [
    `${FEEDBACK_HEADER}, round ${round}]`,
    ...lines.map((l) => `- ${l}`),
    `Ce groupe d’appels n’a PAS été exécuté (contrat non tenu : le listing et le groupe émis ne coïncident pas). ` +
      `Relis ce que tu as fait, relis ton ${TOOL_LISTING_HEADER}, puis RÉÉMETS le groupe complet : le nombre d’appels annoncé, ` +
      `chacun dans son bloc — format exact : ${TOOL_CALL_FORMAT} — la logique du tour reprendra proprement.`,
  ].join('\n')
}

/** The feedback engine's bullet lines for one round — pure, exported for the
 * redo note: same deviations, two wrappings. */
export function protocolLines(
  ctx: RoundProtocol,
  memory: ProtocolMemory,
  icmContextPaths: readonly string[],
): string[] {
  const lines: string[] = []
  const calls = ctx.toolCalls
  const phases = ctx.phases
  const plan = phases.listing
  const realCalls = calls.filter((c) => c.tool !== 'no_tool')
  const hasNoTool = calls.some((c) => c.tool === 'no_tool')
  const onlyNoTool = hasNoTool && realCalls.length === 0

  // PHASE 1 — the titled thinking OPENS every response (the logs' most
  // frequent violation).
  if (ctx.firstEvent !== 'thinking' && (calls.length > 0 || ctx.text.trim() !== '' || ctx.thinkingChars > 0)) {
    const began =
      ctx.firstEvent === 'text' ? 'du texte visible' : ctx.firstEvent === 'tool_calls' ? 'des tool_calls' : 'rien'
    lines.push(
      `Ta réponse doit S’OUVRIR par un bloc <thinking title="…">…</thinking> — ce round-ci, elle a commencé par ${began}.`,
    )
  } else if (ctx.thinkingChars > 0 && ctx.thinkingTitles.length === 0) {
    lines.push('Ton bloc thinking n’a pas de title — donne-lui un titre court (« Comprendre la demande »…).')
  }

  // M23 — LE BRIEFING : au PREMIER round du tour, le thinking porte la ligne
  // EXIGENCE (niveau d'exigence, skills nécessaires, état de l'ICM) — le
  // modèle ne « travaille jamais simplement », il estime AVANT d'agir. La
  // ligne manque → le feedback la réclame avec le gabarit exact. Round 2+ :
  // l'estimation est faite, on ne sermonne pas deux fois.
  if (ctx.round === 1 && ctx.thinkingChars > 0 && parseAssessment(ctx.thinking) === null) {
    lines.push(
      `Le thinking de ce premier round doit s’ouvrir par la ligne de BRIEFING — ${ASSESSMENT_EXAMPLE} — le niveau d’exigence et les skills nécessaires à la tâche, puis l’état de ton ICM : estime AVANT d’agir, ne travaille jamais « simplement ».`,
    )
  }

  // PHASE 2 — LE LISTING ENGAGE LE GROUPE : l'en-tête [TOOL_LISTING] précède
  // les appels, le groupe émis doit le tenir. (Le refus pur et simple du
  // groupe est décidé par la boucle : ces lignes documentent l'écart.)
  if (calls.length > 0 && !onlyNoTool) {
    if (!phases.listingPresent) {
      lines.push(
        `Ta section ${TOOL_LISTING_HEADER} est absente — elle annonce le contrat AVANT les appels : ${TOOL_LISTING_HEADER} 3 tool_calls — [Titre A] [Titre B] [Titre C] (ou ${TOOL_LISTING_HEADER} no_tool avant la prose finale).`,
      )
    } else if (plan === null) {
      lines.push(
        `Ton ${TOOL_LISTING_HEADER} est illisible — compte attendu : ${TOOL_LISTING_HEADER} 2 tool_calls — [Titre A] [Titre B].`,
      )
    } else if (plan.kind === 'no_tool') {
      lines.push(
        `Tu as annoncé ${TOOL_LISTING_HEADER} no_tool puis émis ${realCalls.length} tool_call${realCalls.length > 1 ? 's' : ''} — l’un ou l’autre : no_tool s’émet SEUL, en fin de tour, sans autre appel.`,
      )
    } else {
      if (hasNoTool) {
        lines.push('`no_tool` est mélangé à de vrais appels — il s’émet SEUL, jamais dans un groupe de travail.')
      }
      if (plan.count !== realCalls.length) {
        lines.push(
          `Ton listing annonçait ${plan.count} tool_call${plan.count > 1 ? 's' : ''} et tu en as émis ${realCalls.length} — le compte annoncé et le groupe émis doivent coïncider EXACTEMENT.`,
        )
      }
      if (plan.titles.length === 0 && realCalls.length > 0) {
        lines.push(`Ton ${TOOL_LISTING_HEADER} ne liste pas les titres — « ${TOOL_LISTING_HEADER} 2 tool_calls — [Titre A] [Titre B] » les porte entre crochets.`)
      }
    }
  }

  // PHASE 4 — tool_calls hygiene: titles, strict JSON args, known tools.
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

  // PHASE 3/4 — LES DROPS M22 : la prose sans en-tête n'est jamais affichée ;
  // les blocs d'appel mal formés ne sont jamais décodés. Le feedback les
  // liste TOUS — c'est la règle du pilote : le modèle apprend ce qui a été
  // droppé et pourquoi, la logique du tour ne casse pas.
  if (phases.droppedChars > 0) {
    lines.push(
      `${phases.droppedChars} caractères de prose sans en-tête ${MESSAGE_HEADER} ont été DROPPÉS (jamais affichés au pilote) — la prose au pilote vit dans la section ${MESSAGE_HEADER}, AVANT les appels.`,
    )
  }
  if (phases.brokenToolBlocks > 0) {
    lines.push(
      `${phases.brokenToolBlocks === 1 ? '1 bloc d’appel mal formé a été' : `${phases.brokenToolBlocks} blocs d’appel mal formés ont été`} DROPPÉ${phases.brokenToolBlocks > 1 ? 'S' : ''} (non décodés, non exécutés) — format exact d’un appel : ${TOOL_CALL_FORMAT}`,
    )
  }

  // Redundancy — the « hi » lesson: `ls .` three times, identical results.
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
