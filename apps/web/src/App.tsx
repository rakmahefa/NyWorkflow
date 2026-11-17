import { createWeb2ApiClient } from '@nyworkflow/adapter-llm'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ChatView } from './components/ChatView'
import { Composer } from './components/Composer'
import { ModelPicker } from './components/ModelPicker'
import { RunPanel } from './components/RunPanel'
import { Sidebar } from './components/Sidebar'
import type { View } from './components/Sidebar'
import { WorkflowsView } from './components/WorkflowsView'
import { parseInput, runCommand } from './lib/commands'
import { fakeReply, streamText } from './lib/fakeLLM'
import { useGatewayStatus } from './lib/gateway'
import { toLlmHistory } from './lib/history'
import * as api from './lib/sessionApi'
import type { RunStateDto, WorkspaceSummaryDto } from './lib/sessionApi'
import { SessionStore } from './lib/store'
import type { ChatMsg, SessionInfo } from './lib/types'
import { APP_VERSION } from './lib/version'

const WELCOME =
  'Bienvenue dans NyWorkflow (v0.1.0). Sessions journalisées sur disque, moteur ICM avec outils — onglet Workflows pour exécuter un pipeline, écritures du modèle sous approbation. /help pour les commandes.'
const GATEWAY_DOWN =
  'Passerelle gemini-web2api absente (127.0.0.1:8081) — réponses simulées. Lancez la passerelle du repo ny-gemini-acp pour le streaming réel.'
const MEMORY_FALLBACK =
  'API /sessions indisponible — repli mémoire : cette session ne survivra pas à un rechargement.'

type Mode = 'booting' | 'server' | 'memory'

/**
 * M3 shell: sessions persisted as JSONL journals through /sessions.
 * M4: the ICM engine runs workspaces server-side through /workspaces.
 * M5: a session that runs a workflow shows its tool activity and, when a
 * write pauses for a human, an approval card — the one-click decision the
 * engine resumes from.
 * M6: a second view — Workflows — drives the whole pipeline from the UI:
 * runs are created and advanced there, stages light up as they finish,
 * outputs preview from disk. The chat view stays for conversation.
 * Boot hydrates from the journals; chat messages are journaled as they
 * settle; forking copies a journal. When /sessions is unreachable the
 * app degrades to in-memory sessions with a clear notice — never a
 * silent loss.
 */
