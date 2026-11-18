import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createLogsHandler, createProfiler, JsonlLog, LOG_NAMES } from './logs.ts'

// M13 — le trio de profilage : append JSONL daté, stats, queue plafonnée,
// rotation à 8 Mio (trois rotations gardées), jamais fatal, /logs en
// lecture seule stricte (les trois noms, rien d'autre).

const dirs: string[] = []

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'nyw-logs-'))
  dirs.push(d)
  return d
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

describe('JsonlLog', () => {
  it('append ajoute une ligne JSONL datée ; stats et tail suivent', async () => {
    const dir = tmpDir()
    const log = new JsonlLog(dir, 'session.jsonl')
    await log.append({ kind: 'session.created', sessionId: 's1' })
    await log.append({ kind: 'user.message', sessionId: 's1', chars: 42 })
    const raw = readFileSync(join(dir, 'session.jsonl'), 'utf8')
    const lines = raw.split('\n').filter((l) => l.trim() !== '')
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0]!)
    expect(first.at).toBeDefined()
    expect(first.kind).toBe('session.created')
    expect(first.sessionId).toBe('s1')
    expect(log.stats()).toEqual({ name: 'session.jsonl', bytes: statSync(join(dir, 'session.jsonl')).size, lines: 2 })
    expect(await log.tail(1)).toBe(lines[1])
    expect(await log.tail(500)).toBe(raw.trimEnd())
  })

  it('fichier absent : stats à zéro, queue vide — jamais fatal', async () => {
    const dir = tmpDir()
    const log = new JsonlLog(dir, 'engine.jsonl')
    expect(log.stats()).toEqual({ name: 'engine.jsonl', bytes: 0, lines: 0 })
    expect(await log.tail(10)).toBe('')
  })

  it('rotation : au-delà de 8 Mio le fichier devient <nom>-<date>.jsonl, trois gardées', async () => {
    const dir = tmpDir()
    const log = new JsonlLog(dir, 'activity.jsonl')
    // Première passe : un gros faux fichier (9 Mio de texte).
    writeFileSync(join(dir, 'activity.jsonl'), 'x'.repeat(9 * 1024 * 1024) + '\n')
    await log.append({ kind: 'first-after-rotation' })
    const rotated = readdirSync(dir).filter((n) => n.startsWith('activity-') && n.endsWith('.jsonl'))
    expect(rotated).toHaveLength(1)
    expect(readFileSync(join(dir, 'activity.jsonl'), 'utf8')).toContain('first-after-rotation')

    // Trois rotations de plus : les plus anciennes sont élaguées.
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(dir, 'activity.jsonl'), 'x'.repeat(9 * 1024 * 1024) + '\n')
      await log.append({ kind: `turn-${i}` })
    }
    const kept = readdirSync(dir).filter((n) => n.startsWith('activity-') && n.endsWith('.jsonl'))
    expect(kept.length).toBeLessThanOrEqual(3)
    expect(existsSync(join(dir, 'activity.jsonl'))).toBe(true)
  })

  it('un dossier en lecture seule n’étouffe jamais le logger', async () => {
    const dir = tmpDir()
    // Un FICHIER à la place du dossier .logs — mkdir échouera silencieusement.
    const blocker = join(dir, '.logs-blocker')
    writeFileSync(blocker, 'pas un dossier')
    const log = new JsonlLog(blocker, 'session.jsonl')
    await log.append({ kind: 'nope' }) // ne lève pas : le harness doit tourner
    expect(existsSync(join(blocker, 'session.jsonl'))).toBe(false)
  })
})

describe('createProfiler + /logs (lecture seule)', () => {
  it('les quatre journaux grandissent séparément ; le handler liste et sert la queue', async () => {
    const dir = tmpDir()
    const profiler = createProfiler(dir)
    profiler.engine({ kind: 'boot' })
    profiler.session({ kind: 'session.created', sessionId: 's1' })
    profiler.activity({ kind: 'tool.call', tool: 'read' })
    profiler.model({ kind: 'model.response', sessionId: 's1', model: 'gemini-3.5-flash', round: 1 })
    await new Promise((r) => setTimeout(r, 50)) // appends are fire-and-forget

    for (const name of LOG_NAMES) {
      expect(existsSync(join(dir, name)), name).toBe(true)
    }

    const handler = createLogsHandler(profiler)
    // Le handler est monté sous /logs : il voit le chemin SANS le préfixe.
    const listRes = await call(handler, 'GET', '/')
    expect(listRes.status).toBe(200)
    const body = JSON.parse(listRes.body)
    expect(body.dir).toBe(dir)
    expect(body.files.map((f: { name: string }) => f.name)).toEqual([...LOG_NAMES])

    const tailRes = await call(handler, 'GET', '/session.jsonl?tail=5')
    expect(tailRes.status).toBe(200)
    expect(JSON.parse(tailRes.body).tail).toContain('session.created')

    // M16 — le journal du modèle se queue comme les autres.
    const modelTail = await call(handler, 'GET', '/model.jsonl?tail=5')
    expect(modelTail.status).toBe(200)
    expect(JSON.parse(modelTail.body).tail).toContain('model.response')

    // Hors des quatre journaux : 404, quelle que soit la méthode.
    expect((await call(handler, 'GET', '/secret.jsonl')).status).toBe(404)
    expect((await call(handler, 'GET', '/../session.jsonl')).status).toBe(404)
    expect((await call(handler, 'POST', '/engine.jsonl')).status).toBe(404)
  })

  it('traceHttp enregistre méthode, chemin, statut et durée de chaque requête', async () => {
    const dir = tmpDir()
    const profiler = createProfiler(dir)
    const traced = profiler.traceHttp((_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end('{}')
    })
    await call(traced, 'POST', '/sessions')
    await new Promise((r) => setTimeout(r, 50))
    const raw = readFileSync(join(dir, 'engine.jsonl'), 'utf8')
    expect(raw).toContain('"kind":"http"')
    expect(raw).toContain('"method":"POST"')
    expect(raw).toContain('"path":"/sessions"')
    expect(raw).toContain('"status":201')
  })
})

/** Minimal req/res pair for the handler, connect-style. */
/** biome-ignore lint/suspicious/noExplicitAny: test double of connect's req/res */
function call(handler: (req: any, res: any) => void, method: string, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = { method, url } as IncomingLike
    const finishListeners: (() => void)[] = []
    const res: ResLike = {
      writableEnded: false,
      statusCode: 0,
      writeHead(code: number, _headers?: Record<string, string>) {
        res.statusCode = code
        return res
      },
      end(body?: string) {
        res.writableEnded = true
        for (const fn of finishListeners.splice(0)) fn() // 'finish' à la http
        resolve({ status: res.statusCode ?? 0, body: body ?? '' })
        return res
      },
      on(_event: string, fn: () => void) {
        finishListeners.push(fn)
        return res
      },
    }
    handler(req, res)
  })
}

interface IncomingLike {
  method: string
  url: string
}

interface ResLike {
  writableEnded: boolean
  statusCode: number
  writeHead(code: number, headers?: Record<string, string>): ResLike
  end(body?: string): ResLike
  on(event: string, fn: () => void): ResLike
}
