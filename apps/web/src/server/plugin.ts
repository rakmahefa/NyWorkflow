/**
 * Vite plugin exposing the server APIs on the dev AND preview servers:
 *
 *   /sessions   — journals (M3, M11: workspace binding, deletion; M13:
 *                 security level, completed turns):
 *                 list, create, append chat events, fork, delete.
 *   /workspaces — agentic ICM surface (M11): list, scaffold, ICM loading,
 *                 file preview, agent tool calls + human decisions. No LLM
 *                 client server-side anymore: the model loop lives in the
 *                 browser (standard tool_calls through the /api proxy).
 *   /logs       — M13: the profiling trio, read-only (list + tail).
 *
 * M8: the plugin ALSO starts the webapi gateway in-process (see embed.ts) —
 * `pnpm dev` / `pnpm preview` bring the whole harness up in one command.
 * Skipped when W2A_URL points elsewhere (e2e mock) or NYW_WEBAPI_EMBED=0.
 * M13: the gateway's upstream turns land in the engine log via onTurn.
 *
 * Journals live under `.nyworkflow/`, workspaces under
 * `examples/workspaces/` and the profiling logs under `.nyworkflow/.logs/`
 * at the repo root (apps/web sits at <repo>/apps/web, hence '../..').
 * NYW_HOME / NYW_WORKSPACES / NYW_LOGS_DIR override the locations — used
 * by the integration tests; factory options win over the env vars.
 */
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, PreviewServer, ViteDevServer } from 'vite'
import { createSessionsHandler } from './handler.ts'
import { createWorkspacesHandler } from './workspaces.ts'
import { startEmbeddedGateway, type EmbeddedGateway } from './embed.ts'
import { createLogsHandler, createProfiler, type Profiler } from './logs.ts'

export interface NyworkflowServerPluginOptions {
  /** Forces the NyWorkflow home (tests). Default: NYW_HOME, else <repo>/.nyworkflow. */
  home?: string
  /** Forces the workspaces folder (tests). Default: NYW_WORKSPACES, else <repo>/examples/workspaces. */
  workspacesDir?: string
  /** Forces the embedded gateway (tests). Default: environment rules — see embed.ts. */
  embedGateway?: boolean
  /** Forces the profiling logs folder (tests). Default: NYW_LOGS_DIR, else <home>/.logs. */
  logsDir?: string
  /** Disables the profiling logs entirely (tests that assert file trees). */
  noLogs?: boolean
}

/** Minimal shape of Vite's connect middleware stack. */
interface MiddlewareStack {
  use(route: string, handler: (req: IncomingMessage, res: ServerResponse) => void): void
}

export function nyworkflowServerPlugin(options: NyworkflowServerPluginOptions = {}): Plugin {
  let home = ''
  let workspacesDir = ''
  let logsDir = ''
  let profiler: Profiler | undefined
  let gateway: EmbeddedGateway | undefined

  function mount(middlewares: MiddlewareStack): void {
    const sessions = createSessionsHandler(home, { workspacesDir, profiler })
    const workspaces = createWorkspacesHandler({ dir: workspacesDir, home, profiler })
    // M13 — every /sessions and /workspaces request lands in engine.jsonl
    // (method, path, status, ms): the profiling the pilot asked for.
    middlewares.use('/sessions', profiler !== undefined ? profiler.traceHttp(sessions) : sessions)
    middlewares.use('/workspaces', profiler !== undefined ? profiler.traceHttp(workspaces) : workspaces)
    if (profiler !== undefined) middlewares.use('/logs', createLogsHandler(profiler))
  }

  async function embed(): Promise<void> {
    gateway = await startEmbeddedGateway({
      embedGateway: options.embedGateway,
      onEngineEvent: (event) => profiler?.engine(event),
    })
    profiler?.engine({
      kind: 'gateway.status',
      embedded: gateway.embedded,
      reason: gateway.reason,
    })
  }

  return {
    name: 'nyworkflow-server',
    configResolved(config) {
      home = options.home || process.env.NYW_HOME || path.resolve(config.root, '../../.nyworkflow')
      workspacesDir = options.workspacesDir || process.env.NYW_WORKSPACES || path.resolve(config.root, '../../examples/workspaces')
      logsDir = options.logsDir || process.env.NYW_LOGS_DIR || path.join(home, '.logs')
      if (!options.noLogs) profiler = createProfiler(logsDir)
      profiler?.engine({ kind: 'boot', mode: config.command, home, workspacesDir, logsDir })
    },
    configureServer(server: ViteDevServer) {
      mount(server.middlewares as unknown as MiddlewareStack)
      void embed()
      return () => {
        void gateway?.close()
      }
    },
    configurePreviewServer(server: PreviewServer) {
      mount(server.middlewares as unknown as MiddlewareStack)
      void embed()
      return () => {
        void gateway?.close()
      }
    },
  }
}
