/**
 * Audit S1 — l'origine des requêtes mutantes. Le serveur écoute en local
 * (pnpm dev / preview), mais n'importe quelle page web visitée pendant ce
 * temps peut poster des requêtes « simples » (no-cors, content-type
 * text/plain) sur /workspaces et /sessions : enregistrer un dossier, créer
 * une session en « accept », lancer un shell. La parade minimale et
 * honnête : un navigateur envoie TOUJOURS l'en-tête Origin sur ces
 * requêtes — on refuse celles dont l'origine n'est pas le serveur
 * lui-même. curl, les tests serveur et tout client non-navigateur
 * n'envoient pas Origin : ils passent (l'outil local reste un outil
 * local). Ce n'est pas une authentification — c'est la fermeture de la
 * porte drive-by du navigateur.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** True when the request may proceed: no Origin header (non-browser
 * client), or an Origin whose host:port equals the request's own Host. */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false // malformed Origin (sandboxed iframes send "null") — refuse
  }
}

/** Answers 403 for a cross-origin request. Returns true when refused. */
export function refuseCrossOrigin(req: IncomingMessage, res: ServerResponse): boolean {
  if (sameOrigin(req)) return false
  if (!res.writableEnded) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'origine non autorisée — le harness ne parle qu’à sa propre UI' }))
  }
  return true
}
