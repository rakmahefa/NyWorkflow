// Maquette gemini-web2api pour les tests e2e et la capture README :
// OpenAI-compatible, SSE inclus, sans aucune dépendance.
// M11 : la maquette parle AUSSI le namespace v1beta (l'app y va par défaut)
// — /v1beta/models au format Google, /v1beta/chat/completions en OpenAI —
// et scénarise des tool_calls standards quand la requête porte des tools.
// M12 : PARALLÈLE (deux appels en un tour), ARRIÈRE-PLAN (shell background),
// SUIVIJOB (shell_output avec le jobId lu dans les résultats d'outils)
// et la réflexion (PENSE → delta.reasoning_content avant le texte).
// M15 : le protocole deux temps — chaque réponse commence par un bloc
// <thinking title="…">…</thinking> DANS LE CONTENU (le canal natif
// reasoning_content reste pour PENSE), et chaque tool_call porte son
// argument `title` (PROTOCOLITRE vérifie le tout de bout en bout).
// M22 : LE PROTOCOLE CINQ PHASES — thinking titré, puis la section
// [TOOL_LISTING] N tool_calls — [titres] (ou no_tool) en première ligne
// visible, puis [MESSAGE] pour la prose, puis les appels (delta.tool_calls
// standard). TOUTE réponse finale est SIGNÉE (listing no_tool + [MESSAGE]
// + l'appel unique no_tool) : la maquette est conforme par défaut ; les
// scénarios déviants (AGENTNONCONFORME, AGENTCOMPTEFAUX, AGENTMALFORME)
// lèvent les écarts que le feedback engine du harness corrige au round
// suivant (variante fixed) — le vrai modèle corrige, la maquette aussi.
import { createServer } from 'node:http'

// Réponse « réelle » quand on demande une présentation du projet.
const FIXED_REPLY =
  "NyWorkflow charge l'ICM du workspace (arbre + CONTEXT.md) vers le modèle, et l'agent agit avec ses outils — read, write, ls, glob, mkdir, shell, websearch."

// La signature M22 d'une réponse finale sans outil, en tête du texte visible.
const NO_TOOL_LISTING = '[TOOL_LISTING] no_tool\n\n[MESSAGE]\n'

