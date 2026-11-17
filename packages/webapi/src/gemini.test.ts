import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { GeminiWebClient, GeminiError, backoffMs } from './gemini.ts'
import { startMockGemini, parseStreamBody, DISCOVERED_BL, type MockGemini, type MockGeminiOptions } from './mock-gemini.ts'

const COOKIES = 'SAPISID=test-sapisid; HSID=h1'

interface ClientOpts {
  mock?: MockGeminiOptions
  client?: Record<string, unknown>
}

/** Monte une maquette Gemini + un client branché dessus, démonte après. */
async function withClient(
  opts: ClientOpts,
  fn: (mock: MockGemini, client: GeminiWebClient) => Promise<void>,
): Promise<void> {
  const mock = await startMockGemini(opts.mock)
  try {
    const client = new GeminiWebClient({ baseUrl: mock.baseUrl, rawCookies: COOKIES, retryAttempts: 1, retryDelayMs: 1, ...opts.client })
    await fn(mock, client)
  } finally {
    await mock.close()
  }
}

async function collect(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const item of gen) out.push(item)
  return out
}

describe('GeminiWebClient — tour complet contre la maquette', () => {
  it('rafraîchit la page, envoie la requête exacte et reconstruit les deltas', async () => {
    await withClient({}, async (mock, client) => {
      const deltas: string[] = []
      for await (const item of client.stream({ prompt: 'Sujet de test', model: 'gemini-3.6-flash' })) {
        if (item.type === 'text') deltas.push(item.delta)
      }
      expect(deltas).toEqual(['Bonjour, ', 'le monde'])
      expect(await client.complete({ prompt: 're', model: 'gemini-3.6-flash' })).toBe('Bonjour, le monde')

      // La page a été consultée pour les jetons et le bl.
      expect(mock.pageHits()).toBeGreaterThanOrEqual(1)

      const posts = mock.streamPosts()
      expect(posts).toHaveLength(2) // un pour le stream, un pour complete()
      const post = posts[0] as (typeof posts)[number]

      // URL : bl découvert sur la page, hl, _reqid, rt=c.
      expect(post.url).toContain('StreamGenerate')
      expect(post.url).toContain(`bl=${encodeURIComponent(DISCOVERED_BL)}`)
      expect(post.url).toContain('hl=en')
      expect(post.url).toMatch(/_reqid=\d+/)
      expect(post.url).toContain('rt=c')

      // En-têtes : cookie, SAPISIDHASH, formulaire, origine.
      const h = post.headers
      expect(String(h.cookie)).toContain('SAPISID=test-sapisid')
      expect(String(h.authorization)).toMatch(/^SAPISIDHASH \d+_[0-9a-f]{40}$/)
      expect(h['content-type']).toBe('application/x-www-form-urlencoded;charset=utf-8')
      expect(h.origin).toBe('https://gemini.google.com')
      expect(String(h.referer)).toBe('https://gemini.google.com/app')
      expect(h['x-same-domain']).toBe('1')
      expect(String(h['user-agent'])).toContain('Chrome/')

      // Corps : at de la page, prompt en case 0, mode en case 79.
      const { at, inner } = parseStreamBody(post.body)
      expect(at).toBe('at-1')
      expect((inner[0] as unknown[])[0]).toBe('Sujet de test')
      expect(inner[79]).toBe(1)
      expect(inner[17]).toEqual([[4]])
    })
  })

  it('le bl forcé par config gagne sur la découverte', async () => {
    await withClient({ client: { bl: 'boq_force_p9' } }, async (mock) => {
      const client = new GeminiWebClient({ baseUrl: mock.baseUrl, rawCookies: COOKIES, bl: 'boq_force_p9' })
      await client.complete({ prompt: 'x', model: 'gemini-auto' })
      expect(mock.streamPosts()[0]?.url).toContain('bl=boq_force_p9')
    })
  })

  it('les métadonnées traversent, les textes s’assemblent', async () => {
    const metaLine = JSON.stringify([['wrb.fr', [62, 0], JSON.stringify({ finishReason: 'STOP' })], ['di', 72]])
    const textLine = JSON.stringify([['wrb.fr', [62, 0], JSON.stringify([null, ['t'], 'p'.repeat(10), [], [['c', ['Réponse ', 'complète']]], [], [], []])], ['di', 72]])
    await withClient(
      { mock: { streamPlan: [{ kind: 'ok', rawLines: [metaLine, textLine] }] } },
      async (_mock, client) => {
        const items = await collect(client.stream({ prompt: 'q', model: 'gemini-3.6-flash' }))
        const kinds = items.map((i) => (i as { type: string }).type)
        expect(kinds).toContain('metadata')
        expect(kinds).toContain('text')
        const text = items
          .filter((i) => (i as { type: string }).type === 'text')
          .map((i) => (i as { delta: string }).delta)
          .join('')
        expect(text).toBe('Réponse complète')
      },
    )
  })
})

