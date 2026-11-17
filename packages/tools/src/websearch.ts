/**
 * websearch (M11) — the model's window on the web, zero dependency.
 *
 * Two modes, one tool:
 *   { "query": "…" } → DuckDuckGo Lite search → [{ title, url, snippet }]
 *   { "url": "…" }   → fetch the page → CLEANED content (tags kept)
 *
 * The cleaning is the point (asked by the pilot): everything that saturates
 * the model's context is stripped — <script>, <style>, <nav>, page headers
 * and footers, forms, buttons, HTML comments, every attribute except
 * href/src/alt — while the STRUCTURE survives: the semantic tags (h1..h6,
 * p, ul/li, table, pre/code, a…) are kept so the content stays readable
 * and interpretable. The result is capped (WEB_PAGE_MAX).
 *
 * `fetch` is injectable: the tests script it, production uses the global.
 */
import type { ToolOutcome } from './tools.ts'

/** User-agent — honest about who is calling. */
const WEBSEARCH_UA = 'NyWorkflowAgent/0.2 (+https://github.com/rakmahefa/NyWorkflow)'
/** DuckDuckGo Lite — the plainest search surface, no JS required. */
const SEARCH_ENDPOINT = 'https://lite.duckduckgo.com/lite/?q='
const FETCH_TIMEOUT_MS = 15_000
const QUERY_MAX = 400
const URL_MAX = 2048
/** Results kept per search — the model fetches pages it cares about. */
const RESULTS_MAX = 8
/** Cleaned page cap (chars) — enough to work with, never the whole site. */
export const WEB_PAGE_MAX = 65_536
/** Raw HTML read cap (chars) — a page bigger than this is not read whole. */
const RAW_HTML_MAX = 2_000_000
const SNIPPET_MAX = 400

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}>

const defaultFetch: FetchLike = (url, init) => fetch(url, init)

/** Basic HTML entity decode — &lt; and &gt; stay escaped (they mark user text). */
export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d: string) => {
      const code = Number.parseInt(d, 10)
      return code > 0 && code < 0x10_000 ? String.fromCodePoint(code) : _
    })
}

const escapeAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/** Resolves a DuckDuckGo redirect href (//duckduckgo.com/l/?uddg=…) to its target. */
function resolveHref(raw: string): string {
  const href = decodeEntities(raw.trim())
  if (href.startsWith('//')) {
    try {
      return resolveHref(`https:${href}`)
    } catch {
      return href
    }
  }
  const m = href.match(/duckduckgo\.com\/l\/\?(?:[^#]*&)?uddg=([^&]+)/i)
  if (m !== null) {
    try {
      return decodeURIComponent(m[1] as string)
    } catch {
      return href
    }
  }
  return href
}

const stripTags = (s: string): string => decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()

/**
 * Parses a DuckDuckGo Lite results page: [{ title, url, snippet }] —
 * deduplicated, ads (y.js redirects) and internal links skipped, capped.
 * Lite's table alternates: a link row, then a snippet row — pairing is
 * order-based (pending link + next snippet).
 */
export function parseDuckDuckGoLite(html: string): { title: string; url: string; snippet: string }[] {
  const out: { title: string; url: string; snippet: string }[] = []
  const seen = new Set<string>()
  const push = (r: { title: string; url: string; snippet: string }): void => {
    if (seen.has(r.url)) return
    seen.add(r.url)
    out.push(r)
  }
  let pending: { title: string; url: string; snippet: string } | null = null
  const rows = html.split(/<tr\b[^>]*>/i)
  for (const row of rows) {
    const snip = row.match(/<td\b[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/i)
    if (pending !== null && snip !== null) {
      pending.snippet = stripTags(snip[1] ?? '').slice(0, SNIPPET_MAX)
      push(pending)
      pending = null
      if (out.length >= RESULTS_MAX) break
      continue
    }
    const link =
      row.match(/<a\b[^>]*rel="nofollow"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i) ??
      row.match(/<a\b[^>]*href="([^"]*)"[^>]*rel="nofollow"[^>]*>([\s\S]*?)<\/a>/i)
    if (link === null) continue
    if (pending !== null) {
      push(pending) // link without snippet — kept, the next link is here
      pending = null
    }
    const url = resolveHref(link[1] ?? '')
    const title = stripTags(link[2] ?? '')
    if (url === '' || title === '') continue
    if (/duckduckgo\.com\//i.test(url)) continue // internal links, ads (y.js)
    if (seen.has(url)) continue
    pending = { title, url, snippet: '' }
  }
  if (pending !== null) push(pending)
  return out.slice(0, RESULTS_MAX)
}

/** Tags whose whole BLOCK is junk for the model — removed, content included. */
const JUNK_BLOCKS =
  /<(script|style|noscript|template|svg|iframe|object|embed|nav|header|footer|aside|form|button|select|option|textarea|canvas|dialog|menu|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi

/** Structural tags that survive cleaning (attributes stripped, content kept). */
const KEEP_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'blockquote', 'pre',
  'code', 'strong', 'em', 'b', 'i', 'u', 's', 'a', 'img', 'figure', 'figcaption',
])

/** Block-level closers that earn a newline, so collapsed text stays readable. */
const BLOCK_CLOSERS = /<\/(h[1-6]|p|li|tr|blockquote|pre|ul|ol|table|figure|figcaption|dt|dd|caption)>/gi

/**
 * Cleans an HTML page for the model: junk blocks and comments removed,
 * non-semantic markup stripped (text kept), attributes reduced to
 * href/src/alt (data: URIs dropped), whitespace collapsed, block breaks
 * preserved, entities decoded (except &lt;/&gt;), content capped.
 */
export function cleanHtml(html: string): { title: string; content: string } {
  const title = stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').slice(0, 300))
  let s = html.slice(0, RAW_HTML_MAX)
  s = s.replace(JUNK_BLOCKS, '')
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  // data: URIs are megabytes of base64 for the model — drop the attribute value.
  s = s.replace(/\s(?:src|href)\s*=\s*(["'])data:[^"']*\1/gi, '')
  s = s.replace(/<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (whole, name: string, attrs: string) => {
    const tag = name.toLowerCase()
    if (!KEEP_TAGS.has(tag)) return '' // non-semantic markup → inner text only
    if (tag === 'a') {
      const href = attrs.match(/\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/i)
      const clean = href !== null ? (href[1] ?? href[2] ?? '') : ''
      return `<a href="${escapeAttr(decodeEntities(clean))}">`
    }
    if (tag === 'img') {
      const src = attrs.match(/\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i)
      const alt = attrs.match(/\salt\s*=\s*(?:"([^"]*)"|'([^']*)')/i)
      const parts = [
        `src="${escapeAttr(decodeEntities(src?.[1] ?? src?.[2] ?? ''))}"`,
        `alt="${escapeAttr(decodeEntities(alt?.[1] ?? alt?.[2] ?? ''))}"`,
      ]
      return `<img ${parts.join(' ')}>`
    }
    return `<${tag}>`
  })
  s = s.replace(BLOCK_CLOSERS, (m) => `${m}\n`).replace(/<br\s*\/?>/gi, '<br>\n')
  s = s.replace(/[ \t]*\n[ \t]*/g, '\n')
  s = s.replace(/[\t ]+/g, ' ')
  s = s.replace(/\n{3,}/g, '\n\n')
  const content = s.trim().slice(0, WEB_PAGE_MAX)
  return { title, content: content.length >= WEB_PAGE_MAX ? `${content}\n… (tronqué à ${WEB_PAGE_MAX} caractères)` : content }
}

/** Validates an http(s) URL and caps its length. */
export function checkWebUrl(raw: string): string | null {
  const t = raw.trim()
  if (t.length === 0 || t.length > URL_MAX) return null
  try {
    const u = new URL(t)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

/**
 * Executes one websearch call (already validated by checkToolCall).
 * Expected failures are refusals (French summaries), never throws.
 */
export async function runWebsearch(
  args: Record<string, unknown>,
  fetchImpl: FetchLike = defaultFetch,
): Promise<ToolOutcome> {
  const argString = (key: string): string | undefined => (typeof args[key] === 'string' ? (args[key] as string) : undefined)
  const query = argString('query')
  const url = argString('url')
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)

  if (query !== undefined && url !== undefined) {
    return { ok: false, code: 'invalid_args', summary: 'websearch : donnez query (recherche) OU url (page), pas les deux' }
  }

  if (query !== undefined && query.trim() !== '') {
    const q = query.trim()
    if (q.length > QUERY_MAX) {
      return { ok: false, code: 'invalid_args', summary: `websearch : requête trop longue (max ${QUERY_MAX} caractères)` }
    }
    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await fetchImpl(`${SEARCH_ENDPOINT}${encodeURIComponent(q)}`, {
        headers: { 'user-agent': WEBSEARCH_UA, accept: 'text/html' },
        signal,
      })
    } catch {
      return { ok: false, code: 'io_error', summary: 'websearch refusé — recherche injoignable (réseau ?)' }
    }
    if (!res.ok) return { ok: false, code: 'io_error', summary: `websearch refusé — recherche indisponible (HTTP ${res.status})` }
    const html = await res.text().catch(() => '')
    const results = parseDuckDuckGoLite(html)
    return {
      ok: true,
      summary: `websearch « ${q} » — ${results.length} résultat${results.length > 1 ? 's' : ''}`,
      data: {
        query: q,
        results,
        hint: results.length === 0 ? 'aucun résultat — reformulez, ou lisez une URL directement (mode url)' : undefined,
      },
    }
  }

  if (url !== undefined && url.trim() !== '') {
    const target = checkWebUrl(url)
    if (target === null) return { ok: false, code: 'invalid_args', summary: 'websearch : url http(s) valide attendue' }
    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await fetchImpl(target, { headers: { 'user-agent': WEBSEARCH_UA, accept: 'text/html' }, signal })
    } catch {
      return { ok: false, code: 'io_error', summary: `websearch refusé — page injoignable : ${target}` }
    }
    if (!res.ok) return { ok: false, code: 'io_error', summary: `websearch refusé — HTTP ${res.status} sur ${target}` }
    const type = res.headers.get('content-type') ?? ''
    if (!/text\/html|application\/xhtml/i.test(type)) {
      return { ok: false, code: 'io_error', summary: `websearch refusé — contenu non-HTML (${type || 'type inconnu'})` }
    }
    const html = await res.text().catch(() => '')
    const cleaned = cleanHtml(html)
    if (cleaned.content.trim() === '') {
      return { ok: false, code: 'io_error', summary: `websearch refusé — page sans contenu exploitable : ${target}` }
    }
    return {
      ok: true,
      summary: `websearch « ${target} » — ${cleaned.content.length} caractères nettoyés`,
      data: { url: target, title: cleaned.title, content: cleaned.content },
    }
  }

  return { ok: false, code: 'invalid_args', summary: 'websearch attend query (recherche) ou url (page à lire)' }
}
