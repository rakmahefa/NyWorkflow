/**
 * Profiling logs (M13, per-session M14, model log M16) — FOUR JSONL
 * files, the pilot's observability quartet, meant to be uploaded to the
 * repo to improve and refine the harness. TWO homes:
 *
 *   global  <home>/.logs/                  — the engine-wide quartet (M13):
 *     engine.jsonl   — server boot, gateway status, every /sessions +
 *                     /workspaces HTTP request (method, path, status, ms),
 *                     internal errors, the gateway's upstream turns;
 *     session.jsonl  — session lifecycle: created, renamed, forked,
 *                     deleted, security changed, chat events (sizes);
 *     activity.jsonl — every tool call and result (callId, ok, ms),
 *                     human decisions, workspace operations;
 *     model.jsonl    — M16: EVERY model response, round by round — the
 *                     thinking (titled), the text, the tool_calls (titled,
 *                     with their RAW arguments and parse verdict since
 *                     M17 — a malformed call stays visible), plus protocol
 *                     compliance (thinking first? titles filled? args ok?)
 *                     and the ICM prompt size (systemChars) — the raw
 *                     material that says whether the protocol is followed
 *                     in real life. M17 adds model.observation: the
 *                     tool-group RESULTS that circulate back to the model
 *                     (the third step of the protocol) — BOTH directions
 *                     of the wire, journalled.
 *
 *   session <folder>/.logs/<sessionId>/    — the SAME quartet, per session,
 *     INSIDE the session's folder (M14, pilot-driven): each session's
 *     full story (its turns, its chat, its tool activity, its model
 *     responses) is self-contained in its own folder, ready to be
 *     zipped and uploaded.
 *
 * One JSON object per line: `{ "at": ISO, "kind": "…", …payload }` —
 * append-only like the journals, never a source of truth, never fatal:
 * a logging failure logs to stderr and moves on (the harness must run
 * even with a read-only home).
 *
 * Rotation: at boot (and lazily per write) a file over 8 MiB is renamed
 * `<name>-<date>.jsonl`; the three most recent rotations survive, older
 * ones are deleted.
 */
import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'

/** The four logs, in listing order. */
export const LOG_NAMES = ['engine.jsonl', 'session.jsonl', 'activity.jsonl', 'model.jsonl'] as const
export type LogName = (typeof LOG_NAMES)[number]

const ROTATE_BYTES = 8 * 1024 * 1024
const ROTATE_KEEP = 3
/** Tail cap of GET /logs/:name (lines). */
const TAIL_MAX = 1000

const isLogName = (v: string): v is LogName => (LOG_NAMES as readonly string[]).includes(v)

/** One JSONL log — append, rotate, list, tail. */
export class JsonlLog {
  constructor(
    private readonly dir: string,
    private readonly name: LogName,
  ) {}

  private get file(): string {
    return join(this.dir, this.name)
  }

  /** Appends one record; rotation first when the file grew past the cap. */
  async append(record: Record<string, unknown>): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true })
      await this.rotateIfNeeded()
      await appendFile(this.file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, 'utf8')
    } catch (err) {
      console.error(`[logs] écriture ${this.name} impossible —`, err instanceof Error ? err.message : err)
    }
  }

  /** Over-cap → `<name>-<date>.jsonl`; keeps only the newest ROTATE_KEEP. */
  private async rotateIfNeeded(): Promise<void> {
    let size = 0
    try {
      size = statSync(this.file).size
    } catch {
      return // no file yet
    }
    if (size <= ROTATE_BYTES) return
    const stamp = new Date().toISOString().slice(0, 10)
    const target = join(this.dir, this.name.replace(/\.jsonl$/, `-${stamp}.jsonl`))
    try {
      renameSync(this.file, target)
    } catch {
      return // someone else rotated, or worse — never fatal
    }
    // Prune older rotations of THIS log.
    const prefix = this.name.replace(/\.jsonl$/, '-')
    const rotations = readdirSync(this.dir)
      .filter((n) => n.startsWith(prefix) && n.endsWith('.jsonl'))
      .sort()
    for (const old of rotations.slice(0, Math.max(0, rotations.length - ROTATE_KEEP))) {
      try {
        unlinkSync(join(this.dir, old))
      } catch {
        // best effort
      }
    }
  }

  /** Stats for the Settings card: bytes + line count. */
  stats(): { name: LogName; bytes: number; lines: number } {
    try {
      if (!existsSync(this.file)) return { name: this.name, bytes: 0, lines: 0 }
      const raw = readFileSync(this.file, 'utf8')
      return {
        name: this.name,
        bytes: statSync(this.file).size,
        lines: raw.split('\n').filter((l) => l.trim() !== '').length,
      }
    } catch {
      return { name: this.name, bytes: 0, lines: 0 }
    }
  }

  /** The last `lines` records, raw text (the pilot reads them as-is). */
  async tail(lines: number): Promise<string> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      return ''
    }
    const all = raw.split('\n').filter((l) => l.trim() !== '')
    return all.slice(-Math.max(1, Math.min(lines, TAIL_MAX))).join('\n')
  }
}

