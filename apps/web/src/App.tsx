import { createWeb2ApiClient } from '@nyworkflow/adapter-llm'
import type { ToolCallRequest } from '@nyworkflow/adapter-llm'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ActivityPanel } from './components/ActivityPanel'
import { ChatView } from './components/ChatView'
import { Composer } from './components/Composer'
import { ModelPicker } from './components/ModelPicker'
import { NewSessionDialog } from './components/NewSessionDialog'
import { SettingsPanel } from './components/SettingsPanel'
import { Sidebar } from './components/Sidebar'
import { ToolApprovalCard } from './components/ToolApprovalCard'
import { AGENT_TOOLS, isDangerousTool, parseToolArgs } from './lib/agentTools'
import { parseInput, runCommand } from './lib/commands'
import { fakeReply, streamText } from './lib/fakeLLM'
import { useGatewayStatus } from './lib/gateway'
import { toAgentMessages } from './lib/history'
import { baseModelOf, withThinkLevel } from './lib/modelMeta'
import { loadDefaultSecurity, SECURITY_HINT, SECURITY_LABEL } from './lib/security'
import { applyTheme, loadTheme } from './lib/theme'
import * as api from './lib/sessionApi'
import type { ToolRunDto } from './lib/sessionApi'
import { SessionStore } from './lib/store'
import type { ChatMsg, RequestTrace, SecurityLevel, SessionInfo } from './lib/types'
import { APP_VERSION } from './lib/version'

const WELCOME =
  'Bienvenue dans NyWorkflow (v0.4.0). Sessions ICM agentiques — chaque session vit dans un workspace (arbre ICM complet : charte, plan, tâches, journal, décisions, recherche, mémoire) : le modèle charge l’ICM et agit avec ses outils (read, write, ls, glob, mkdir, shell + arrière-plan, websearch, shell_output, shell_kill). Niveau de sécurité par session (demander / accepter / aucun outil), onglet Activité (requêtes + outils, journalisés), logs de profilage dans .nyworkflow/.logs/.'
const GATEWAY_DOWN =
  'Passerelle webapi absente — réponses simulées. Elle démarre normalement avec l’application ; ouvrez Paramètres → Passerelle pour le diagnostic, ou vérifiez NYW_WEBAPI_EMBED (0 = désactivée).'
const MEMORY_FALLBACK =
  'API /sessions indisponible — repli mémoire : cette session ne survivra pas à un rechargement.'
const MAX_ROUNDS = 12
const THINK_KEY = 'nyworkflow.thinkLevel'
type Mode = 'booting' | 'server' | 'memory'
type Tab = 'chat' | 'activity'

/** A paused decision the turn loop is waiting on. */
interface DecisionWaiter {
  sessionId: string
  rowId: string
  resolve: (outcome: ToolRunDto) => void
}

/** The client mirror of the server's dangerous-tool gate. */
const dangerous = (name: string): boolean => isDangerousTool(name)

/**
 * M13 — the professional agentic harness: sessions grouped by workspace
 * folder, per-session tabs (chat + activity tracking), thinking level and
 * streamed thinking, parallel safe tool calls, background shells, inline
 * rename, and a Stop button that cancels a running turn honestly. The
 * journal stays the truth; the loop still lives in the browser (ICM system
 * prompt reloaded each round, standard tool_calls through the gateway).
 * M13: a per-session security level (ask / accept / no-tools) rules the
 * tools, completed turns are journaled (durable activity traces), and the
 * engine logs everything into .nyworkflow/.logs/.
 */
