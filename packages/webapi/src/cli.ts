#!/usr/bin/env node
/**
 * Point d'entrée de la passerelle : `pnpm webapi` (bin nyworkflow-webapi).
 * Toute la configuration vient de l'environnement NYW_WEBAPI_* — voir config.ts.
 * Boucle 127.0.0.1:8081 par défaut : remplacement direct de l'ancienne
 * passerelle gemini-web2api, sans changer une ligne côté NyWorkflow.
 *
 * Note : depuis M8, `pnpm dev` démarre AUSSI la passerelle intégrée — ce CLI
 * sert au lancement autonome (plusieurs passerelles, autre port, etc.).
 */
import path from 'node:path'
import { loadWebApiConfig } from './config.ts'
import { createWebApiServer, webApiProviderFromConfig } from './server.ts'
import { WEBAPI_VERSION } from './version.ts'

const config = loadWebApiConfig()
const provider = webApiProviderFromConfig(config)
const server = createWebApiServer(config, provider)

server.on('error', (err) => {
  console.error(`Impossible d'écouter sur ${config.host}:${config.port} — ${err.message}`)
  process.exit(1)
})

server.listen(config.port, config.host, () => {
  const d = provider.describe()
  const accounts = d.accounts
  console.log(`@nyworkflow/webapi v${WEBAPI_VERSION} — http://${config.host}:${config.port}`)
  console.log(`provider ${provider.id} · modèle par défaut ${d.defaultModel} · ${d.models.length} modèles`)
  console.log(`bl : ${d.bl ?? 'auto-découvert au premier tour'}`)
  if (d.rawCookies) {
    console.log(`cookies : env NYW_WEBAPI_COOKIES (${d.cookies ? 'valides' : 'invalides'})`)
  } else if (accounts.length > 1) {
    const ok = accounts.filter((a) => a.cookies).length
    console.log(`multi-comptes : ${accounts.length} fichiers dans ${d.cookieFile} (${ok} valides) — rotation sur erreur d'authentification`)
  } else {
    console.log(`cookies : ${d.cookies ? 'présents' : `absents (${d.cookieFile}) — voir USERGUIDE.md`}`)
  }

  // M9 — sessions /u/N par compte + expiration vue d'avance.
  const sessions = accounts.filter((a) => a.authUser !== undefined)
  if (sessions.length > 0) {
    console.log(
      `sessions : ${sessions
        .map((a) => `${a.label ?? path.basename(a.file)} → /u/${a.authUser} ${a.cookies === false ? '(cookies expirés ou absents)' : ''}`.trim())
        .join(' · ')}`,
    )
  } else if (d.authUser !== null) {
    console.log(`session : /u/${d.authUser} (NYW_WEBAPI_AUTH_USER — pas de manifeste par compte)`)
  }
  const nowSec = Math.floor(Date.now() / 1000)
  const soon = accounts.filter((a) => a.expiresAt !== undefined && a.expiresAt > nowSec && a.expiresAt <= nowSec + 7 * 86_400)
  const dead = accounts.filter((a) => a.expiresAt !== undefined && a.expiresAt <= nowSec)
  for (const a of dead) {
    console.log(`expiration : ${a.label ?? path.basename(a.file)} — cookies expirés, rechargez le fichier (voir USERGUIDE.md)`)
  }
  for (const a of soon) {
    const days = Math.max(1, Math.round((a.expiresAt! - nowSec) / 86_400))
    console.log(`expiration : ${a.label ?? path.basename(a.file)} — cookies expirés dans ~${days} j`)
  }
  console.log(`proxy : ${d.proxy ?? 'aucun'}`)
  console.log('Ctrl+C pour arrêter.')
})

let closing = false
function shutdown(): void {
  if (closing) return
  closing = true
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3_000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