// Scénarios agentiques (M11) : le DERNIER message utilisateur porte un
// marqueur ; la maquette émet le tour d'outils M22. Au tour suivant (un
// rôle tool dans l'historique), elle répond par la prose finale SIGNÉE.
const TOOL_SCENARIOS = {
  AGENTLIT: {
    name: 'read',
    arguments: { title: 'Lire la carte du workspace', path: '.workspace/CONTEXT.md' },
    final: 'LIVRABLE FINAL AGENT — la carte est lue.',
  },
  // M20/M21/M22 — le scénario NON CONFORME, calqué sur les écarts des logs
  // réels : thinking sauté, appel sans titre, listing absent (l'en-tête
  // [TOOL_LISTING] manquant). Il déclenche le REFUS du groupe (le contrat
  // d'appels de l'app), qui renvoie la note [HARNESS — feedback] au round
  // suivant — la maquette se CORRIGE alors (variante fixed) et le test e2e
  // m20 vérifie le rappel SUR LE FIL, dans l'UI et dans model.jsonl.
  AGENTNONCONFORME: {
    name: 'ls',
    arguments: { path: '.' },
    noThinking: true,
    noListing: true,
    final: 'NONCONFORME FAIT — la racine est listée, sans protocole.',
    fixed: {
      thinkTitle: 'Reprendre le protocole',
      thinkBody: 'Correction du feedback : thinking titré, listing conforme.',
      listing: '[TOOL_LISTING] 1 tool_calls — [Lister la racine]',
      arguments: { title: 'Lister la racine', path: '.' },
    },
  },
  // M21/M22 — le contrat tenu sans outil : la réponse finale est SIGNÉE —
  // listing no_tool, prose dans [MESSAGE], appel unique no_tool (l'exception
  // assumée du protocole — rien à attendre).
  AGENTSANSTOOL: {
    name: 'no_tool',
    arguments: { title: 'Réponse finale sans outil', reason: 'La présentation ne nécessite aucun outil' },
    thinkTitle: 'Répondre sans outil',
    thinkBody: 'Rien à lire ni écrire : je réponds directement.',
    message: 'SANSTOOL RÉPONDU — la présentation sans aucun appel réel.',
    final: 'SANSTOOL RÉPONDU — la présentation sans aucun appel réel.',
  },
  // M21/M22 — le compte annoncé ≠ groupe émis (annoncé 2, émis 1) : le
  // groupe est REFUSÉ, puis réémis conforme après le feedback (variante fixed).
  AGENTCOMPTEFAUX: {
    name: 'ls',
    arguments: { title: 'Lister la racine', path: '.' },
    thinkTitle: 'Planifier le listing',
    thinkBody: 'Deux appels prévus — mais un seul partira.',
    listing: '[TOOL_LISTING] 2 tool_calls — [Lister la racine] [Relire la charte]',
    final: 'COMPTE CORRIGÉ — le groupe annoncé est enfin émis.',
    fixed: {
      thinkTitle: 'Reprendre le plan',
      thinkBody: 'Relu : le listing seul suffit.',
      listing: '[TOOL_LISTING] 1 tool_calls — [Lister la racine]',
    },
  },
  // M22 — le bloc d'appel MAL FORMÉ : la maquette écrit un {{tool …}} cassé
  // dans le TEXTE (jamais décodé, jamais exécuté) — le feedback engine le
  // signale avec le FORMAT EXACT, et la variante fixed réémet un vrai bloc.
  AGENTMALFORME: {
    name: 'ls',
    arguments: { title: 'Lister la racine', path: '.' },
    thinkTitle: 'Tenter l’appel',
    thinkBody: 'Je liste la racine.',
    brokenBlocks: ['{{tool {"name": "ls", "arguments": {"path": "."}'],
    final: 'MALFORMÉ CORRIGÉ — le bloc réémis au format exact.',
    fixed: {
      thinkTitle: 'Corriger le format',
      thinkBody: 'Le format exact d’un bloc : {{tool {"name": …, "arguments": {…} }}.',
    },
  },
  // M22 — la prose SANS en-tête [MESSAGE] : droppée de l'affichage, le
  // feedback le dit ; la variante fixed replace la prose dans [MESSAGE].
  AGENTPROSEPERDUE: {
    name: 'ls',
    arguments: { title: 'Lister la racine', path: '.' },
    thinkTitle: 'Parler sans en-tête',
    thinkBody: 'Je liste, et je cause à côté.',
    listing: '[TOOL_LISTING] 1 tool_calls — [Lister la racine]',
    strayText: 'Une prose perdue hors section — jamais affichée au pilote.',
    final: 'PROSE REPLACÉE — le message vit dans [MESSAGE].',
    fixed: {
      thinkTitle: 'Reprendre le protocole',
      thinkBody: 'La prose au pilote vit dans [MESSAGE].',
      message: 'La prose, maintenant en-têtée.',
    },
  },
  // M22 — la prose SANS signature (ni listing no_tool, ni appel) : le tour
  // ne se termine PAS — le feedback engine réclame la signature, la
  // maquette signe alors (variante fixed) : le harness décide de la suite.
  AGENTNONSIGNE: {
    unsigned: true,
    thinkTitle: 'Répondre directement',
    thinkBody: 'Je réponds sans signer.',
    final: 'NONSIGNÉ CORRIGÉ — la réponse est signée à présent.',
    fixed: { thinkTitle: 'Signer la fin', thinkBody: 'Listing no_tool, [MESSAGE], puis l’appel no_tool.', unsigned: false },
  },
  // M23 — LE RENONCEMENT : la maquette déclare qu’elle n’est « pas programmée
  // pour ce type de chose » (le retour du pilote sur le modèle réel) — le
  // model control la DÉTECTE, refuse la fin de tour et renvoie la note
  // d’identité ; la variante fixed REPREND le travail (briefing compris).
  AGENTRENONCE: {
    unsigned: true,
    thinkTitle: 'Répondre au pilote',
    thinkBody: 'Cette demande dépasse ce que je sais faire.',
    final: 'Je ne suis pas programmé pour faire ce type de chose. En tant qu’IA, je ne peux pas créer un projet complet.',
    fixed: {
      thinkTitle: 'Reprendre le travail',
      thinkBody: 'EXIGENCE: exigeante — skills: python, packaging — ICM: riche (chargée ce tour). Le feedback a raison : je construis.',
      unsigned: false,
      final: 'RENONCE CORRIGÉ — le travail est fait, vérifié et livré.',
    },
  },
  // M23 — LE BRIEFING MANQUANT : le thinking du premier round n’ouvre PAS
  // par la ligne EXIGENCE — le feedback la réclame avec le gabarit exact.
  AGENTBRIEFING: {
    name: 'ls',
    arguments: { title: 'Lister la racine', path: '.' },
    thinkTitle: 'Agir sans estimer',
    thinkBody: 'Je liste la racine directement.',
    noBriefing: true,
    final: 'BRIEFING NOTÉ — l’exigence sera estimée avant d’agir.',
  },
  AGENTECRIT: {
    name: 'write',
    arguments: { title: 'Écrire le livrable', path: 'outputs/agent-e2e.md', content: 'CONTENU AGENT E2E' },
    final: 'ECRITURE FAITE — outputs/agent-e2e.md.',
  },
  AGENTDOSSIER: {
    name: 'mkdir',
    arguments: { title: 'Préparer le dossier', path: 'research/e2e-dossier' },
    final: 'DOSSIER CRÉÉ — research/e2e-dossier.',
  },
  AGENTPARALLELE: {
    twoCalls: [
      { name: 'read', arguments: { title: 'Lire la carte', path: '.workspace/CONTEXT.md' } },
      { name: 'ls', arguments: { title: 'Lister la racine', path: '.' } },
    ],
    final: 'PARALLÈLE FAIT — deux lectures en un tour.',
  },
  AGENTARRIEREPLAN: {
    name: 'shell',
    arguments: { title: 'Lancer la veille en arrière-plan', command: 'sleep 3 && echo bg-e2e', background: true },
    final: 'ARRIERE-PLAN LANCE — suis-le.',
  },
  AGENTPROTOCOL: {
    twoCalls: [
      { name: 'read', arguments: { title: 'Relire la charte', path: '.workspace/CONTEXT.md' } },
      { name: 'glob', arguments: { title: 'Cartographier les notes', pattern: '**/*.md' } },
    ],
    thinkTitle: 'Planifier le tour',
    thinkBody: 'Deux lectures indépendantes — je les lance ensemble.',
    message: 'Je relis la charte et cartographie les notes.',
    final: 'PROTOCOLE CINQ PHASES — thinking, listing, message, appels, feedback.',
  },
}