describe('GeminiWebClient — divergence de snapshots', () => {
  it('un snapshot divergent est ignoré jusqu’au retour à la compatibilité', async () => {
    await withClient(
      { mock: { streamPlan: [{ kind: 'ok', snapshots: ['Bonjouir', 'Bonjour, monde', 'Bonjouir, monde'] }] } },
      async (_mock, client) => {
        const deltas: string[] = []
        for await (const item of client.stream({ prompt: 'x', model: 'gemini-3.6-flash' })) {
          if (item.type === 'text') deltas.push(item.delta)
        }
        // « Bonjour, monde » diverge de « Bonjouir » (déjà émis) → ignoré ;
        // « Bonjouir, monde » est compatible → seul le suffixe est émis.
        expect(deltas.join('')).toBe('Bonjouir, monde')
      },
    )
  })

  it('divergence jamais réconciliée → erreur typée, pas de texte perdu silencieusement', async () => {
    await withClient(
      { mock: { streamPlan: [{ kind: 'ok', snapshots: ['Abc', 'Xyz'] }] } },
      async (_mock, client) => {
        await expect(async () => {
          for await (const _item of client.stream({ prompt: 'x', model: 'gemini-3.6-flash' })) {
            // consomme jusqu’à l’erreur
          }
        }).rejects.toMatchObject({ kind: 'divergence' } as Partial<GeminiError>)
      },
    )
  })
})

describe('GeminiWebClient — résilience (le cœur de la refonte)', () => {
  it('HTTP 400 → jetons de page rafraîchis puis retry qui passe', async () => {
    await withClient(
      {
        mock: { streamPlan: [{ kind: 'status', status: 400 }, { kind: 'ok', snapshots: ['Résultat'] }] },
        client: { retryAttempts: 3, retryDelayMs: 1 },
      },
      async (mock, client) => {
        const text = await client.complete({ prompt: 'x', model: 'gemini-3.6-flash' })
        expect(text).toBe('Résultat')
        expect(mock.streamPosts()).toHaveLength(2) // 400 puis 200
        expect(mock.pageHits()).toBeGreaterThanOrEqual(2) // refresh AVANT le retry
        // Le second POST porte le jeton de la seconde visite de page.
        expect(parseStreamBody(mock.streamPosts()[1]?.body ?? '').at).toBe('at-2')
      },
    )
  })

  it('BardErrorInfo 401 → erreur d’authentification fatale, aucun retry', async () => {
    const badLine = JSON.stringify([['wrb.fr', [62, 0], '{erreur amont BardErrorInfo [401]'], ['di', 72]])
    await withClient(
      { mock: { streamPlan: [{ kind: 'ok', rawLines: [badLine] }] }, client: { retryAttempts: 3, retryDelayMs: 1 } },
      async (mock, client) => {
        await expect(async () => {
          for await (const _item of client.stream({ prompt: 'x', model: 'gemini-3.6-flash' })) {}
        }).rejects.toMatchObject({ kind: 'authentication' } as Partial<GeminiError>)
        expect(mock.streamPosts()).toHaveLength(1)
      },
    )
  })

  it('flux vide → retenté puis erreur explicite (amélioration documentée vs ny-gemini-acp)', async () => {
    const emptyLine = JSON.stringify([['wrb.fr', [62, 0], JSON.stringify({ finishReason: 'STOP' })], ['di', 72]])
    await withClient(
      { mock: { streamPlan: [{ kind: 'ok', rawLines: [emptyLine] }] }, client: { retryAttempts: 2, retryDelayMs: 1 } },
      async (mock, client) => {
        await expect(async () => {
          for await (const _item of client.stream({ prompt: 'x', model: 'gemini-3.6-flash' })) {}
        }).rejects.toMatchObject({ kind: 'empty' } as Partial<GeminiError>)
        expect(mock.streamPosts()).toHaveLength(2)
      },
    )
  })

  it('blockReason → refus de sécurité, message actionnable', async () => {
    const blockedLine = JSON.stringify([['wrb.fr', [62, 0], JSON.stringify({ blockReason: 'SAFETY' })], ['di', 72]])
    await withClient({ mock: { streamPlan: [{ kind: 'ok', rawLines: [blockedLine] }] } }, async (mock, client) => {
      await expect(async () => {
        for await (const _item of client.stream({ prompt: 'x', model: 'gemini-3.6-flash' })) {}
      }).rejects.toMatchObject({ kind: 'safety' } as Partial<GeminiError>)
      expect(mock.streamPosts()).toHaveLength(1)
    })
  })

  it('annulation : le générateur se termine proprement, sans erreur', async () => {
    await withClient(
      { mock: { streamPlan: [{ kind: 'ok', snapshots: ['premier'], delayMs: 60, hang: true }] } },
      async (_mock, client) => {
        const controller = new AbortController()
        const received: string[] = []
        for await (const item of client.stream({ prompt: 'x', model: 'gemini-3.6-flash', signal: controller.signal })) {
          if (item.type === 'text') {
            received.push(item.delta)
            controller.abort() // assez tôt : la réponse amont reste ouverte
          }
        }
        expect(received.join('')).toBe('premier') // terminé, pas d’exception
      },
    )
  })

  it('un tool_call pendant une complétion texte est une erreur explicite', async () => {
    const toolLine = JSON.stringify([['wrb.fr', [62, 0], JSON.stringify({ functionCall: { name: 'glob', arguments: {} } })], ['di', 72]])
    await withClient({ mock: { streamPlan: [{ kind: 'ok', rawLines: [toolLine] }] } }, async (_mock, client) => {
      await expect(client.complete({ prompt: 'x', model: 'gemini-3.6-flash' })).rejects.toThrow(/glob/)
    })
  })
})

