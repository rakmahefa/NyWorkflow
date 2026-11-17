import { createWeb2ApiClient } from '@nyworkflow/adapter-llm'
import type { ToolCallRequest } from '@nyworkflow/adapter-llm'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ChatView } from './components/ChatView'
import { Composer } from './components/Composer'
import { ModelPicker } from './components/ModelPicker'
import { NewSessionDialog } from './components/NewSessionDialog'
import { SettingsPanel } from './components/SettingsPanel'
import { Sidebar } from './components/Sidebar'
import { ToolApprovalCard } from './components/ToolApprovalCard'
import { AGENT_TOOLS, parseToolArgs } from './lib/agentTools'
import { parseInput, runCommand } from './lib/commands'
import { fakeReply, streamText } from './lib/fakeLLM'
import { useGatewayStatus } from './lib/gateway'
import { toAgentMessages } from './lib/history'
import { applyTheme, loadTheme } from './lib/theme'
import * as api from './lib/sessionApi'
import type { ToolRunDto } from './lib/sessionApi'
import { SessionStore } from './lib/store'
import type { ChatMsg, SessionInfo } from './lib/types'
import { APP_VERSION } from './lib/version'

const WELCOME =
  'Bienvenue dans NyWorkflow (v0.2.0). Sessions ICM agentiques — chaque session vit dans un workspace (arbre libre + CONTEXT.md) : le modèle charge l’ICM et agit avec ses outils (read, write, ls, glob, mkdir, shell, websearch). Les écritures et commandes attendent votre approbation. /help pour les commandes.'
const GATEWAY_DOWN =
  'Passerelle webapi absente — réponses simulées. Elle démarre normalement avec l’application ; ouvrez Paramètres → Passerelle pour le diagnostic, ou vérifiez NYW_WEBAPI_EMBED (0 = désactivée).'
const MEMORY_FALLBACK =
  'API /sessions indisponible — repli mémoire : cette session ne survivra pas à un rechargement.'
const MAX_ROUNDS = 12

type Mode = 'booting' | 'server' | 'memory'

/** A paused decision the turn loop is waiting on. */
interface DecisionWaiter {
  sessionId: string
  rowId: string
  resolve: (outcome: ToolRunDto) => void
}

/**
 * M11 — sessions ICM agentiques. The app IS its sessions: every session is
 * bound to a workspace, and a chat turn runs the agent loop in the browser
 * — ICM system prompt (tree + CONTEXT.md, loaded fresh each round), history
 * derived from the journal rows (chat + tool round-trips), standard
 * tool_calls through the gateway. Tool calls execute server-side (scope
 * guard + caps); dangerous ones (write, shell) pause for a human — the
 * decision resolves the pause and the loop continues. The journal stays
 * the truth: everything the UI shows is derived from it, on disk.
 */
