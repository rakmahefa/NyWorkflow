import { createWeb2ApiClient } from '@nyworkflow/adapter-llm'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ChatView } from './components/ChatView'
import { Composer } from './components/Composer'
import { ModelPicker } from './components/ModelPicker'
import { Sidebar } from './components/Sidebar'
import { parseInput, runCommand } from './lib/commands'
import { fakeReply, streamText } from './lib/fakeLLM'
import { useGatewayStatus } from './lib/gateway'
import { toLlmHistory } from './lib/history'
import { SessionStore } from './lib/store'
import { APP_VERSION } from './lib/version'

const WELCOME = 'Bienvenue dans NyWorkflow (M2). Tapez /help pour les commandes.'
const GATEWAY_DOWN =
  'Passerelle gemini-web2api absente (127.0.0.1:8081) — réponses simulées. Lancez la passerelle du repo ny-gemini-acp pour le streaming réel.'

/**
 * M2 shell: sessions + chat + model picker. Real streaming when the
 * gemini-web2api gateway answers through /api; simulated fallback when
 * it does not (clear system notice, never a silent failure).
 */
export default function App() {
  const [boot] = useState(() => {
    const store = new SessionStore()
    const first = store.createSession()
    store.appendMessage(first.id, 'system', WELCOME)
    const client = createWeb2ApiClient({ baseUrl: '/api' })
    return { store, client, activeId: first.id }
  })
  const { store, client } = boot
  const [activeId, setActiveId] = useState(boot.activeId)
  const gw = useGatewayStatus(client)

  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const active = snap.sessions.find((s) => s.id === activeId) ?? snap.sessions.at(-1) ?? null
  const messages = active ? snap.messages.filter((m) => m.sessionId === active.id) : []

  // Annonce une seule fois l'absence de passerelle, dans la session active.
  const announcedDown = useRef(false)
  const downTargetId = active?.id
  useEffect(() => {
    if (gw.status === 'down' && !announcedDown.current && downTargetId) {
      announcedDown.current = true
      store.appendMessage(downTargetId, 'system', GATEWAY_DOWN)
    }
  }, [gw.status, downTargetId, store])

  const openNewSession = useCallback(
    (title?: string) => {
      const s = store.createSession(title)
      store.appendMessage(s.id, 'system', `Session « ${s.title} » créée.`)
      setActiveId(s.id)
    },
    [store],
  )

  const handleSend = useCallback(
    (raw: string) => {
      if (!active) return
      const parsed = parseInput(raw)

      if (parsed.kind === 'command') {
        const out = runCommand(store, parsed.name ?? '', parsed.args ?? '', active.id)
        const targetId = out.newActiveId ?? active.id
        store.appendMessage(targetId, 'system', out.systemText)
        if (out.newActiveId) setActiveId(out.newActiveId)
        return
      }

      store.appendMessage(active.id, 'user', parsed.text)

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
          } catch (err) {
            const remaining = store.listMessages(active.id).find((m) => m.id === placeholder.id)
            if (!remaining) return // session effacée entre-temps
            if (remaining.text.trim() === '') {
              store.removeMessage(placeholder.id)
            } else {
              store.setStreaming(placeholder.id, false)
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
      streamText(fakeReply(parsed.text), (token) => store.appendText(placeholder.id, token)).done.then(
        () => store.setStreaming(placeholder.id, false),
      )
    },
    [store, active, gw.status, gw.selected, client],
  )

  if (!active) return null

  return (
    <div className="app">
      <Sidebar
        sessions={snap.sessions}
        activeId={active.id}
        onSelect={setActiveId}
        onNew={() => openNewSession()}
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
            <span className="tag">M2 · v{APP_VERSION}</span>
          </div>
        </header>
        <ChatView messages={messages} />
        <Composer onSend={handleSend} />
      </main>
    </div>
  )
}