/** The quartet, plus the HTTP handler that exposes them read-only. */
export interface Profiler {
  readonly dir: string
  engine(record: Record<string, unknown>): void
  session(record: Record<string, unknown>): void
  activity(record: Record<string, unknown>): void
  /** M16 — the model's responses (one record per round). */
  model(record: Record<string, unknown>): void
  /** Wraps a handler: every request lands in engine.jsonl (status, ms). */
  traceHttp(handler: (req: IncomingMessage, res: ServerResponse) => void): (req: IncomingMessage, res: ServerResponse) => void
}

export function createProfiler(dir: string): Profiler {
  const engine = new JsonlLog(dir, 'engine.jsonl')
  const session = new JsonlLog(dir, 'session.jsonl')
  const activity = new JsonlLog(dir, 'activity.jsonl')
  const model = new JsonlLog(dir, 'model.jsonl')
  const fire = (log: JsonlLog, record: Record<string, unknown>): void => {
    void log.append(record)
  }

  return {
    dir,
    engine: (record) => fire(engine, record),
    session: (record) => fire(session, record),
    activity: (record) => fire(activity, record),
    model: (record) => fire(model, record),
    traceHttp(handler) {
      return (req, res) => {
        const started = Date.now()
        const method = req.method ?? '?'
        const url = (req.url ?? '/').split('?')[0] ?? '/'
        // Status capture: wrap writeHead once — cheap and dependency-free.
        const original = res.writeHead.bind(res)
        let status = 0
        // biome-ignore lint/suspicious/noExplicitAny: connect's res typing is loose here
        res.writeHead = ((code: any, ...rest: any[]) => {
          status = typeof code === 'number' ? code : 500
          // biome-ignore lint/suspicious/noExplicitAny: same
          return (original as any)(code, ...rest)
        }) as typeof res.writeHead
        res.on('finish', () => {
          fire(engine, { kind: 'http', method, path: url, status, ms: Date.now() - started })
        })
        handler(req, res)
      }
    },
  }
}

/** Per-session profilers (M14) — `<sessionFolder>/.logs/<sessionId>/`,
 * cached per (folder, session) so a turn's many writes reuse the logs. */
const sessionProfilers = new Map<string, Profiler>()

/** The per-session trio inside the session's own folder. */
export function sessionProfiler(sessionFolder: string, sessionId: string): Profiler {
  const key = `${sessionFolder}::${sessionId}`
  let p = sessionProfilers.get(key)
  if (p === undefined) {
    p = createProfiler(join(sessionFolder, '.logs', sessionId))
    sessionProfilers.set(key, p)
  }
  return p
}

/** Drops the cached profiler of a deleted session (the files stay — they
 * are the session's durable story, zipped and uploaded by the pilot). */
export function dropSessionProfiler(sessionFolder: string, sessionId: string): void {
  sessionProfilers.delete(`${sessionFolder}::${sessionId}`)
}

/** GET /logs → listing; GET /logs/:name?tail=N → the last lines. Read-only. */
export function createLogsHandler(profiler: Profiler): (req: IncomingMessage, res: ServerResponse) => void {
  const logs = Object.fromEntries(LOG_NAMES.map((n) => [n, new JsonlLog(profiler.dir, n)])) as Record<LogName, JsonlLog>

  function send(res: ServerResponse, status: number, body: unknown): void {
    if (res.writableEnded) return
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  return function logsApi(req, res): void {
    const method = req.method ?? 'GET'
    const rawUrl = req.url ?? '/'
    const query = rawUrl.includes('?') ? new URLSearchParams(rawUrl.slice(rawUrl.indexOf('?') + 1)) : null
    const url = rawUrl.split('?')[0] || '/'
    void (async () => {
      if ((url === '/' || url === '') && method === 'GET') {
        return send(res, 200, { dir: profiler.dir, files: LOG_NAMES.map((n) => logs[n].stats()) })
      }
      const parts = url.replace(/^\//, '').split('/')
      if (parts.length === 1 && isLogName(parts[0] ?? '') && method === 'GET') {
        const name = parts[0] as LogName
        const tail = Number.parseInt(query?.get('tail') ?? '200', 10)
        const text = await logs[name].tail(Number.isNaN(tail) ? 200 : tail)
        return send(res, 200, { name, tail: text, stats: logs[name].stats() })
      }
      return send(res, 404, { error: 'route inconnue' })
    })().catch((err: unknown) => {
      console.error('[logs] erreur interne', err)
      return send(res, 500, { error: 'Erreur interne du serveur de logs' })
    })
  }
}
