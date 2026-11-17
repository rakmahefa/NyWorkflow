import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkToolCall, executeToolCall, isDangerous } from './tools.ts'
import type { ToolCall } from './tools.ts'
import { cleanHtml, decodeEntities, parseDuckDuckGoLite, runWebsearch, checkWebUrl } from './websearch.ts'
import type { FetchLike } from './websearch.ts'

// M11 — les trois nouveaux outils : mkdir (libre, l'agent façonne son
// arbre), shell (approbation, cwd = racine du workspace, délai 30 s,
// flux bornés), websearch (recherche DDG Lite + lecture d'URL, contenu
// NETTOYÉ — scripts, nav, en-têtes et attributs partis, balises
// sémantiques gardées, tout plafonné).

const roots: string[] = []

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nyw-tools-m11-'))
  roots.push(dir)
  writeFileSync(join(dir, 'CONTEXT.md'), '# Carte\n', 'utf8')
  return dir
}

const mkdirCall = (path: string): ToolCall => ({ tool: 'mkdir', args: { path } })
const shellCall = (command: string): ToolCall => ({ tool: 'shell', args: { command } })
const webCall = (args: Record<string, unknown>): ToolCall => ({ tool: 'websearch', args })

// ------------------------------------------------------------------ mkdir

describe('mkdir (M11)', () => {
  it("n'est pas dangereux : le modèle crée ses dossiers sans approbation", async () => {
    expect(isDangerous('mkdir')).toBe(false)
    const root = sandbox()
    const check = await checkToolCall(root, mkdirCall('notes/2026-11'))
    expect(check.ok).toBe(true)
    expect(check.approval).toBe(false)
  })

  it('crée le dossier (récursif) et rend le chemin relatif', async () => {
    const root = sandbox()
    const out = await executeToolCall(root, mkdirCall('research/ddg/2026'), false)
    expect(out.ok).toBe(true)
    expect(existsSync(join(root, 'research', 'ddg', '2026'))).toBe(true)
    if (out.ok) expect(out.data).toEqual({ path: 'research/ddg/2026' })
  })

  it('refuse hors périmètre, comme tous les outils à chemin', async () => {
    const root = sandbox()
    const out = await executeToolCall(root, mkdirCall('../ailleurs'), false)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.code).toBe('out_of_scope')
  })

  it('refuse un chemin vide ou "."', async () => {
    const root = sandbox()
    expect((await checkToolCall(root, mkdirCall(''))).ok).toBe(false)
    expect((await checkToolCall(root, mkdirCall('.'))).ok).toBe(false)
  })
})

// ------------------------------------------------------------------ shell

describe('shell (M11)', () => {
  it("est dangereux : approbation requise avant exécution", async () => {
    expect(isDangerous('shell')).toBe(true)
    const root = sandbox()
    const check = await checkToolCall(root, shellCall('echo coucou'))
    expect(check.ok).toBe(true)
    expect(check.approval).toBe(true)
  })

  it('exécute avec le workspace pour cwd, rend stdout/stderr et le code', async () => {
    const root = sandbox()
    const out = await executeToolCall(root, shellCall('pwd && echo bonjour 1>&2'), true)
    expect(out.ok).toBe(true)
    if (out.ok) {
      const data = out.data as { exitCode: number | null; stdout: string; stderr: string }
      expect(data.exitCode).toBe(0)
      expect(data.stdout.trim()).toBe(root)
      expect(data.stderr).toContain('bonjour')
    }
  })

  it('code de sortie non nul rendu honnêtement (ok: true, exitCode ≠ 0)', async () => {
    const root = sandbox()
    const out = await executeToolCall(root, shellCall('exit 3'), true)
    expect(out.ok).toBe(true)
    if (out.ok) expect((out.data as { exitCode: number | null }).exitCode).toBe(3)
  })

  it('bornes : flux tronqué à 16 Kio, commande ≤ 4000 caractères', async () => {
    const root = sandbox()
    const out = await executeToolCall(root, shellCall('seq 1 100000'), true)
    expect(out.ok).toBe(true)
    if (out.ok) {
      const data = out.data as { stdout: string; truncated: boolean }
      expect(data.stdout.length).toBeLessThanOrEqual(16_384)
      expect(data.truncated).toBe(true)
    }
    const tooLong = 'x'.repeat(4001)
    const check = await checkToolCall(root, shellCall(tooLong))
    expect(check.ok).toBe(false)
  })

  it('commande vide refusée avant exécution', async () => {
    const root = sandbox()
    const check = await checkToolCall(root, shellCall(''))
    expect(check.ok).toBe(false)
  })
})

