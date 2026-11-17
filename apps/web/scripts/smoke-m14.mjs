/**
 * Manual M14 smoke test — boots the REAL app (vite preview, like a user),
 * then proves the pilot's three asks over HTTP:
 *   1. session folder mandatory (400 without workspace)
 *   2. .workspace/ complete ICM tree created inside the session folder
 *   3. .logs/<sessionId>/ trio profiling that session in its folder
 * Plus the ICM system prompt carries the harness identity.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createViteServer } from 'vite'

const home = mkdtempSync(join(tmpdir(), 'nyw-smoke-home-'))
const spaces = mkdtempSync(join(tmpdir(), 'nyw-smoke-spaces-'))
process.env.NYW_HOME = home
process.env.NYW_WORKSPACES = spaces
process.env.W2A_URL = ''

const server = await createViteServer({
  configFile: join(import.meta.dirname, '../vite.config.ts'),
  server: { port: 0, strictPort: false },
})
await server.listen()
const port = server.httpServer.address().port
const base = `http://127.0.0.1:${port}`
const api = async (path, init) => {
  const res = await fetch(`${base}${path}`, { headers: { 'content-type': 'application/json' }, ...init })
  return { status: res.status, body: await res.json().catch(() => null) }
}

const checks = []
const ok = (name, cond) => {
  checks.push([name, cond])
  console.log(`${cond ? '✓' : '✗ ÉCHEC'} — ${name}`)
}

// 1. Scaffold a workspace + create a session bound to it.
await api('/workspaces', { method: 'POST', body: JSON.stringify({ name: 'projet-fume' }) })
const noWs = await api('/sessions', { method: 'POST', body: JSON.stringify({ title: 'Orpheline' }) })
ok('POST /sessions sans workspace → 400', noWs.status === 400 && /obligatoire/.test(noWs.body.error))

const session = await api('/sessions', {
  method: 'POST',
  body: JSON.stringify({ title: 'Fumée', workspace: 'projet-fume', security: 'accept' }),
})
ok('session créée avec dossier', session.status === 201)
const sid = session.body.id

// 2. The .workspace/ tree inside the session folder.
const root = join(spaces, 'projet-fume')
ok('.workspace/CONTEXT.md dans le dossier', existsSync(join(root, '.workspace', 'CONTEXT.md')))
ok('.workspace/notes/plan.md', existsSync(join(root, '.workspace', 'notes', 'plan.md')))
ok('14 fichiers du scaffold', ['inbox/CONTEXT.md', 'notes/tasks.md', 'notes/journal.md', 'notes/decisions.md', 'research/sources.md', 'memory/core.md', 'memory/lessons.md', 'outputs/CONTEXT.md', 'archive/CONTEXT.md'].every((r) => existsSync(join(root, '.workspace', r))))

// 3. Tool call → per-session logs inside the folder.
await api(`/sessions/${sid}/events`, { method: 'POST', body: JSON.stringify({ type: 'user.message', text: 'bonjour la fumée' }) })
await api('/workspaces/projet-fume/tool', {
  method: 'POST',
  body: JSON.stringify({ sessionId: sid, tool: 'read', args: { path: '.workspace/CONTEXT.md' } }),
})
await api(`/sessions/${sid}/turn`, {
  method: 'POST',
  body: JSON.stringify({ model: 'gemini-2.5-flash', rounds: 1, ms: 800, outcome: 'ok', toolCalls: 1, thinkingChars: 0, textChars: 42 }),
})
await new Promise((r) => setTimeout(r, 400))
const logsRoot = join(root, '.logs', sid)
ok('.logs/<sessionId>/engine.jsonl dans le dossier', existsSync(join(logsRoot, 'engine.jsonl')))
const act = readFileSync(join(logsRoot, 'activity.jsonl'), 'utf8')
ok('activity.jsonl par session : tool.call + turn.completed', act.includes('"tool.call"') && act.includes('"turn.completed"'))
const ses = readFileSync(join(logsRoot, 'session.jsonl'), 'utf8')
ok('session.jsonl par session : created + user.message', ses.includes('"session.created"') && ses.includes('"user.message"'))

// 4. ICM system prompt: harness identity.
const icm = await api('/workspaces/projet-fume/icm')
const sys = icm.body.system
ok('prompt : identité harness NyWorkflow', sys.includes('harness NyWorkflow') && sys.includes('pas un chatbot'))
ok('prompt : agir = appeler un outil', sys.includes('Agir = appeler un outil'))
ok('prompt : .workspace/ et « ne les relis pas »', sys.includes('.workspace/') && sys.includes('ne les relis pas'))

// 5. Second session on the same folder keeps the living memory.
const before = readFileSync(join(root, '.workspace', 'notes', 'plan.md'), 'utf8')
const second = await api('/sessions', { method: 'POST', body: JSON.stringify({ title: 'Suite', workspace: 'projet-fume' }) })
ok('seconde session sur le même dossier', second.status === 201)
ok('mémoire vivante conservée (plan.md intact)', readFileSync(join(root, '.workspace', 'notes', 'plan.md'), 'utf8') === before)

await server.close()
rmSync(home, { recursive: true, force: true })
rmSync(spaces, { recursive: true, force: true })
const failed = checks.filter(([, c]) => !c)
console.log(`\n${checks.length - failed.length}/${checks.length} checks verts`)
process.exit(failed.length > 0 ? 1 : 0)
