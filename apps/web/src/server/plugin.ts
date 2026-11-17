/**
 * Vite plugin exposing the server APIs on the dev AND preview servers:
 *
 *   /sessions   — journals (M3, M11: workspace binding, deletion):
 *                 list, create, append chat events, fork, delete.
 *   /workspaces — agentic ICM surface (M11): list, scaffold, ICM loading,
 *                 file preview, agent tool calls + human decisions. No LLM
 *                 client server-side anymore: the model loop lives in the
 *                 browser (standard tool_calls through the /api proxy).
 *
 * M8: the plugin ALSO starts the webapi gateway in-process (see embed.ts) —
 * `pnpm dev` / `pnpm preview` bring the whole harness up in one command.
 * Skipped when W2A_URL points elsewhere (e2e mock) or NYW_WEBAPI_EMBED=0.
 *
 * Journals live under `.nyworkflow/` and workspaces under
 * `examples/workspaces/` at the repo root (apps/web sits at <repo>/apps/web,
 * hence '../..'). NYW_HOME / NYW_WORKSPACES override both locations — used
 * by the integration tests; factory options win over the env vars.
 */
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, PreviewServer, ViteDevServer } from 'vite'
import { createSessionsHandler } from './handler.ts'
import { createWorkspacesHandler } from './workspaces.ts'
import { startEmbeddedGateway, type EmbeddedGateway } from './embed.ts'

export interface NyworkflowServerPluginOptions {
  /** Forces the NyWorkflow home (tests). Default: NYW_HOME, else <repo>/.nyworkflow. */
  home?: string
  /** Forces the workspaces folder (tests). Default: NYW_WORKSPACES, else <repo>/examples/workspaces. */
  workspacesDir?: string
  /** Forces the embedded gateway (tests). Default: environment rules — see embed.ts. */
  embedGateway?: boolean
}

/** Minimal shape of Vite's connect middleware stack. */
interface MiddlewareStack {
  use(route: string, handler: (req: IncomingMessage, res: ServerResponse) => void): void
}

export function nyworkflowServerPlugin(options: NyworkflowServerPluginOptions = {}): Plugin {
  let home = ''
  let workspacesDir = ''
  let gateway: EmbeddedGateway | undefined

  function mount(middlewares: MiddlewareStack): void {
    middlewares.use('/sessions', createSessionsHandler(home, { workspacesDir }))
    middlewares.use('/workspaces', createWorkspacesHandler({ dir: workspacesDir, home }))
  }

  async function embed(): Promise<void> {
    gateway = await startEmbeddedGateway({ embedGateway: options.embedGateway })
  }

  return {
    name: 'nyworkflow-server',
    configResolved(config) {
      home = options.home || process.env.NYW_HOME || path.resolve(config.root, '../../.nyworkflow')
      workspacesDir = options.workspacesDir || process.env.NYW_WORKSPACES || path.resolve(config.root, '../../examples/workspaces')
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
