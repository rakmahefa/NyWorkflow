import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { DEFAULT_GEMINI_BASE_URL, DEFAULT_HOST, DEFAULT_PORT, defaultCookieFile, findRepoRoot, loadWebApiConfig } from './config.ts'

describe('loadWebApiConfig', () => {
  it('valeurs par défaut : boucle 8081, interface Gemini officielle', () => {
    const c = loadWebApiConfig({})
    expect(c.host).toBe(DEFAULT_HOST)
    expect(c.port).toBe(DEFAULT_PORT)
    expect(c.baseUrl).toBe(DEFAULT_GEMINI_BASE_URL)
    expect(c.retryAttempts).toBe(3)
    expect(c.retryDelayMs).toBe(2000)
    expect(c.timeoutMs).toBe(180_000)
  })

  it('chaque variable NYW_WEBAPI_* surcharge sa valeur', () => {
    const c = loadWebApiConfig({
      NYW_WEBAPI_HOST: '0.0.0.0',
      NYW_WEBAPI_PORT: '9999',
      NYW_WEBAPI_COOKIE_FILE: '/tmp/c.json',
      NYW_WEBAPI_COOKIES: 'A=1',
      NYW_WEBAPI_MODEL: 'gemini-auto',
      NYW_WEBAPI_MODELS_FILE: '/tmp/m.json',
      NYW_WEBAPI_GEMINI_BL: 'boq_test',
      NYW_WEBAPI_AUTH_USER: '2',
      NYW_WEBAPI_GEMINI_BASE_URL: 'http://127.0.0.1:1',
      NYW_WEBAPI_TIMEOUT_MS: '1000',
      NYW_WEBAPI_RETRY_ATTEMPTS: '5',
      NYW_WEBAPI_RETRY_DELAY_MS: '10',
    })
    expect(c).toMatchObject({
      host: '0.0.0.0',
      port: 9999,
      cookieFile: '/tmp/c.json',
      rawCookies: 'A=1',
      defaultModel: 'gemini-auto',
      modelsFile: '/tmp/m.json',
      geminiBl: 'boq_test',
      authUser: 2,
      baseUrl: 'http://127.0.0.1:1',
      timeoutMs: 1000,
      retryAttempts: 5,
      retryDelayMs: 10,
    })
  })

  it('valeurs numériques invalides → repli sur le défaut, jamais de NaN', () => {
    const c = loadWebApiConfig({ NYW_WEBAPI_PORT: 'pas-un-nombre', NYW_WEBAPI_AUTH_USER: 'x' })
    expect(c.port).toBe(DEFAULT_PORT)
    expect(c.authUser).toBeUndefined()
  })

  it('retryAttempts reste ≥ 1', () => {
    expect(loadWebApiConfig({ NYW_WEBAPI_RETRY_ATTEMPTS: '0' }).retryAttempts).toBe(1)
  })
})

describe('findRepoRoot / defaultCookieFile', () => {
  it('trouve la racine du monorepo depuis ce paquet (pnpm-workspace.yaml)', () => {
    const root = findRepoRoot(path.dirname(new URL(import.meta.url).pathname))
    expect(root.endsWith('NyWorkflow')).toBe(true)
  })

  it('cookies par défaut sous .nyworkflow/cookies/ (déjà gitignoré)', () => {
    expect(defaultCookieFile()).toBe(path.join(findRepoRoot(path.dirname(new URL(import.meta.url).pathname)), '.nyworkflow', 'cookies', 'gemini.json'))
  })
})
