import { describe, expect, it } from 'vitest'
import { APP_NAME, APP_VERSION } from './version'

describe('version', () => {
  it('exposes the app name', () => {
    expect(APP_NAME).toBe('NyWorkflow')
  })

  it('exposes a valid semver version', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