function scenarioFor(messages) {
  // M20 — le feedback du harness parle AUSSI en rôle user (préfixe
  // [HARNESS — feedback]) : ce n'est pas le pilote. Le marqueur de
  // scénario vit dans le dernier message utilisateur du PILOTE — les
  // feedbacks du harness s'ignorent ici (une maquette ne « lit » pas, elle
  // pattern-matche ; le vrai modèle, lui, corrige — c'est le but).
  const users = (messages ?? []).filter((m) => m?.role === 'user')
  const lastUser = [...users].reverse().find((m) => typeof m?.content === 'string' && !m.content.startsWith('[HARNESS — '))?.content
  const text = typeof lastUser === 'string' ? lastUser : ''
  // M21/M22 — le harness a parlé (feedback engine ou refus de contrat) :
  // la maquette émet la variante CONFORME du scénario (fixed) — le vrai
  // modèle corrige, la maquette aussi.
  const harnessSpoke = (messages ?? []).some(
    (m) => m?.role === 'user' && typeof m?.content === 'string' && m.content.startsWith('[HARNESS — '),
  )
  for (const [marker, sc] of Object.entries(TOOL_SCENARIOS)) {
    if (text.includes(marker)) {
      return harnessSpoke && sc.fixed ? { marker, ...sc, noThinking: false, noListing: false, ...sc.fixed } : { marker, ...sc }
    }
  }
  // SUIVIJOB : shell_output sur le jobId rendu par un arrière-plan précédent
  // — le jobId vit dans les résultats d'outils de TOUT l'historique (le
  // lancement appartient au tour précédent, avant le dernier message).
  if (text.includes('SUIVIJOB')) {
    const jobJson = JSON.stringify((messages ?? []).filter((m) => m?.role === 'tool').map((m) => m?.content ?? ''))
    const m = jobJson.match(/job-[a-z0-9-]+/)
    if (m) return { marker: 'SUIVIJOB', name: 'shell_output', arguments: { title: 'Suivre le job en arrière-plan', jobId: m[0] }, final: 'SUIVI FAIT — le job est visible.' }
  }
  return null
}