export default function App() {
  const [boot] = useState(() => ({ store: new SessionStore(), client: createWeb2ApiClient({ baseUrl: '/api' }) }))
  const { store, client } = boot
  const [mode, setMode] = useState<Mode>('booting')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [newSessionTitle, setNewSessionTitle] = useState('')
  /** The agent turn in flight (composer disabled while it runs). */
  const [agentRun, setAgentRun] = useState<{ sessionId: string } | null>(null)
  const gw = useGatewayStatus(client)

  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const active = snap.sessions.find((s) => s.id === activeId) ?? snap.sessions.at(-1) ?? null
  const rows = active ? snap.messages.filter((m) => m.sessionId === active.id) : []
  /** The paused tool call of the active session, if any (approval card). */
  const pendingRow = [...rows].reverse().find((m) => m.role === 'tool' && m.ok === undefined)

  /** The paused decision the live loop waits on (survives re-renders). */
  const waiterRef = useRef<DecisionWaiter | null>(null)

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
          store.addSession({ id: first.id, title: first.title, createdAt: first.createdAt, workspace: first.workspace })
          setActiveId(first.id)
          store.appendMessage(first.id, 'system', welcome)
        } else {
          store.ingest(
            sessions.map((d): SessionInfo => ({ id: d.id, title: d.title, createdAt: d.createdAt, workspace: d.workspace })),
            sessions.flatMap((d) => rowsFromEvents(d.id, d.events)),
          )
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
    const first = await api.createSession(undefined, workspace)
    const welcome =
      workspace !== undefined
        ? WELCOME
        : `${WELCOME}\n(Aucun workspace disponible — la session sera une conversation simple, sans outils.)`
    return { first, welcome }
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

  /** Journal events → UI rows, order preserved (chat + tool activity). */
  function rowsFromEvents(sessionId: string, events: api.SessionDto['events']): ChatMsg[] {
    const out: ChatMsg[] = []
    let k = 0
    for (const e of events) {
      if (e.type === 'user.message' || e.type === 'assistant.message') {
        out.push({ id: `${sessionId}:${k++}`, sessionId, role: e.type === 'user.message' ? 'user' : 'assistant', text: e.text, at: Date.parse(e.at) || 0 })
      } else if (e.type === 'tool.call') {
        out.push({ id: `${sessionId}:${k++}`, sessionId, role: 'tool', text: '', at: Date.parse(e.at) || 0, tool: e.tool, args: e.args })
      } else if (e.type === 'tool.result') {
        const open = [...out].reverse().find((r) => r.role === 'tool' && r.ok === undefined)
        if (open) {
          open.ok = e.ok
          open.summary = e.summary
          if (e.ok && e.data !== undefined) open.data = e.data
        }
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
        waiter.resolve({ status: 'executed', outcome: { ok: false, code: 'refused_by_user', summary: 'session supprimée' } })
      }
      store.removeSession(id)
      const rest = store.listSessions()
      if (activeId === id) setActiveId(rest.length > 0 ? rest[rest.length - 1]!.id : null)
      if (rest.length === 0) {
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
        } else {
          const base = src.title.replace(/ \(fork\)$/, '')
          const fork = store.createSession(`${base} (fork)`)
          store.copyMessages(id, fork.id)
          store.appendMessage(fork.id, 'system', `Fork de « ${src.title} » créé.`)
          setActiveId(fork.id)
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

  /**
   * The agent loop (M11): ICM → model → tool_calls → tools (approvals
   * pause) → model… until a plain answer. One turn, journal-visible.
   */
  const runAgentTurn = useCallback(
    async (session: SessionInfo, userText: string) => {
      const workspace = session.workspace
      if (workspace === undefined) return
      setAgentRun({ sessionId: session.id })
      try {
        for (let round = 0; round < MAX_ROUNDS; round++) {
          if (store.findSessionById(session.id) === undefined) return // session supprimée
          if (gw.status !== 'up' || !gw.selected) return // passerelle tombée entre-temps

          // L'ICM vers le modèle — rechargé à chaque tour (l'arbre a pu grandir).
          let system = ''
          try {
            system = (await api.getIcm(workspace)).system
          } catch (err) {
            const why = err instanceof Error ? err.message : String(err)
            store.appendMessage(session.id, 'system', `ICM inaccessible (${why}) — réponse sans contexte du workspace.`)
            return
          }

          const messages = [{ role: 'system' as const, content: system }, ...toAgentMessages(store.listMessages(session.id))]
          const placeholder = store.appendMessage(session.id, 'assistant', '')
          store.setStreaming(placeholder.id, true)
          let text = ''
          let calls: ToolCallRequest[] = []
          try {
            for await (const ev of client.chatStream({ model: gw.selected, messages, tools: AGENT_TOOLS })) {
              if (ev.type === 'text') {
                if (!store.appendText(placeholder.id, ev.delta)) return // session effacée
                text += ev.delta
              } else if (ev.type === 'tool_calls') {
                calls = ev.calls
              }
            }
          } catch (err) {
            const remaining = store.listMessages(session.id).find((m) => m.id === placeholder.id)
            if (!remaining) return
            if (remaining.text.trim() === '') store.removeMessage(placeholder.id)
            else {
              store.setStreaming(placeholder.id, false)
              journalAssistant(session.id, placeholder.id)
            }
            const why = err instanceof Error ? err.message : String(err)
            store.appendMessage(session.id, 'system', `Erreur passerelle : ${why}`)
            return
          }
          store.setStreaming(placeholder.id, false)
          journalAssistant(session.id, placeholder.id)

          if (calls.length === 0) return // réponse finale — tour terminé

          // Exécution des appels — séquentielle, approuvations comprises.
          for (const call of calls) {
            if (store.findSessionById(session.id) === undefined) return
            const args = parseToolArgs(call.function.arguments)
            const row = store.appendToolCall(session.id, call.function.name, args)
            let res: ToolRunDto
            try {
              res = await api.runTool(workspace, session.id, call.function.name, args)
            } catch (err) {
              const why = err instanceof Error ? err.message : String(err)
              const outcome = { ok: false, summary: `outil injoignable : ${why}` }
              store.resolveToolCall(row.id, outcome)
              continue
            }
            if (res.status === 'executed') {
              store.resolveToolCall(row.id, res.outcome)
              continue
            }
            // Dangereux : en pause — la carte d'approbation décide, la boucle attend.
            const outcome = await new Promise<ToolRunDto>((resolve) => {
              waiterRef.current = { sessionId: session.id, rowId: row.id, resolve }
            })
            if (store.findSessionById(session.id) === undefined) return
            if (outcome.status === 'executed') store.resolveToolCall(row.id, outcome.outcome)
          }
        }
        store.appendMessage(session.id, 'system', `Boucle interrompue après ${MAX_ROUNDS} tours — précisez la demande pour continuer.`)
      } finally {
        setAgentRun(null)
      }
    },
    [client, gw.selected, gw.status, journalAssistant, store],
  )

  const handleSend = useCallback(
    async (raw: string) => {
      if (!active || agentRun !== null) return
      const parsed = parseInput(raw)

      if (parsed.kind === 'command') {
        const out = await runCommand({ store, activeSessionId: active.id }, parsed.name ?? '', parsed.args ?? '')
        if (out.openNewDialog) {
          setNewSessionTitle(parsed.args ?? '')
          setNewSessionOpen(true)
        }
        if (out.deleteActive) {
          await doDelete(active.id)
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

      // Session agentique : la boucle tourne dans le navigateur (ICM + outils).
      if (mode === 'server' && gw.status === 'up' && gw.selected) {
        if (active.workspace !== undefined) {
          void runAgentTurn(active, parsed.text)
          return
        }
        // Session sans workspace (anciennes sessions) : conversation réelle,
        // sans ICM ni outils — le modèle reste branché.
        const history = toAgentMessages(store.listMessages(active.id))
        const plain = store.appendMessage(active.id, 'assistant', '')
        store.setStreaming(plain.id, true)
        void (async () => {
          try {
            for await (const ev of client.chatStream({ model: gw.selected, messages: history })) {
              if (ev.type === 'text' && !store.appendText(plain.id, ev.delta)) return
            }
            store.setStreaming(plain.id, false)
            journalAssistant(active.id, plain.id)
          } catch (err) {
            const remaining = store.listMessages(active.id).find((m) => m.id === plain.id)
            if (!remaining) return
            if (remaining.text.trim() === '') store.removeMessage(plain.id)
            else {
              store.setStreaming(plain.id, false)
              journalAssistant(active.id, plain.id)
            }
            const why = err instanceof Error ? err.message : String(err)
            store.appendMessage(active.id, 'system', `Erreur passerelle : ${why}`)
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
    [active, agentRun, doDelete, gw.selected, gw.status, journalAssistant, mode, runAgentTurn, store],
  )

  if (!active) return null

  const busy = agentRun !== null

  return (
    <div className="app">
      <Sidebar
        sessions={snap.sessions}
        activeId={active.id}
        onSelect={setActiveId}
        onNew={() => {
          setNewSessionTitle('')
          setNewSessionOpen(true)
        }}
        onFork={(id) => void doFork(id)}
        onDelete={(id) => void doDelete(id)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="main">
        <header className="main-head">
          <h2>{active.title}</h2>
          <div className="main-tools">
            <ModelPicker
              status={gw.status}
              models={gw.models}
              selected={gw.selected}
              onSelect={gw.select}
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
          </div>
        ) : null}
        <ChatView messages={rows} />
        {mode === 'server' && active.workspace !== undefined && pendingRow ? (
          <ToolApprovalCard
            tool={pendingRow.tool ?? ''}
            args={pendingRow.args}
            onDecide={(d) => void handleDecision(d)}
          />
        ) : null}
        <Composer onSend={handleSend} disabled={busy} />
      </main>
      {newSessionOpen ? (
        <NewSessionDialog
          mode={mode}
          initialTitle={newSessionTitle}
          onClose={() => setNewSessionOpen(false)}
          onCreated={(s) => {
            store.addSession(s)
            store.appendMessage(s.id, 'system', `Session « ${s.title} » créée — workspace « ${s.workspace} » chargé vers le modèle.`)
            setActiveId(s.id)
            setNewSessionOpen(false)
          }}
        />
      ) : null}
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
