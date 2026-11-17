/**
 * Construction du payload `f.req` (l'encodage interne batchexecute de Google)
 * et extraction des jetons de page. Port fidèle de ny-gemini-acp/llm-provider :
 * chaque index du tableau interne a une signification imposée par l'interface
 * Gemini — les tests verrouillent les positions une à une.
 */

export interface PageTokens {
  /** Jeton XSRF « at » (SNlM0e). */
  at?: string
  pushId?: string
  pctx?: string
}

/** Version du serveur web Gemini — extraite de la page, pas codée en dur. */
const BL_RE = /boq_assistant-bard-web-server_\d{8}\.\d+_p\d+/

export function extractField(body: string, key: string): string | undefined {
  const hay = `"${key}":"`
  const start = body.indexOf(hay)
  if (start < 0) return undefined
  const from = start + hay.length
  const end = body.indexOf('"', from)
  if (end < 0) return undefined
  const value = body.slice(from, end)
  return value.length > 0 ? value : undefined
}

export function extractPageTokens(body: string): PageTokens {
  return {
    at: extractField(body, 'SNlM0e'),
    pushId: extractField(body, 'qKIAYe'),
    pctx: extractField(body, 'Ylro7b'),
  }
}

export function extractBl(body: string): string | undefined {
  return body.match(BL_RE)?.[0]
}

/** Encodage application/x-www-form-urlencoded : « + » pour l'espace, %XX majuscules. */
export function urlencode(params: [string, string][]): string {
  return params
    .map(([k, v]) => `${enc(k)}=${enc(v)}`)
    .join('&')
}

function enc(s: string): string {
  let out = ''
  for (const ch of s) {
    if (/[A-Za-z0-9\-_.~]/.test(ch)) out += ch
    else if (ch === ' ') out += '+'
    else {
      for (const byte of Buffer.from(ch, 'utf8')) out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }
  return out
}

export interface PayloadModel {
  mode: number
  think: number
  extra?: Record<string, number>
}

let reqidCounter = 0

/** _reqid : dérive du temps + un compteur — chaque requête porte un identifiant distinct. */
export function nextReqid(): number {
  const counter = reqidCounter++
  const unixNow = Math.floor(Date.now() / 1000)
  return (((unixNow * 100_000) % 1_000_000) + (counter % 100_000)) % 1_000_000
}

/** Corps POST urlencodé : f.req=… (+ at=… si jeton de page connu). */
export function buildFreq(prompt: string, model: PayloadModel, refs: string[], xsrf?: string): string {
  const inner: unknown[] = new Array(102).fill(null)
  const refsJson = refs.length === 0 ? null : refs.map((r) => [null, null, r])
  inner[0] = [prompt, 0, null, refsJson, null, null, 0]
  inner[1] = ['en']
  inner[2] = ['', '', '', null, null, null, null, null, null, '']
  inner[6] = [0]
  inner[7] = 1
  inner[10] = 1
  inner[11] = 0
  inner[17] = [[model.think]]
  inner[18] = 0
  inner[27] = 1
  inner[30] = [4]
  inner[41] = [2]
  inner[53] = 0
  inner[59] = crypto.randomUUID()
  inner[61] = []
  inner[68] = 1
  inner[79] = model.mode
  if (model.extra) {
    for (const [k, v] of Object.entries(model.extra)) {
      const idx = Number(k)
      if (Number.isInteger(idx) && idx >= 0 && idx < 102) inner[idx] = v
    }
  }
  const outer = [null, JSON.stringify(inner)]
  const params: [string, string][] = [['f.req', JSON.stringify(outer)]]
  if (xsrf) params.push(['at', xsrf])
  return urlencode(params)
}
