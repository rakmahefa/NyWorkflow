/**
 * Passerelle webapi INTÉGRÉE au serveur web (M8) — la réponse à « passerelle
 * absente » : avant, il fallait lancer `pnpm webapi` à part ; désormais
 * `pnpm dev` (et `pnpm preview`) démarrent la passerelle dans le même
 * processus, sur le port que le proxy /api vise déjà.
 *
 * Règles d'engagement :
 *   - W2A_URL défini            → cible externe (maquette e2e, autre passerelle) :
 *                                 pas d'intégration, on respecte la cible.
 *   - NYW_WEBAPI_EMBED=0        → intégration coupée explicitement.
 *   - sous Vitest (VITEST=1)    → pas d'intégration (les tests montent la
 *                                 leur, port éphémère via embedGateway).
 *   - port déjà occupé          → une passerelle externe tourne (ex. `pnpm
 *                                 webapi`) : on l'utilise telle quelle.
 *
 * Toute la config vient de NYW_WEBAPI_* (voir @nyworkflow/webapi/config.ts) —
 * dont NYW_WEBAPI_PORT/HOST, suivi par le proxy /api de vite.config.ts.
 */
import net from 'node:net'
import { loadWebApiConfig, createWebApiServer, webApiProviderFromConfig } from '@nyworkflow/webapi'

export interface EmbeddedGateway {
  /** true si la passerelle intégrée écoute, false si externalisée/désactivée. */
  embedded: boolean
  /** Pourquoi la passerelle intégrée n'écoute pas (quand embedded = false). */
  reason?: 'external-target' | 'disabled' | 'busy' | 'tests'
  close(): Promise<void>
}

function portInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect({ host, port })
    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.once('error', () => resolve(false))
    // Filet de sécurité : au-delà, on considère le port occupé (on ne démarre pas).
    const guard = setTimeout(() => {
      probe.destroy()
      resolve(true)
    }, 2_000)
    guard.unref()
    probe.once('close', () => clearTimeout(guard))
  })
}

/** Log préfixé — visible dans la console du serveur web, jamais en JSON. */
function log(message: string): void {
  console.log(`[nyworkflow:webapi] ${message}`)
}

export interface EmbedOptions {
  /** Force l'intégration même sous Vitest (les tests embed l'utilisent). */
  embedGateway?: boolean
  /** Environnement injectable (tests). */
  env?: Record<string, string | undefined>
}

/**
 * Démarre la passerelle intégrée selon les règles d'engagement ci-dessus.
 * Ne lève JAMAIS : un échec de démarrage est dégradé en raison lisible.
 */
export async function startEmbeddedGateway(options: EmbedOptions = {}): Promise<EmbeddedGateway> {
  const env = options.env ?? process.env
  const forced = options.embedGateway ?? (env.VITEST === undefined || env.VITEST === '')

  if (!forced) return { embedded: false, reason: 'tests', close: async () => undefined }
  if (env.NYW_WEBAPI_EMBED === '0') return { embedded: false, reason: 'disabled', close: async () => undefined }
  if (env.W2A_URL !== undefined && env.W2A_URL !== '') {
    return { embedded: false, reason: 'external-target', close: async () => undefined }
  }

  const config = loadWebApiConfig(env)
  if (await portInUse(config.host, config.port)) {
    log(`une passerelle écoute déjà sur ${config.host}:${config.port} — utilisée telle quelle`)
    return { embedded: false, reason: 'busy', close: async () => undefined }
  }

  const provider = webApiProviderFromConfig(config)
  const server = createWebApiServer(config, provider)

  const listening = new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  server.listen(config.port, config.host)
  try {
    await listening
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    log(`démarrage impossible sur ${config.host}:${config.port} (${why}) — continuer sans passerelle intégrée`)
    return { embedded: false, reason: 'busy', close: async () => undefined }
  }

  const d = provider.describe()
  const accounts = d.rawCookies
    ? 'cookies env (NYW_WEBAPI_COOKIES)'
    : d.accounts.length > 1
      ? `${d.accounts.length} comptes cookies dans ${d.cookieFile}`
      : d.cookies
        ? `cookies : ${d.cookieFile}`
        : `cookies absents (${d.cookieFile}) — voir USERGUIDE.md`
  log(`passerelle intégrée sur http://${config.host}:${config.port} · modèle ${d.defaultModel} · ${accounts}`)

  return {
    embedded: true,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