// ------------------------------------------------------------------ websearch

/** Stub fetch — scripté par test, zéro réseau. */
function fakeFetch(routes: { match: RegExp; status?: number; body?: string; type?: string }[]): FetchLike {
  return async (url: string) => {
    for (const r of routes) {
      if (r.match.test(url)) {
        return {
          ok: (r.status ?? 200) < 400,
          status: r.status ?? 200,
          headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? (r.type ?? 'text/html') : null) },
          text: async () => r.body ?? '',
        }
      }
    }
    throw new Error('injoignable (stub)')
  }
}

describe('websearch — recherche (mode query)', () => {
  it('analyse une page DDG Lite : titres, URLs, snippets, sans pubs ni doublons', () => {
    const html = [
      '<html><body><table>',
      '<tr><td>1.</td></tr>',
      '<tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexemple.fr%2Fa&amp;rut=abc">Résultat A</a></td></tr>',
      '<tr><td class="result-snippet">Le <b>meilleur</b> A</td></tr>',
      '<tr><td><a rel="nofollow" href="https://exemple.fr/b">Résultat B</a></td></tr>',
      '<tr><td class="result-snippet">Snippet B</td></tr>',
      '<tr><td><a rel="nofollow" href="https://exemple.fr/b">Doublon B</a></td></tr>',
      '<tr><td><a rel="nofollow" href="https://duckduckgo.com/y.js?ad=1">Publicité</a></td></tr>',
      '</table></body></html>',
    ].join('')
    const results = parseDuckDuckGoLite(html)
    expect(results).toEqual([
      { title: 'Résultat A', url: 'https://exemple.fr/a', snippet: 'Le meilleur A' },
      { title: 'Résultat B', url: 'https://exemple.fr/b', snippet: 'Snippet B' },
    ])
  })

  it('passe la requête encodée à DDG Lite et rend les résultats au modèle', async () => {
    let seen = ''
    const fetcher: FetchLike = async (url: string) => {
      seen = url
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'text/html' },
        text: async () =>
          '<tr><td><a rel="nofollow" href="https://fr.wikipedia.org/wiki/Loutre">Loutre — Wikipédia</a></td></tr><tr><td class="result-snippet">La loutre est un mammifère.</td></tr>',
      }
    }
    const out = await runWebsearch({ query: 'loutre europe' }, fetcher)
    expect(seen).toBe('https://lite.duckduckgo.com/lite/?q=loutre%20europe')
    expect(out.ok).toBe(true)
    if (out.ok) {
      const data = out.data as { results: { url: string; title: string }[] }
      expect(data.results[0]?.url).toBe('https://fr.wikipedia.org/wiki/Loutre')
    }
  })

  it('réseau ou HTTP en échec → refus io_error, jamais une exception', async () => {
    const dead = fakeFetch([])
    const unreachable = await runWebsearch({ query: 'test' }, dead)
    expect(unreachable.ok).toBe(false)

    const http500 = fakeFetch([{ match: /lite\.duckduckgo/, status: 500, body: 'oups' }])
    const failed = await runWebsearch({ query: 'test' }, http500)
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.summary).toContain('HTTP 500')
  })

  it('query et url ensemble → refus invalid_args', async () => {
    const out = await runWebsearch({ query: 'a', url: 'https://b.fr' }, fakeFetch([]))
    expect(out.ok).toBe(false)
  })
})

