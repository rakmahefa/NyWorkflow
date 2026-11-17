/**
 * Vite plugin exposing the /sessions API on the dev AND preview servers.
 *
 * The journals live under `.nyworkflow/sessions/` at the repo root
 * (apps/web sits at <repo>/apps/web, hence '../..'). NYW_HOME overrides
 * the location — used by the restart-integration test; the factory option
 * wins over the env var.
 */
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, PreviewServer, ViteDevServer } from 'vite'
import { createSessionsHandler } from './handler.ts'

export interface SessionsPluginOptions {
  /** Forces the NyWorkflow home (tests). Default: NYW_HOME, else <repo>/.nyworkflow. */
  home?: string
}

/** Minimal shape of Vite's connect middleware stack. */
interface MiddlewareStack {
  use(route: string, handler: (req: IncomingMessage, res: ServerResponse) => void): void
}

export function nyworkflowSessionsPlugin(options: SessionsPluginOptions = {}): Plugin {
  let home = ''

  function mount(middlewares: MiddlewareStack): void {
    middlewares.use('/sessions', createSessionsHandler(home))
  }

  return {
    name: 'nyworkflow-sessions',
    configResolved(config) {
      home = options.home || process.env.NYW_HOME || path.resolve(config.root, '../../.nyworkflow')
    },
    configureServer(server: ViteDevServer) {
      mount(server.middlewares as unknown as MiddlewareStack)
    },
    configurePreviewServer(server: PreviewServer) {
      mount(server.middlewares as unknown as MiddlewareStack)
    },
  }
}