function replyBody(lastUser) {
  const t = String(lastUser ?? '').toLowerCase()
  if (t.includes('nyworkflow') || t.includes('présente') || t.includes('presente')) {
    return FIXED_REPLY
  }
  return String(lastUser ?? '').slice(0, 80)
}

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

let chatCount = 0
// M20 — les requêtes chat reçues (les messages, seuls) : le test e2e du
// mentor y vérifie que le feedback [HARNESS — feedback] est bien PARTI au
// round suivant d'un écart — fenêtre bornée, mémoire bornée.
const recorded = []
const RECORDED_MAX = 40

/**
 * Starts the mock gateway on 127.0.0.1:<port>.
 * GET / (diagnostic M8+M9), GET /v1/models (OpenAI), GET /v1beta/models
 * (Google — comme la passerelle réelle), POST /v1/chat/completions et
 * POST /v1beta/chat/completions (SSE, tools compris).
 */
export function startMockGateway(port) {
  const server = createServer((req, res) => {
    const url = req.url ?? ''

    // M20 — les requêtes enregistrées, pour le test e2e du mentor.
    if (req.method === 'GET' && url === '/__requests') {
      json(res, 200, { requests: recorded })
      return
    }

    // Diagnostic GET / — la forme de la passerelle webapi réelle (M8 + M9).
    if (req.method === 'GET' && (url === '/' || url === '')) {
      const nowSec = Math.floor(Date.now() / 1000)
      const recent = []
      if (chatCount > 0) {
        recent.push({
          at: new Date(Date.now() - 60_000).toISOString(),
          model: 'gemini-2.5-flash',
          ok: false,
          attempts: 2,
          ms: 1200,
          account: 0,
          error: { kind: 'authentication', message: 'Cookies expirés (maquette)', status: 401 },
        })
        recent.push({
          at: new Date(Date.now() - 1_000).toISOString(),
          model: 'gemini-2.5-flash',
          ok: true,
          attempts: 1,
          ms: 30,
          account: 0,
        })
      }
      json(res, 200, {
        status: 'ok',
        version: 'maquette-e2e',
        provider: 'gemini',
        defaultModel: 'gemini-2.5-flash',
        models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
        gateway: {
          cookies: true,
          bl: null,
          cookieFile: '(maquette e2e)',
          rawCookies: false,
          accounts: [
            { file: '(maquette e2e)', cookies: true, authUser: 0, label: 'Perso', expiresAt: nowSec + 12 * 86_400 },
            { file: '(maquette e2e) 2', cookies: false, authUser: 1, label: 'Pro', expiresAt: nowSec - 3 * 86_400 },
          ],
          activeAccount: 0,
          authUser: 0,
          accountUsage: [
            { account: 0, turns: 2, ok: 1, failed: 1, lastAt: new Date(Date.now() - 1_000).toISOString(), totalMs: 1230 },
          ],
          proxy: null,
          recent,
        },
      })
      return
    }

    // Modèles — les DEUX formes, comme la passerelle réelle (M10/M11).
    if (req.method === 'GET' && url === '/v1/models') {
      json(res, 200, { data: [{ id: 'gemini-2.5-flash' }, { id: 'gemini-2.5-pro' }] })
      return
    }
    if (req.method === 'GET' && url === '/v1beta/models') {
      json(res, 200, {
        models: [
          { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] },
          { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] },
        ],
      })
      return
    }

    // Chat — les DEUX namespaces servent le même moteur (M11).
    if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1beta/chat/completions')) {
      chatCount++
      let body = ''
      req.on('data', (c) => {
        body += c
      })
      req.on('end', () => {
        let parsed = {}
        try {
          parsed = JSON.parse(body)
        } catch {
          parsed = {}
        }
        // M20 — enregistrement (messages seuls, fenêtre bornée).
        recorded.push({ at: new Date().toISOString(), messages: parsed.messages ?? [] })
        if (recorded.length > RECORDED_MAX) recorded.splice(0, recorded.length - RECORDED_MAX)
        const model = typeof parsed.model === 'string' ? parsed.model : 'unknown'
        const messages = parsed.messages ?? []
        let lastUserIdx = -1
        for (let i = messages.length - 1; i >= 0; i--) {
          const c = messages[i]?.content
          // M20 — les feedbacks du harness ([HARNESS — …]) ne sont pas des
          // messages du pilote : ils ne comptent ni comme « dernier
          // utilisateur », ni pour l'écho de réponse.
          if (messages[i]?.role === 'user' && typeof c === 'string' && !c.startsWith('[HARNESS — ')) {
            lastUserIdx = i
            break
          }
        }
        const lastUser = messages[lastUserIdx]?.content
        // Un résultat d'outil ne compte que s'il suit LE dernier message
        // utilisateur (le tour en cours) — pas ceux des tours passés.
        const hasToolResult = messages.slice(lastUserIdx + 1).some((m) => m?.role === 'tool')
        const toolsActive = Array.isArray(parsed.tools) && parsed.tools.length > 0
        const scenario = toolsActive ? scenarioFor(messages) : null

        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        const write = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
        const chunk = (delta, finish = null) =>
          write({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })
        const noToolCall = (i = 0) =>
          chunk({
            tool_calls: [
              {
                index: i,
                id: `call-e2e-${i}`,
                type: 'function',
                function: {
                  name: 'no_tool',
                  arguments: JSON.stringify({ title: 'Réponse finale sans outil', reason: 'Le travail du tour est terminé' }),
                },
              },
            ],
          })

        // M22 — le tour d'appels : thinking titré (1), [TOOL_LISTING] (2),
        // [MESSAGE] optionnel (3), les appels (4). Le feedback (5) viendra
        // du harness — jamais de la maquette. (Un scénario SANS appels —
        // AGENTNONSIGNE — passe direct à la branche finale : sa prose y est
        // signée, ou pas : le feedback réclamera la signature.)
        const hasCalls = scenario !== null && (scenario.name !== undefined || scenario.twoCalls !== undefined)
        if (scenario !== null && hasCalls && !hasToolResult && scenario.unsigned !== true) {
          chunk({})
          const calls = scenario.twoCalls ?? (scenario.name ? [scenario] : [])
          if (!scenario.noThinking) {
            const title = scenario.thinkTitle ?? 'Agir sur le workspace'
            const body = scenario.thinkBody ?? 'Je lance les actions de ce tour.'
            // M23 — le BRIEFING ouvre le thinking du PREMIER round du tour
            // (ligne EXIGENCE) ; le scénario déviant (noBriefing) l’omet —
            // le feedback la réclame au round suivant.
            const briefing = scenario.noBriefing === true ? '' : 'EXIGENCE: standard — skills: workspace — ICM: chargée.\n'
            chunk({ content: `<thinking title="${title}">` })
            chunk({ content: `${briefing}${body}</thinking>` })
          }
          // Phase 2 — le listing, PREMIÈRE ligne visible (auto-généré
          // conforme aux appels émis quand le scénario ne l'écrit pas ;
          // la signature no_tool pour l'unique appel final).
          if (!scenario.noListing) {
            const listing =
              scenario.listing ??
              (calls.length === 1 && calls[0].name === 'no_tool'
                ? '[TOOL_LISTING] no_tool'
                : `[TOOL_LISTING] ${calls.length} tool_calls — [${calls.map((c) => c.arguments?.title ?? c.name).join('] [')}]`)
            chunk({ content: `${listing}\n\n` })
          }
          // Phase 3 — le message optionnel du round (en-têté).
          if (scenario.message !== undefined) chunk({ content: `[MESSAGE]\n${scenario.message}\n\n` })
          // M22 — la prose perdue : hors sections, DROPPÉE par le harness.
          if (scenario.strayText !== undefined) chunk({ content: `${scenario.strayText}\n\n` })
          // M22 — les blocs d'appel MAL FORMÉS : écrits dans le texte, ils
          // ne sont JAMAIS décodés (le scénario déviant) — le feedback
          // engine les signalera avec le format exact.
          for (const broken of scenario.brokenBlocks ?? []) chunk({ content: `${broken}\n\n` })
          calls.forEach((c, i) => {
            chunk({
              tool_calls: [
                {
                  index: i,
                  id: `call-e2e-${i}`,
                  type: 'function',
                  function: { name: c.name, arguments: JSON.stringify(c.arguments) },
                },
              ],
            })
          })
          // M22 — no_tool SEUL : le listing no_tool + la prose [MESSAGE] ont
          // déjà été émis en tête — l'appel signe, le flux se termine.
          if (calls.length === 1 && calls[0].name === 'no_tool') {
            chunk({}, 'stop')
            res.write('data: [DONE]\n\n')
            res.end()
            return
          }
          chunk({}, 'tool_calls')
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }

        // Réflexion (M12) : le marqueur PENSE diffuse un raisonnement avant
        // le texte — dialecte DeepSeek (delta.reasoning_content). C'est le
        // modèle « canal natif » : pas de bloc protocole dans le contenu (le
        // M15 teste le protocole sur TOUTES les autres réponses — deux
        // familles de modèles, deux chemins dans l'UI).
        const userText = typeof lastUser === 'string' ? lastUser : ''
        const nativeThinking = userText.includes('PENSE')
        if (nativeThinking) {
          chunk({ reasoning_content: 'D\u00e9composons la demande… ' })
          chunk({ reasoning_content: 'la r\u00e9ponse s\u2019impose.' })
        } else {
          // M15 — le protocole : le bloc <thinking title="…"> ouvre la
          // réponse DANS LE CONTENU, coupé en plein milieu de la balise (le
          // splitter de l'adaptateur doit le recoudre sans perdre un octet).
          const thinkTitle = scenario?.thinkTitle ?? 'Comprendre la demande'
          const thinkBody = scenario?.thinkBody ?? 'Je passe en revue ce que l\u2019ICM sait déjà.'
          chunk({ content: `<thinking title="${thinkTitle}">` })
          chunk({ content: `${thinkBody}</think` })
          chunk({ content: `ing>` })
        }

        // M22 — réponse finale : SIGNÉE quand les outils sont actifs (le
        // listing no_tool + la prose dans [MESSAGE] + l'appel no_tool qui
        // ferme le flux) ; texte seul sinon (le contrat est suspendu sans
        // outils — la boucle n'en exige aucune signature). AGENTNONSIGNE
        // (unsigned) laisse sa prose nue — le feedback réclamera la signature.
        const text = scenario !== null ? scenario.final : `Réponse (maquette) [${model}] : ${replyBody(lastUser)}`
        const sign = toolsActive && scenario?.unsigned !== true
        chunk({})
        if (sign) chunk({ content: NO_TOOL_LISTING })
        const third = Math.ceil(text.length / 3)
        const parts = [text.slice(0, third), text.slice(third, 2 * third), text.slice(2 * third)]
        let i = 0
        const tick = () => {
          if (res.destroyed) return
          if (i >= parts.length) {
            if (sign) noToolCall()
            chunk({}, 'stop')
            res.write('data: [DONE]\n\n')
            res.end()
            return
          }
          chunk({ content: parts[i++] })
          setTimeout(tick, 30)
        }
        tick()
      })
      return
    }

    json(res, 404, { error: 'not found' })
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}