export default function App() {
  const [boot] = useState(() => ({ store: new SessionStore(), client: createWeb2ApiClient({ baseUrl: '/api' }) }))
  const { store, client } = boot
  const [mode, setMode] = useState<Mode>('booting')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('chat')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [newSessionTitle, setNewSessionTitle] = useState('')
  const [newSessionWorkspace, setNewSessionWorkspace] = useState<string | undefined>(undefined)
  /** The agent turn in flight (composer send disabled while it runs). */
  const [agentRun, setAgentRun] = useState<{ sessionId: string } | null>(null)
  /** M12 — a message typed while a turn runs: queued, sent when it ends. */
  const [queued, setQueued] = useState<string | null>(null)
  /** M12 — think level: 'auto' or '0'..'4', persisted. */
  const [thinkLevel, setThinkLevel] = useState<string>(() => localStorage.getItem(THINK_KEY) ?? 'auto')
  const gw = useGatewayStatus(client)

  useEffect(() => {
    localStorage.setItem(THINK_KEY, thinkLevel)
  }, [thinkLevel])

  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const active = snap.sessions.find((s) => s.id === activeId) ?? snap.sessions.at(-1) ?? null
  const rows = active ? snap.messages.filter((m) => m.sessionId === active.id) : []
  const traces = active ? snap.traces.filter((t) => t.sessionId === active.id) : []
  /** The paused DANGEROUS tool call of the active session (approval card). */
  const pendingRow = [...rows].reverse().find((m) => m.role === 'tool' && m.ok === undefined && dangerous(m.tool ?? ''))

  /** The paused decision the live loop waits on (survives re-renders). */
  const waiterRef = useRef<DecisionWaiter | null>(null)
  /** M12 — the abort controller of the running turn (Stop button). */
  const stopRef = useRef<AbortController | null>(null)

  // Thème persisté appliqué dès le boot (M8).
  useEffect(() => {
    applyTheme(loadTheme())
  }, [])

  // Hydratation au démarrage : journaux → store ; première session liée à un
  // workspace (scaffold d'office si le registre est vide — jamais de session orpheline).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const sessions = await api.listSessions()
        if (cancelled) return
        if (sessions.length === 0) {
          const { first, welcome } = await createFirstSession()
          if (cancelled || !first) return
          store.addSession({ id: first.id, title: first.title, createdAt: first.createdAt, workspace: first.workspace, security: first.security })
          setActiveId(first.id)
          store.appendMessage(first.id, 'system', welcome)
        } else {
          store.ingest(
            sessions.map((d): SessionInfo => ({
              id: d.id,
              title: d.title,
              createdAt: d.createdAt,
              workspace: d.workspace,
              security: d.security,
            })),
            sessions.flatMap((d) => rowsFromEvents(d.id, d.events)),
          )
          // M13 — les tours terminés sont journalisés (turn.completed) :
          // l'onglet Activité survit aux rechargements, requêtes comprises.
          for (const d of sessions) {
            for (const trace of tracesFromEvents(d.id, d.events)) store.appendTrace(trace)
          }
          setActiveId(sessions[sessions.length - 1]!.id)
        }
        setMode('server')
      } catch {
        if (cancelled) return
        const first = store.createSession()
        store.appendMessage(first.id, 'system', MEMORY_FALLBACK)
        store.appendMessage(first.id, 'system', WELCOME)
        setActiveId(first.id)
        setMode('memory')
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store])

  /** Première session : workspace existant ou scaffold d'un workspace par défaut. */
  async function createFirstSession(): Promise<{ first: api.SessionDto | null; welcome: string }> {
    let workspace: string | undefined
    try {
      const list = await api.listWorkspaces()
      workspace = list[0]?.name
      if (workspace === undefined) {
        workspace = (await api.createWorkspace('mon-workspace')).name
      }
    } catch {
      workspace = undefined
    }
    const first = await api.createSession(undefined, workspace, loadDefaultSecurity())
    const welcome =
      workspace !== undefined
        ? WELCOME
        : `${WELCOME}\n(Aucun workspace disponible — la session sera une conversation simple, sans outils.)`
    return { first, welcome }
  }

  /** M13 — change le niveau de sécurité de la session active (journal + store). */
  const handleSecurity = useCallback(
    (level: SecurityLevel) => {
      if (!active) return
      if (mode === 'server') {
        void api
          .setSecurity(active.id, level)
          .then((dto) => {
            store.setSessionSecurity(active.id, dto.security)
            store.appendMessage(active.id, 'system', `Niveau de sécurité : ${SECURITY_LABEL[dto.security]} — ${SECURITY_HINT[dto.security]}.`)
          })
          .catch((err) => {
            const why = err instanceof Error ? err.message : String(err)
            store.appendMessage(active.id, 'system', `Changement de sécurité impossible : ${why}`)
          })
      } else {
        store.setSessionSecurity(active.id, level)
      }
    },
    [active, mode, store],
  )

  /** M13 — turn.completed events → activity traces (durable, reload-proof). */
  function tracesFromEvents(sessionId: string, events: api.SessionDto['events']): RequestTrace[] {
    return events.flatMap((e, k) =>
      e.type === 'turn.completed'
        ? [
            {
              id: `${sessionId}:t${k}`,
              sessionId,
              at: Date.parse(e.at) || 0,
              model: e.model,
              thinkLevel: e.thinkLevel ?? null,
              round: e.rounds,
              messages: e.messages ?? 0,
              tools: e.tools ?? 0,
              ms: e.ms,
              outcome: e.outcome,
              ...(e.error !== undefined ? { error: e.error } : {}),
              thinkingChars: e.thinkingChars,
              textChars: e.textChars,
            },
          ]
        : [],
    )
  }

  // Annonce une seule fois l'absence de passerelle, dans la session active.
  const announcedDown = useRef(false)
  const downTargetId = active?.id
  useEffect(() => {
    if (gw.status === 'down' && !announcedDown.current && downTargetId) {
      announcedDown.current = true
      store.appendMessage(downTargetId, 'system', GATEWAY_DOWN)
    }
  }, [gw.status, downTargetId, store])

  /**
   * Journal events → UI rows, order preserved. Results pair with their call
   * by callId (M12: parallel calls interleave), positionally otherwise
   * (legacy journals). At hydration an orphaned OPEN SAFE call (the browser
   * died mid-parallel-run) is settled as interrupted — an open DANGEROUS
   * call is the real approval pause.
   */
  function rowsFromEvents(sessionId: string, events: api.SessionDto['events']): ChatMsg[] {
    const out: ChatMsg[] = []
    let k = 0
    const openByCallId = new Map<string, ChatMsg>()
    for (const e of events) {
      if (e.type === 'user.message' || e.type === 'assistant.message') {
        out.push({ id: `${sessionId}:${k++}`, sessionId, role: e.type === 'user.message' ? 'user' : 'assistant', text: e.text, at: Date.parse(e.at) || 0 })
      } else if (e.type === 'tool.call') {
        const row: ChatMsg = { id: `${sessionId}:${k++}`, sessionId, role: 'tool', text: '', at: Date.parse(e.at) || 0, tool: e.tool, args: e.args }
        out.push(row)
        if (e.callId !== undefined) openByCallId.set(e.callId, row)
      } else if (e.type === 'tool.result') {
        // callId d'abord (M12), repli positionnel pour les journaux anciens.
        let open: ChatMsg | undefined
        if (e.callId !== undefined) open = openByCallId.get(e.callId)
        if (open === undefined) open = [...out].reverse().find((r) => r.role === 'tool' && r.ok === undefined)
        if (open !== undefined) {
          open.ok = e.ok
          open.summary = e.summary
          if (e.ok && e.data !== undefined) open.data = e.data
          if (e.callId !== undefined) openByCallId.delete(e.callId)
        }
      }
    }
    // Orphaned open SAFE calls = a cut turn, not an approval.
    for (const r of out) {
      if (r.role === 'tool' && r.ok === undefined && !dangerous(r.tool ?? '')) {
        r.ok = false
        r.summary = 'interrompu (le tour s’est arrêté avant la fin de cet appel)'
      }
    }
    return out
  }

  /** Décision humaine sur l'appel en pause — le journal reçoit le résultat, la boucle reprend. */
  const handleDecision = useCallback(
    async (decision: 'approve' | 'refuse') => {
      if (!active?.workspace || !pendingRow) return
      try {
        const res = await api.decideTool(active.workspace, active.id, decision)
        if (res.status === 'executed') {
          store.resolveToolCall(pendingRow.id, res.outcome)
        }
        const waiter = waiterRef.current
        if (waiter !== null && waiter.sessionId === active.id && waiter.rowId === pendingRow.id) {
          waiterRef.current = null
          waiter.resolve(res)
        }
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        store.appendMessage(active.id, 'system', `Décision impossible : ${why}`)
      }
    },
    [active, pendingRow, store],
  )

  /** M12 — renommage d'une session (serveur + store). */
  const doRename = useCallback(
    async (id: string, title: string) => {
      const target = store.findSessionById(id)
      if (!target) return
      if (mode === 'server') {
        try {
          const dto = await api.renameSession(id, title)
          store.renameSession(id, dto.title)
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err)
          store.appendMessage(id, 'system', `Renommage impossible : ${why}`)
        }
      } else {
        store.renameSession(id, title)
      }
    },
    [mode, store],
  )

  /** Suppression d'une session (M11) — journal serveur ou locale en mode mémoire. */
  const doDelete = useCallback(
    async (id: string) => {
      const target = store.findSessionById(id)
      if (!target) return
      try {
        if (mode === 'server') await api.deleteSession(id)
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        const anchor = store.findSessionById(id)
        if (anchor) store.appendMessage(id, 'system', `Suppression impossible : ${why}`)
        return
      }
      // Une boucle en pause sur cette session se termine proprement.
      const waiter = waiterRef.current
      if (waiter !== null && waiter.sessionId === id) {
        waiterRef.current = null
        waiter.resolve({ status: 'executed', callId: '', outcome: { ok: false, code: 'refused_by_user', summary: 'session supprimée' } })
      }
      stopRef.current?.abort()
      store.removeSession(id)
      const rest = store.listSessions()
      if (activeId === id) setActiveId(rest.length > 0 ? rest[rest.length - 1]!.id : null)
      if (rest.length === 0) {
        setNewSessionWorkspace(undefined)
        setNewSessionOpen(true)
      }
    },
    [activeId, mode, store],
  )

  /** Fork d'une session : copie du journal, historique hérité, bascule dessus. */
  const doFork = useCallback(
    async (id: string) => {
      const src = store.findSessionById(id)
      if (!src) return
      try {
        if (mode === 'server') {
          const dto = await api.forkSession(id)
          store.addSession({ id: dto.id, title: dto.title, createdAt: dto.createdAt, workspace: dto.workspace })
          store.copyMessages(id, dto.id)
          store.appendMessage(dto.id, 'system', `Fork de « ${src.title} » créé.`)
          setActiveId(dto.id)
          setTab('chat')
        } else {
          const base = src.title.replace(/ \(fork\)$/, '')
          const fork = store.createSession(`${base} (fork)`)
          store.copyMessages(id, fork.id)
          store.appendMessage(fork.id, 'system', `Fork de « ${src.title} » créé.`)
          setActiveId(fork.id)
          setTab('chat')
        }
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        store.appendMessage(id, 'system', `Fork impossible : ${why}`)
      }
    },
    [mode, store],
  )

  /** Journalise la réponse assistant une fois le flux terminé (complète ou partielle). */
  const journalAssistant = useCallback(
    (sessionId: string, msgId: string) => {
      if (mode !== 'server') return
      const msg = store.listMessages(sessionId).find((m) => m.id === msgId)
      if (!msg || msg.text.trim() === '') return
      void api.appendChatEvent(sessionId, 'assistant', msg.text).catch((err) => {
        const why = err instanceof Error ? err.message : String(err)
        store.appendMessage(sessionId, 'system', `Journalisation impossible — ${why}`)
      })
    },
    [mode, store],
  )

  /** The effective model: base id + think suffix (M12). */
  const effectiveModel = useCallback(
    (base: string): string => withThinkLevel(baseModelOf(base), thinkLevel),
    [thinkLevel],
  )

  /**
   * The agent loop (M11, M12, M13): ICM → model → tool_calls → tools → model…
   * until a plain answer. The session's SECURITY LEVEL rules the tools:
   * 'no-tools' declares nothing (the server refuses any call anyway),
   * 'accept' runs every call without approval (all parallel, shells
   * included), 'ask' keeps the human gate one dangerous call at a time.
   * Every request is traced AND journaled (turn.completed) — the activity
   * tab survives reloads; the Stop button aborts honestly.
   */
  const runAgentTurn = useCallback(
    async (session: SessionInfo, userText: string) => {
      const workspace = session.workspace
      if (workspace === undefined) return
      const security = session.security ?? 'ask'
      const toolsOn = security !== 'no-tools'
      const controller = new AbortController()
      stopRef.current = controller
      setAgentRun({ sessionId: session.id })
      const turnStartedAt = Date.now()
      // M13 — the turn summary, posted to the journal (turn.completed) when
      // the turn ends, whatever the exit path: durable activity traces.
      const turn = {
        model: '',
        rounds: 0,
        toolCalls: 0,
        thinkingChars: 0,
        textChars: 0,
        outcome: 'ok' as 'ok' | 'error' | 'stopped',
        error: undefined as string | undefined,
        messages: 0,
        tools: 0,
      }
      const finishTurn = (): void => {
        if (mode !== 'server') return
        void api
          .postTurn(session.id, {
            model: turn.model,
            thinkLevel: thinkLevel === 'auto' ? null : Number.parseInt(thinkLevel, 10),
            rounds: turn.rounds,
            ms: Date.now() - turnStartedAt,
            outcome: turn.outcome,
            toolCalls: turn.toolCalls,
            messages: turn.messages,
            tools: turn.tools,
            thinkingChars: turn.thinkingChars,
            textChars: turn.textChars,
            ...(turn.error !== undefined ? { error: turn.error } : {}),
          })
          .catch(() => undefined) // jamais bloquant : le tour est déjà rendu
      }
      try {
        for (let round = 1; round <= MAX_ROUNDS; round++) {
          if (store.findSessionById(session.id) === undefined) return // session supprimée
          if (gw.status !== 'up' || !gw.selected) return // passerelle tombée entre-temps
          const aborted = (): boolean => controller.signal.aborted

          // L'ICM vers le modèle — rechargé à chaque tour (l'arbre a pu grandir).
          let system = ''
          try {
            system = (await api.getIcm(workspace)).system
          } catch (err) {
            const why = err instanceof Error ? err.message : String(err)
            store.appendMessage(session.id, 'system', `ICM inaccessible (${why}) — réponse sans contexte du workspace.`)
            turn.outcome = 'error'
            turn.error = `ICM inaccessible : ${why}`
            return
          }
          // M13 — sous « aucun outil », le modèle le SAIT : pas de tool_calls,
          // la réponse vient de l'ICM et de la conversation.
          if (!toolsOn) {
            system +=
              '\n\n## Niveau de sécurité de la session\nLes outils sont DÉSACTIVÉS pour cette session (niveau « aucun outil ») : n’émet aucun tool_call, réponds à partir de l’ICM ci-dessus et de la conversation.'
          }
          if (aborted()) return

          const model = effectiveModel(gw.selected)
          turn.model = model
          const messages = [{ role: 'system' as const, content: system }, ...toAgentMessages(store.listMessages(session.id))]
          turn.messages = messages.length
          turn.tools = toolsOn ? AGENT_TOOLS.length : 0
          const traceId = `tr-${crypto.randomUUID().slice(0, 8)}`
          const startedAt = Date.now()
          store.appendTrace({
            id: traceId,
            sessionId: session.id,
            at: startedAt,
            model,
            thinkLevel: thinkLevel === 'auto' ? null : Number.parseInt(thinkLevel, 10),
            round,
            messages: messages.length,
            tools: turn.tools,
            ms: 0,
            outcome: 'ok',
            thinkingChars: 0,
            textChars: 0,
          })

          const placeholder = store.appendMessage(session.id, 'assistant', '')
          store.setStreaming(placeholder.id, true)
          turn.rounds = round
          let text = ''
          let thinking = ''
          let calls: ToolCallRequest[] = []
          let failed = false
          try {
            for await (const ev of client.chatStream({
              model,
              messages,
              ...(toolsOn ? { tools: AGENT_TOOLS } : {}),
              signal: controller.signal,
            })) {
              if (ev.type === 'thinking') {
                if (!store.appendThinking(placeholder.id, ev.delta)) return // session effacée
                thinking += ev.delta
              } else if (ev.type === 'text') {
                if (!store.appendText(placeholder.id, ev.delta)) return // session effacée
                text += ev.delta
              } else if (ev.type === 'tool_calls') {
                calls = ev.calls
              }
            }
          } catch (err) {
            failed = true
            turn.outcome = 'error'
            turn.error = err instanceof Error ? err.message : String(err)
            turn.thinkingChars += thinking.length
            turn.textChars += text.length
            const remaining = store.listMessages(session.id).find((m) => m.id === placeholder.id)
            if (!remaining) return
            if (remaining.text.trim() === '' && (remaining.thinking ?? '') === '') store.removeMessage(placeholder.id)
            else {
              store.setStreaming(placeholder.id, false)
              journalAssistant(session.id, placeholder.id)
            }
            const why = err instanceof Error ? err.message : String(err)
            store.appendMessage(session.id, 'system', `Erreur passerelle : ${why}`)
            store.settleTrace(traceId, { ms: Date.now() - startedAt, outcome: 'error', error: why, thinkingChars: thinking.length, textChars: text.length })
            return
          }
          store.setStreaming(placeholder.id, false)
          journalAssistant(session.id, placeholder.id)
          turn.thinkingChars += thinking.length
          turn.textChars += text.length

          if (aborted()) {
            turn.outcome = 'stopped'
            store.settleTrace(traceId, { ms: Date.now() - startedAt, outcome: 'stopped', thinkingChars: thinking.length, textChars: text.length })
            store.appendMessage(session.id, 'system', 'Tour interrompu — le texte reçu est conservé.')
            return
          }

          store.settleTrace(traceId, {
            ms: Date.now() - startedAt,
            outcome: calls.length > 0 ? 'tool_calls' : 'ok',
            thinkingChars: thinking.length,
            textChars: text.length,
          })

          if (calls.length === 0) return // réponse finale — tour terminé
          turn.toolCalls += calls.length

          // Toutes les lignes d'abord (l'ordre du modèle est l'ordre du flux)…
          const plan = calls.map((call) => {
            const args = parseToolArgs(call.function.arguments)
            const row = store.appendToolCall(session.id, call.function.name, args)
            return { call, args, row, danger: dangerous(call.function.name) }
          })

          /** One call: POST /tool, settle the row, wait when dangerous. */
          const runOne = async (item: (typeof plan)[number]): Promise<void> => {
            if (store.findSessionById(session.id) === undefined) return
            let res: ToolRunDto
            try {
              res = await api.runTool(workspace, session.id, item.call.function.name, item.args)
            } catch (err) {
              const why = err instanceof Error ? err.message : String(err)
              store.resolveToolCall(item.row.id, { ok: false, summary: `outil injoignable : ${why}` })
              return
            }
            if (res.status === 'executed') {
              store.resolveToolCall(item.row.id, res.outcome)
              return
            }
            // Dangereux : en pause — la carte d'approbation décide, la boucle attend.
            const outcome = await new Promise<ToolRunDto>((resolve) => {
              waiterRef.current = { sessionId: session.id, rowId: item.row.id, resolve }
            })
            if (store.findSessionById(session.id) === undefined) return
            if (outcome.status === 'executed') store.resolveToolCall(item.row.id, outcome.outcome)
          }

          // …puis exécution : sous « accept » (M13), TOUT part en parallèle —
          // shells compris ; sous « ask », les appels sûrs ensemble et les
          // dangereux l'un après l'autre (la porte d'approbation reste
          // strictement une à la fois côté serveur).
          if (security === 'accept') {
            await Promise.all(plan.map((p) => runOne(p)))
          } else {
            await Promise.all(plan.filter((p) => !p.danger).map((p) => runOne(p)))
            for (const item of plan.filter((p) => p.danger)) {
              if (aborted()) return
              await runOne(item)
            }
          }
          if (aborted()) return
        }
        store.appendMessage(session.id, 'system', `Boucle interrompue après ${MAX_ROUNDS} tours — précisez la demande pour continuer.`)
      } finally {
        finishTurn()
        stopRef.current = null
        setAgentRun(null)
      }
    },
    [client, effectiveModel, gw.selected, gw.status, journalAssistant, mode, store, thinkLevel],
  )

  /** M12 — Stop: abort the running turn; a pending approval is refused so the loop ends. */
  const handleStop = useCallback(() => {
    stopRef.current?.abort()
    const waiter = waiterRef.current
    if (waiter !== null) {
      waiterRef.current = null
      waiter.resolve({ status: 'executed', callId: '', outcome: { ok: false, code: 'refused_by_user', summary: 'tour interrompu par le pilote' } })
    }
  }, [])

  const handleSend = useCallback(
    async (raw: string) => {
      if (!active) return
      if (agentRun !== null) {
        // M12 : le composer reste actif pendant un tour — le message part
        // dès la fin, jamais perdu silencieusement.
        setQueued(raw)
        store.appendMessage(active.id, 'system', 'Message mis en file — il partira dès la fin du tour en cours.')
        return
      }
      const parsed = parseInput(raw)

      if (parsed.kind === 'command') {
        const out = await runCommand({ store, activeSessionId: active.id }, parsed.name ?? '', parsed.args ?? '')
        if (out.openNewDialog) {
          setNewSessionTitle(parsed.args ?? '')
          setNewSessionWorkspace(undefined)
          setNewSessionOpen(true)
        }
        if (out.deleteActive) {
          await doDelete(active.id)
          return
        }
        if (out.renameTo !== undefined) {
          await doRename(active.id, out.renameTo)
          return
        }
        if (out.systemText !== '') store.appendMessage(active.id, 'system', out.systemText)
        return
      }

      store.appendMessage(active.id, 'user', parsed.text)
      if (mode === 'server') {
        void api.appendChatEvent(active.id, 'user', parsed.text).catch((err) => {
          const why = err instanceof Error ? err.message : String(err)
          store.appendMessage(active.id, 'system', `Journalisation impossible — ${why}`)
        })
      }
      setTab('chat')

      // Session agentique : la boucle tourne dans le navigateur (ICM + outils).
      if (mode === 'server' && gw.status === 'up' && gw.selected) {
        if (active.workspace !== undefined) {
          void runAgentTurn(active, parsed.text)
          return
        }
        // Session sans workspace (anciennes sessions) : conversation réelle,
        // sans ICM ni outils — le modèle reste branché. Le tour part aussi
        // au journal (M13) : activité complète, même sans workspace.
        const controller = new AbortController()
        stopRef.current = controller
        const history = toAgentMessages(store.listMessages(active.id))
        const plain = store.appendMessage(active.id, 'assistant', '')
        store.setStreaming(plain.id, true)
        const model = effectiveModel(gw.selected)
        const plainStartedAt = Date.now()
        let plainChars = 0
        void (async () => {
          let outcome: 'ok' | 'error' = 'ok'
          let failedWhy: string | undefined
          try {
            for await (const ev of client.chatStream({ model, messages: history, signal: controller.signal })) {
              if (ev.type === 'thinking') store.appendThinking(plain.id, ev.delta)
              else if (ev.type === 'text') {
                plainChars += ev.delta.length
                if (!store.appendText(plain.id, ev.delta)) return
              }
            }
            store.setStreaming(plain.id, false)
            journalAssistant(active.id, plain.id)
          } catch (err) {
            outcome = 'error'
            const remaining = store.listMessages(active.id).find((m) => m.id === plain.id)
            if (!remaining) return
            if (remaining.text.trim() === '') store.removeMessage(plain.id)
            else {
              store.setStreaming(plain.id, false)
              journalAssistant(active.id, plain.id)
            }
            failedWhy = err instanceof Error ? err.message : String(err)
            store.appendMessage(active.id, 'system', `Erreur passerelle : ${failedWhy}`)
          } finally {
            stopRef.current = null
            void api
              .postTurn(active.id, {
                model,
                thinkLevel: thinkLevel === 'auto' ? null : Number.parseInt(thinkLevel, 10),
                rounds: 1,
                ms: Date.now() - plainStartedAt,
                outcome,
                toolCalls: 0,
                messages: history.length,
                tools: 0,
                thinkingChars: 0,
                textChars: plainChars,
                ...(failedWhy !== undefined ? { error: failedWhy } : {}),
              })
              .catch(() => undefined)
          }
        })()
        return
      }

      // Repli simulé (passerelle absente ou mode mémoire).
      const placeholder = store.appendMessage(active.id, 'assistant', '')
      store.setStreaming(placeholder.id, true)
      streamText(fakeReply(parsed.text), (token) => store.appendText(placeholder.id, token)).done.then(() => {
        store.setStreaming(placeholder.id, false)
        journalAssistant(active.id, placeholder.id)
      })
    },
    [active, agentRun, client, doDelete, doRename, effectiveModel, gw.selected, gw.status, journalAssistant, mode, runAgentTurn, store, thinkLevel],
  )

  // M12 — the queued message leaves when the running turn ends.
  useEffect(() => {
    if (agentRun !== null || queued === null || !active) return
    setQueued(null)
    void handleSend(queued)
  }, [agentRun, queued, active, handleSend])

  if (!active) return null

  const busy = agentRun !== null

  return (
    <div className="app">
      <Sidebar
        sessions={snap.sessions}
        activeId={active.id}
        onSelect={(id) => {
          setActiveId(id)
          setTab('chat')
        }}
        onNew={() => {
          setNewSessionTitle('')
          setNewSessionWorkspace(undefined)
          setNewSessionOpen(true)
        }}
        onNewInWorkspace={(ws) => {
          setNewSessionTitle('')
          setNewSessionWorkspace(ws)
          setNewSessionOpen(true)
        }}
        onFork={(id) => void doFork(id)}
        onDelete={(id) => void doDelete(id)}
        onRename={(id, title) => void doRename(id, title)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="main">
        <header className="main-head">
          <h2 data-test="session-title">{active.title}</h2>
          <div className="main-tools">
            <ModelPicker
              status={gw.status}
              models={gw.models}
              modelInfo={gw.modelInfo}
              selected={baseModelOf(gw.selected)}
              onSelect={(m) => gw.select(m)}
              thinkLevel={thinkLevel}
              onThinkLevel={setThinkLevel}
              onRefresh={() => void gw.refresh()}
            />
            <span className="tag">v{APP_VERSION}</span>
          </div>
        </header>
        {active.workspace !== undefined ? (
          <div className="ws-banner" data-test="ws-banner">
            <span className="ws-chip" title="Workspace ICM de la session">
              ICM · {active.workspace}
            </span>
            <span className="ws-api">API {client.apiVersion}</span>
            <label className="security-picker" data-test="security-picker" title={SECURITY_HINT[active.security ?? 'ask']}>
              <span aria-hidden="true">Sécurité</span>
              <select
                data-test="security-select"
                value={active.security ?? 'ask'}
                onChange={(e) => handleSecurity(e.target.value as SecurityLevel)}
              >
                <option value="ask">{SECURITY_LABEL.ask}</option>
                <option value="accept">{SECURITY_LABEL.accept}</option>
                <option value="no-tools">{SECURITY_LABEL['no-tools']}</option>
              </select>
            </label>
            <nav className="session-tabs" aria-label="Vues de la session">
              <button
                type="button"
                className={`session-tab ${tab === 'chat' ? 'active' : ''}`}
                data-test="tab-chat"
                onClick={() => setTab('chat')}
              >
                Conversation
              </button>
              <button
                type="button"
                className={`session-tab ${tab === 'activity' ? 'active' : ''}`}
                data-test="tab-activity"
                onClick={() => setTab('activity')}
              >
                Activité
                {traces.length > 0 ? <span className="tab-count">{traces.length}</span> : null}
              </button>
            </nav>
          </div>
        ) : null}
        {tab === 'activity' && active.workspace !== undefined ? (
          <ActivityPanel traces={traces} toolRows={rows.filter((r) => r.role === 'tool')} />
        ) : (
          <ChatView messages={rows} />
        )}
        {mode === 'server' && active.workspace !== undefined && pendingRow && tab === 'chat' ? (
          <ToolApprovalCard
            tool={pendingRow.tool ?? ''}
            args={pendingRow.args}
            onDecide={(d) => void handleDecision(d)}
          />
        ) : null}
        <Composer onSend={handleSend} onStop={handleStop} running={busy} />
      </main>
      {newSessionOpen ? (
        <NewSessionDialog
          mode={mode}
          initialTitle={newSessionTitle}
          initialWorkspace={newSessionWorkspace}
          onClose={() => setNewSessionOpen(false)}
          onCreated={(s) => {
            store.addSession(s)
            const sec = s.security ?? 'ask'
            store.appendMessage(
              s.id,
              'system',
              `Session « ${s.title} » créée — workspace « ${s.workspace} » chargé vers le modèle. Sécurité : ${SECURITY_LABEL[sec]} (${SECURITY_HINT[sec]}).`,
            )
            setActiveId(s.id)
            setTab('chat')
            setNewSessionOpen(false)
          }}
        />
      ) : null}
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
