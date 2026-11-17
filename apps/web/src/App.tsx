import { useCallback, useState, useSyncExternalStore } from 'react'
import { ChatView } from './components/ChatView'
import { Composer } from './components/Composer'
import { Sidebar } from './components/Sidebar'
import { parseInput, runCommand } from './lib/commands'
import { fakeReply, streamText } from './lib/fakeLLM'
import { SessionStore } from './lib/store'
import { APP_VERSION } from './lib/version'

const WELCOME = 'Bienvenue dans NyWorkflow (M1). Tapez /help pour les commandes.'

/**
 * M1 shell: sessions sidebar + chat + composer, with a simulated model.
 * The store is created once; the first session exists from the start.
 */
export default function App() {
  const [boot] = useState(() => {
    const store = new SessionStore()
    const first = store.createSession()
    store.appendMessage(first.id, 'system', WELCOME)
    return { store, activeId: first.id }
  })
  const { store } = boot
  const [activeId, setActiveId] = useState(boot.activeId)

  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const active = snap.sessions.find((s) => s.id === activeId) ?? snap.sessions.at(-1) ?? null
  const messages = active ? snap.messages.filter((m) => m.sessionId === active.id) : []

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
      const placeholder = store.appendMessage(active.id, 'assistant', '')
      store.setStreaming(placeholder.id, true)
      streamText(fakeReply(parsed.text), (token) => store.appendText(placeholder.id, token)).done.then(
        () => store.setStreaming(placeholder.id, false),
      )
    },
    [store, active],
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
          <span className="tag">M1 · v{APP_VERSION}</span>
        </header>
        <ChatView messages={messages} />
        <Composer onSend={handleSend} />
      </main>
    </div>
  )
}
