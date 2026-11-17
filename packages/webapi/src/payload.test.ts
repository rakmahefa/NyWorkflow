import { describe, expect, it } from 'vitest'
import { buildFreq, extractBl, extractField, extractPageTokens, nextReqid, urlencode } from './payload.ts'

function decode(body: string): { params: URLSearchParams; inner: unknown[] } {
  const params = new URLSearchParams(body)
  const freq = JSON.parse(params.get('f.req') ?? 'null') as unknown[]
  const inner = JSON.parse(String(freq[1])) as unknown[]
  return { params, inner }
}

const PRO = { mode: 3, think: 4, extra: { 31: 2, 80: 3 } }

describe('buildFreq — positions imposées par l’interface Gemini', () => {
  it('chaque case connue est à sa place exacte (verrou anti-typo)', () => {
    const { inner } = decode(buildFreq('sujet', { mode: 1, think: 4 }, []))
    expect(inner).toHaveLength(102)
    expect(inner[0]).toEqual(['sujet', 0, null, null, null, null, 0])
    expect(inner[1]).toEqual(['en'])
    expect(inner[2]).toEqual(['', '', '', null, null, null, null, null, null, ''])
    expect(inner[6]).toEqual([0])
    expect(inner[7]).toBe(1)
    expect(inner[10]).toBe(1)
    expect(inner[11]).toBe(0)
    expect(inner[17]).toEqual([[4]])
    expect(inner[18]).toBe(0)
    expect(inner[27]).toBe(1)
    expect(inner[30]).toEqual([4])
    expect(inner[41]).toEqual([2])
    expect(inner[53]).toBe(0)
    expect(inner[61]).toEqual([])
    expect(inner[68]).toBe(1)
    expect(inner[79]).toBe(1)
    expect(inner[59]).toMatch(/^[0-9a-f-]{36}$/) // UUID
    // Les cases non documentées restent null — rien d’inventé.
    expect(inner[3]).toBeNull()
    expect(inner[100]).toBeNull()
  })

  it('le think demandé remplace la case 17', () => {
    const { inner } = decode(buildFreq('x', { mode: 2, think: 0 }, []))
    expect(inner[17]).toEqual([[0]])
    expect(inner[79]).toBe(2)
  })

  it('les cases extra du modèle s’appliquent (pro-enhanced : 31 → 2, 80 → 3)', () => {
    const { inner } = decode(buildFreq('x', PRO, []))
    expect(inner[31]).toBe(2)
    expect(inner[80]).toBe(3)
  })

  it('le jeton de page devient le paramètre at ; sans jeton, pas de paramètre', () => {
    expect(decode(buildFreq('x', PRO, [], 'AT123')).params.get('at')).toBe('AT123')
    expect(decode(buildFreq('x', PRO, [])).params.get('at')).toBeNull()
  })

  it('les refs (fichiers) voyagent dans la case 0', () => {
    const { inner } = decode(buildFreq('x', PRO, ['f1.md', 'f2.md']))
    expect((inner[0] as unknown[])[3]).toEqual([
      [null, null, 'f1.md'],
      [null, null, 'f2.md'],
    ])
  })

  it('f.req est le double encodage attendu : [null, "<inner JSON>"]', () => {
    const { params } = decode(buildFreq('x', PRO, []))
    const freq = JSON.parse(params.get('f.req') ?? 'null') as unknown[]
    expect(freq[0]).toBeNull()
    expect(typeof freq[1]).toBe('string')
  })
})

describe('urlencode', () => {
  it('espace → +, réservés → %XX majuscules, non-réservés inchangés', () => {
    expect(urlencode([['f.req', 'a b"ç~']])).toBe('f.req=a+b%22%C3%A7~')
    expect(urlencode([['at', 'x/y']])).toBe('at=x%2Fy')
  })
})

describe('extraction depuis la page /app', () => {
  const HTML =
    '<html><script>var WIZ_global_data = {"SNlM0e":"ATOKEN","qKIAYe":"PUSHID","Ylro7b":"PCTX","cf.b2l":"boq_assistant-bard-web-server_20261101.07_p3"};</script></html>'

  it('les trois jetons de page sont extraits', () => {
    expect(extractPageTokens(HTML)).toEqual({ at: 'ATOKEN', pushId: 'PUSHID', pctx: 'PCTX' })
  })

  it('jeton absent ou vide → undefined', () => {
    expect(extractPageTokens('{"SNlM0e":""}').at).toBeUndefined()
    expect(extractField('rien ici', 'SNlM0e')).toBeUndefined()
  })

  it('le bl est découvert où qu’il soit dans la page', () => {
    expect(extractBl(HTML)).toBe('boq_assistant-bard-web-server_20261101.07_p3')
    expect(extractBl('console.log("boq_assistant-bard-web-server_20241001.02_p1")')).toBe('boq_assistant-bard-web-server_20241001.02_p1')
  })

  it('pas de bl dans la page → undefined (repli constant côté client)', () => {
    expect(extractBl('<html>rien</html>')).toBeUndefined()
  })
})

describe('nextReqid', () => {
  it('deux appels donnent deux identifiants < 1 000 000', () => {
    const a = nextReqid()
    const b = nextReqid()
    expect(a).toBeLessThan(1_000_000)
    expect(b).toBeLessThan(1_000_000)
    expect(a).not.toBe(b)
  })
})
