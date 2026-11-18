// Maquette gemini-web2api pour les tests e2e et la capture README :
// OpenAI-compatible, SSE inclus, sans aucune dépendance.
// M11 : la maquette parle AUSSI le namespace v1beta (l'app y va par défaut)
// — /v1beta/models au format Google, /v1beta/chat/completions en OpenAI —
// et scénarise des tool_calls standards quand la requête porte des tools.
import { createServer } from 'node:http'

// Réponse « réelle » quand on demande une présentation du projet.
const FIXED_REPLY =
  "NyWorkflow charge l'ICM du workspace (arbre + CONTEXT.md) vers le modèle, et l'agent agit avec ses outils — read, write, ls, glob, mkdir, shell, websearch."

// Scénarios agentiques (M11) : le DERNIER message utilisateur porte un
// marqueur ; la maquette émet un tool_call standard (SSE delta.tool_calls +
// finish_reason "tool_calls"). Au tour suivant (un rôle tool dans
// l'historique), elle répond par le texte final.
// M12 : PARALLÈLE (deux appels en un tour), ARRIÈRE-PLAN (shell background),
// SUIVIJOB (shell_output avec le jobId lu dans les résultats d'outils)
// et la réflexion (PENSE → delta.reasoning_content avant le texte).
// M15 : le protocole deux temps — chaque réponse commence par un bloc
// <thinking title="…">…</thinking> DANS LE CONTENU (le canal natif
// reasoning_content reste pour PENSE), et chaque tool_call porte son
// argument `title` (PROTOCOLITRE vérifie le tout de bout en bout).
const TOOL_SCENARIOS = {
  AGENTLIT: {
    name: 'read',
    arguments: { title: 'Lire la carte du workspace', path: '.workspace/CONTEXT.md' },
    final: 'LIVRABLE FINAL AGENT — la carte est lue.',
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
    final: 'PROTOCOLE TROIS TEMPS — thinking titré, appels groupés et titrés, observation du groupe entier.',
  },
}

function scenarioFor(messages) {
  const lastUser = [...(messages ?? [])].reverse().find((m) => m?.role === 'user')?.content
  const text = typeof lastUser === 'string' ? lastUser : ''
  for (const [marker, sc] of Object.entries(TOOL_SCENARIOS)) {
    if (text.includes(marker)) return { marker, ...sc }
  }
  // SUIVIJOB : shell_output sur le jobId rendu par un arrière-plan précédent
  // — le jobId vit dans les résultats d'outils de TOUT l'historique (le
  // lancement appartient au tour précédent, avant le dernier message).
  if (text.includes('SUIVIJOB')) {
    const jobJson = JSON.stringify((messages ?? []).filter((m) => m?.role === 'tool').map((m) => m?.content ?? ''))
    const m = jobJson.match(/job-[a-z0-9-]+/)
    if (m) return { marker: 'SUIVIJOB', name: 'shell_output', arguments: { jobId: m[0] }, final: 'SUIVI FAIT — le job est visible.' }
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

/**
 * Starts the mock gateway on 127.0.0.1:<port>.
 * GET / (diagnostic M8+M9), GET /v1/models (OpenAI), GET /v1beta/models
 * (Google — comme la passerelle réelle), POST /v1/chat/completions et
 * POST /v1beta/chat/completions (SSE, tools compris).
 */
export function startMockGateway(port) {
  const server = createServer((req, res) => {
    const url = req.url ?? '/'

    // Diagnostic GET / — la forme de la passerelle webapi réelle (M8 + M9) :
    // comptes avec session /u/N et expiration, stats par compte, proxy,
    // journal amont (déterministe : un échec ancien typé + un tour réussi
    // par conversation réellement servie).
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
        const model = typeof parsed.model === 'string' ? parsed.model : 'unknown'
        const messages = parsed.messages ?? []
        let lastUserIdx = -1
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]?.role === 'user') {
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

        // Un appel d'outil : delta.tool_calls standard + finish "tool_calls".
        if (scenario !== null && !hasToolResult) {
          chunk({})
          // M15 — le protocole deux temps ouvre AUSSI le tour d'outils :
          // thinking titré dans le contenu, puis les appels (titrés, leur
          // argument `title` voyagera jusqu'à la ligne du pilote).
          const title = scenario.thinkTitle ?? 'Agir sur le workspace'
          const body = scenario.thinkBody ?? 'Je lance les actions de ce tour.'
          chunk({ content: `<thinking title="${title}">` })
          chunk({ content: `${body}</thinking>` })
          const calls = scenario.twoCalls ?? (scenario.name ? [scenario] : [])
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
          // M15 — le protocole deux temps : le bloc <thinking title="…"> ouvre
          // la réponse DANS LE CONTENU, coupé en plein milieu de la balise (le
          // splitter de l'adaptateur doit le recoudre sans perdre un octet).
          const thinkTitle = scenario?.thinkTitle ?? 'Comprendre la demande'
          const thinkBody = scenario?.thinkBody ?? 'Je passe en revue ce que l\u2019ICM sait déjà.'
          chunk({ content: `<thinking title="${thinkTitle}">` })
          chunk({ content: `${thinkBody}</think` })
          chunk({ content: `ing>` })
        }

        // Réponse finale (texte) — le scénario conclut, sinon la réponse type.
        const text = scenario !== null ? scenario.final : `Réponse (maquette) [${model}] : ${replyBody(lastUser)}`
        chunk({})
        const third = Math.ceil(text.length / 3)
        const parts = [text.slice(0, third), text.slice(third, 2 * third), text.slice(2 * third)]
        let i = 0
        const tick = () => {
          if (res.destroyed) return
          if (i >= parts.length) {
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