describe('websearch — lecture (mode url) : le nettoyage', () => {
  it('checkWebUrl : http(s) seulement, longueur bornée', () => {
    expect(checkWebUrl('https://exemple.fr/a?b=1')).toBe('https://exemple.fr/a?b=1')
    expect(checkWebUrl('http://exemple.fr')).toBe('http://exemple.fr/')
    expect(checkWebUrl('ftp://exemple.fr')).toBeNull()
    expect(checkWebUrl('pas une url')).toBeNull()
    expect(checkWebUrl(`https://exemple.fr/${'a'.repeat(2100)}`)).toBeNull()
  })

  it('cleanHtml : vire scripts/styles/nav/header/footer/commentaires, garde les balises sémantiques', () => {
    const html = [
      '<html><head><title>Titre page</title><style>.a{color:red}</style></head>',
      '<body>',
      '<header><nav>Menu ACCUEIL CONTACT</nav></header>',
      '<script>var x = "toto";</script>',
      '<!-- un commentaire -->',
      '<main>',
      '<h1 class="big" onclick="boom()">Grand titre</h1>',
      '<p style="margin:0">Premier <strong>paragraphe</strong> avec un <a href="https://exemple.fr/page" target="_blank">lien</a>.</p>',
      '<div class="wrapper"><span>Span neutre</span></div>',
      '<ul><li>Un</li><li>Deux</li></ul>',
      '<pre><code class="lang-ts">const a = 1</code></pre>',
      '</main>',
      '<footer>Pied de page légal © 2026</footer>',
      '<img src="data:image/png;base64,AAAAAA" alt="bannière">',
      '</body></html>',
    ].join('')
    const { title, content } = cleanHtml(html)
    expect(title).toBe('Titre page')
    expect(content).toContain('<h1>Grand titre</h1>')
    expect(content).toContain('<p>Premier <strong>paragraphe</strong> avec un <a href="https://exemple.fr/page">lien</a>.</p>')
    expect(content).toContain('<li>Un</li>')
    expect(content).toContain('<pre><code>const a = 1</code></pre>')
    // Le texte des balises non sémantiques survit, la balise non.
    expect(content).toContain('Span neutre')
    expect(content).not.toContain('<div>')
    expect(content).not.toContain('<span>')
    // Le tout-venant est parti.
    expect(content).not.toContain('color:red')
    expect(content).not.toContain('toto')
    expect(content).not.toContain('Menu ACCUEIL')
    expect(content).not.toContain('Pied de page')
    expect(content).not.toContain('un commentaire')
    expect(content).not.toContain('onclick')
    expect(content).not.toContain('base64')
  })

  it('cleanHtml : data: URI virée, alt gardé, sauts de ligne des blocs préservés', () => {
    const html = '<h1>Titre</h1><p>Un.</p><p>Deux.</p><br><p>Trois.</p><img src="/img/x.png" alt="desc">'
    const { content } = cleanHtml(html)
    expect(content).toBe('<h1>Titre</h1>\n<p>Un.</p>\n<p>Deux.</p>\n<br>\n<p>Trois.</p>\n<img src="/img/x.png" alt="desc">')
  })

  it('cleanHtml : contenu plafonné à WEB_PAGE_MAX avec marqueur de troncature', () => {
    const big = `<p>${'a'.repeat(80_000)}</p>`
    const { content } = cleanHtml(big)
    expect(content.length).toBeLessThanOrEqual(65_536 + 100)
    expect(content).toContain('tronqué à 65536 caractères')
  })

  it('mode url : contenu non-HTML refusé, page nettoyée rendue avec son titre', async () => {
    const pdf = fakeFetch([{ match: /exemple\.fr\/doc/, type: 'application/pdf', body: '%PDF' }])
    const refused = await runWebsearch({ url: 'https://exemple.fr/doc.pdf' }, pdf)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.summary).toContain('non-HTML')

    const page = fakeFetch([
      {
        match: /exemple\.fr\/article/,
        body: '<html><head><title>Article</title></head><body><script>evil()</script><article><p>Contenu utile.</p></article></body></html>',
      },
    ])
    const out = await runWebsearch({ url: 'https://exemple.fr/article' }, page)
    expect(out.ok).toBe(true)
    if (out.ok) {
      const data = out.data as { title: string; content: string; url: string }
      expect(data.title).toBe('Article')
      expect(data.content).toContain('<p>Contenu utile.</p>')
      expect(data.content).not.toContain('evil()')
    }
  })

  it('decodeEntities : usuelles décodées, &lt; et &gt; préservés (texte échappé)', () => {
    expect(decodeEntities('a&amp;b&quot;c&#39;d&nbsp;e')).toBe("a&b\"c'd e")
    expect(decodeEntities('x &lt;code&gt; y')).toBe('x &lt;code&gt; y')
    expect(decodeEntities('&#65;&#66;')).toBe('AB')
  })
})