describe('GeminiWebClient — cookies vivants', () => {
  it('le fichier de cookies est relu dès que sa date de modification change', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nyw-gemini-'))
    try {
      const file = path.join(dir, 'cookie.json')
      writeFileSync(file, JSON.stringify([{ name: 'SAPISID', value: 'old-sapisid', domain: '.google.com' }]))
      const mock = await startMockGemini()
      try {
        const client = new GeminiWebClient({ baseUrl: mock.baseUrl, cookieFile: file, retryAttempts: 1, retryDelayMs: 1 })
        await client.complete({ prompt: 'un', model: 'gemini-3.6-flash' })
        expect(String(mock.streamPosts()[0]?.headers.cookie)).toBe('SAPISID=old-sapisid')

        writeFileSync(file, JSON.stringify([{ name: 'SAPISID', value: 'new-sapisid', domain: '.google.com' }]))
        const later = new Date(Date.now() + 2000)
        utimesSync(file, later, later) // mtime franchement différente

        await client.complete({ prompt: 'deux', model: 'gemini-3.6-flash' })
        expect(String(mock.streamPosts()[1]?.headers.cookie)).toBe('SAPISID=new-sapisid')
      } finally {
        await mock.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('GeminiWebClient — diagnostic', () => {
  it('describe() : cookies, bl (null avant tout tour), modèles — sans réseau', async () => {
    const client = new GeminiWebClient({ rawCookies: COOKIES })
    const d = client.describe()
    expect(d.cookies).toBe(true)
    expect(d.bl).toBeNull()
    expect(d.defaultModel).toBe('gemini-3.6-flash')
    expect(d.models).toHaveLength(8)

    const bare = new GeminiWebClient({})
    expect(bare.describe().cookies).toBe(false)
  })
})

describe('backoffMs', () => {
  it('croît, plafonne à 30 s ± jitter', () => {
    const first = backoffMs(1, 2000)
    expect(first).toBeGreaterThanOrEqual(1500)
    expect(first).toBeLessThanOrEqual(2500)
    const late = backoffMs(10, 100_000)
    expect(late).toBeLessThanOrEqual(37_500)
    expect(backoffMs(2, 2000)).toBeGreaterThanOrEqual(3000)
  })
})
