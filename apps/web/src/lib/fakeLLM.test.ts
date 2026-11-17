import { describe, expect, it } from 'vitest'
import { fakeReply, streamText } from './fakeLLM'

describe('fakeReply', () => {
  it('is deterministic and echoes the prompt', () => {
    const a = fakeReply('Explique ICM')
    const b = fakeReply('Explique ICM')
    expect(a).toBe(b)
    expect(a).toContain('Réponse simulée')
    expect(a).toContain('Explique ICM')
  })
})

describe('streamText', () => {
  it('emits the full text in order (delay 0)', async () => {
    const text = fakeReply('test streaming')
    const got: string[] = []
    const handle = streamText(text, (t) => got.push(t), 0)
    await handle.done
    expect(got.join('')).toBe(text)
  })

  it('can be stopped before the first token', async () => {
    const got: string[] = []
    const handle = streamText('a b c', (t) => got.push(t), 5)
    handle.stop()
    await handle.done
    expect(got.join('')).toBe('')
  })
})