export default function App() {
  const [boot] = useState(() => ({ store: new SessionStore(), client: createWeb2ApiClient({ baseUrl: '/api' }) }))
  const { store, client } = boot
  const [mode, setMode] = useState<Mode>('booting')
  const [activeId, setActiveId] = useState<string | null>(null)
  /** Run side of the active session, when it executes a workflow (M5). */
  const [run, setRun] = useState<RunStateDto | null>(null)
  /** M6: which face of the app is shown, and the workflows selection. */
  const [view, setView] = useState<View>('chat')
  const [wsList, setWsList] = useState<readonly WorkspaceSummaryDto[] | null>(null)
  const [wsName, setWsName] = useState<string | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const gw = useGatewayStatus(client)

  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const active = snap.sessions.find((s) => s.id === activeId) ?? snap.sessions.at(-1) ?? null
  const messages = active ? snap.messages.filter((m) => m.sessionId === active.id) : []

  // Hydratation au démarrage : journaux → store. Repli mémoire si l'API est absente.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const sessions = await api.listSessions()
        if (cancelled) return
        if (sessions.length === 0) {
          const first = await api.createSession()
          if (cancelled) return
          store.addSession(first)
          setActiveId(first.id)
          store.appendMessage(first.id, 'system', WELCOME)
        } else {
          store.ingest(
            sessions.map((d): SessionInfo => ({ id: d.id, title: d.title, createdAt: d.createdAt, workspace: d.workspace })),
            sessions.flatMap((d) =>
              d.messages.map(
                (m, k): ChatMsg => ({ id: `${d.id}:${k}`, sessionId: d.id, role: m.role, text: m.text, at: m.at }),
              ),
            ),
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
  }, [store])

  // Annonce une seule fois l'absence de passerelle, dans la session active.
  const announcedDown = useRef(false)
  const downTargetId = active?.id
  useEffect(() => {
    if (gw.status === 'down' && !announcedDown.current && downTargetId) {
      announcedDown.current = true
      store.appendMessage(downTargetId, 'system', GATEWAY_DOWN)
    }
  }, [gw.status, downTargetId, store])

  // Session de run active → état du run + activité d'outils (M5).
  const activeWorkspace = active?.workspace
  const activeRunId = active?.id
  const refreshRun = useCallback(() => {
    if (mode !== 'server' || !activeWorkspace || !activeRunId) {
      setRun(null)
      return
    }
    let cancelled = false
    void api
      .getRun(activeWorkspace, activeRunId)
      .then((r) => {
        if (!cancelled) setRun(r)
      })
      .catch(() => {
        // Un journal sans workspace valide ou une API absente : pas de panneau.
        if (!cancelled) setRun(null)
      })
    return () => {
      cancelled = true
    }
  }, [activeRunId, activeWorkspace, mode])
  useEffect(() => {
    setRun(null)
    return refreshRun()
  }, [refreshRun])

  /** Décision humaine sur un appel d'outil en attente — puis rafraîchissement. */
  const handleResolved = useCallback(
    (decision: 'approve' | 'refuse', state: RunStateDto['state']) => {
      if (active) {
        store.appendMessage(
          active.id,
          'system',
          decision === 'approve'
            ? `Écriture approuvée — étape reprise (${state.status}).`
            : `Appel refusé — étape reprise sans l'écriture (${state.status}).`,
        )
      }
      refreshRun()
    },
    [active, refreshRun, store],
  )

  /** Création de session — journal serveur, ou locale en mode mémoire. */
  const createSession = useCallback(
    async (title?: string): Promise<SessionInfo> => {
      if (mode === 'server') {
        const dto = await api.createSession(title)
        return store.addSession({ id: dto.id, title: dto.title, createdAt: dto.createdAt })
      }
      return store.createSession(title)
    },
    [mode, store],
  )

  // --- Vue Workflows (M6) : listing, sélection, création de run. ---

  const refreshWorkspaces = useCallback(() => {
    if (mode !== 'server') return
    let cancelled = false
    void api
      .listWorkspaces()
      .then((list) => {
        if (!cancelled) setWsList(list)
      })
      .catch(() => {
        if (!cancelled) setWsList([])
      })
    return () => {
      cancelled = true
    }
  }, [mode])

  useEffect(() => {
    if (view !== 'workflows') return
    return refreshWorkspaces()
  }, [view, refreshWorkspaces])

  // Premier workspace parsable sélectionné d'office à l'ouverture de l'onglet.
  useEffect(() => {
    if (wsName !== null || wsList === null || wsList.length === 0) return
    const first = wsList.find((w) => w.error === undefined) ?? wsList[0]!
    setWsName(first.name)
  }, [wsList, wsName])

  /** Crée le run côté serveur et synchronise le store (la session apparaît dans l'onglet Sessions). */
  const createWorkflowRun = useCallback(
    (workspace: string, subject: string): Promise<RunStateDto> => {
      return api.createRun(workspace, subject).then((dto) => {
        store.addSession({ id: dto.id, title: dto.title, createdAt: dto.createdAt, workspace })
        return dto
      })
    },
    [store],
  )

  /** Fork d'une session : copie du journal, historique hérité, bascule dessus. */
  const doFork = useCallback(
    async (id: string) => {
      const src = store.findSessionById(id)
      if (!src) return
      try {
        if (mode === 'server') {
          const dto = await api.forkSession(id)
          store.addSession({ id: dto.id, title: dto.title, createdAt: dto.createdAt })
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

  const openNewSession = useCallback(
    async (title?: string) => {
      try {
        const s = await createSession(title)
        store.appendMessage(s.id, 'system', `Session « ${s.title} » créée.`)
        setActiveId(s.id)
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        if (active) store.appendMessage(active.id, 'system', `Création impossible : ${why}`)
      }
    },
    [active, createSession, store],
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

  const handleSend = useCallback(
    async (raw: string) => {
      if (!active) return
      const parsed = parseInput(raw)

      if (parsed.kind === 'command') {
        try {
          const out = await runCommand(
            { store, createSession, activeSessionId: active.id },
            parsed.name ?? '',
            parsed.args ?? '',
          )
          const targetId = out.newActiveId ?? active.id
          store.appendMessage(targetId, 'system', out.systemText)
          if (out.newActiveId) setActiveId(out.newActiveId)
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err)
          store.appendMessage(active.id, 'system', `Création impossible : ${why}`)
        }
        return
      }

      store.appendMessage(active.id, 'user', parsed.text)
      if (mode === 'server') {
        void api.appendChatEvent(active.id, 'user', parsed.text).catch((err) => {
          const why = err instanceof Error ? err.message : String(err)
          store.appendMessage(active.id, 'system', `Journalisation impossible — ${why}`)
        })
      }

      if (gw.status === 'up' && gw.selected) {
        // Flux réel via la passerelle (proxy /api → gemini-web2api).
        const history = toLlmHistory(store.listMessages(active.id))
        const placeholder = store.appendMessage(active.id, 'assistant', '')
        store.setStreaming(placeholder.id, true)
        void (async () => {
          try {
            for await (const token of client.chatStream({ model: gw.selected, messages: history })) {
              if (!store.appendText(placeholder.id, token)) break
            }
            store.setStreaming(placeholder.id, false)
            journalAssistant(active.id, placeholder.id)
          } catch (err) {
            const remaining = store.listMessages(active.id).find((m) => m.id === placeholder.id)
            if (!remaining) return // session effacée entre-temps
            if (remaining.text.trim() === '') {
              store.removeMessage(placeholder.id)
            } else {
              store.setStreaming(placeholder.id, false)
              journalAssistant(active.id, placeholder.id)
            }
            const why = err instanceof Error ? err.message : String(err)
            store.appendMessage(active.id, 'system', `Erreur passerelle : ${why}`)
          }
        })()
        return
      }

      // Repli simulé (passerelle absente) — comportement M1.
      const placeholder = store.appendMessage(active.id, 'assistant', '')
      store.setStreaming(placeholder.id, true)
      streamText(fakeReply(parsed.text), (token) => store.appendText(placeholder.id, token)).done.then(() => {
        store.setStreaming(placeholder.id, false)
        journalAssistant(active.id, placeholder.id)
      })
    },
    [active, client, createSession, gw.selected, gw.status, journalAssistant, mode, store],
  )

  if (!active) return null

  const headerTitle = view === 'workflows' ? (wsName ?? 'Workflows') : active.title

  return (
    <div className="app">
      <Sidebar
        view={view}
        onViewChange={setView}
        sessions={snap.sessions}
        activeId={active.id}
        onSelect={setActiveId}
        onNew={() => void openNewSession()}
        onFork={(id) => void doFork(id)}
        workspaces={mode === 'server' ? wsList : null}
        activeWorkspace={wsName}
        onSelectWorkspace={(name) => {
          setWsName(name)
          setSelectedRunId(null)
        }}
        onRefreshWorkspaces={() => refreshWorkspaces()}
      />
      <main className="main">
        <header className="main-head">
          <h2>{headerTitle}</h2>
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
        {view === 'workflows' ? (
          <WorkflowsView
            key={wsName ?? 'none'}
            name={wsName}
            memory={mode === 'memory'}
            model={gw.selected}
            modelAvailable={gw.status === 'up' && gw.selected !== ''}
            selectedRunId={selectedRunId}
            onSelectRun={setSelectedRunId}
            onCreateRun={(subject) => createWorkflowRun(wsName ?? '', subject)}
          />
        ) : (
          <>
            <ChatView messages={messages} />
            {mode === 'server' && active.workspace && run ? (
              <RunPanel
                workspace={active.workspace}
                run={run}
                onResolved={handleResolved}
                onError={(why) => active && store.appendMessage(active.id, 'system', `Décision impossible : ${why}`)}
              />
            ) : null}
            <Composer onSend={handleSend} />
          </>
        )}
      </main>
    </div>
  )
}
