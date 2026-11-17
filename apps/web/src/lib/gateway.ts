import { useCallback, useEffect, useState } from 'react'
import type { LlmAdapter } from '@nyworkflow/adapter-llm'

export type GatewayStatus = 'checking' | 'up' | 'down'

/**
 * Tracks the gemini-web2api gateway through the /api proxy.
 * 'down' covers unreachable, HTTP and empty-model cases: the UI then
 * falls back to simulated replies (M1 behaviour).
 */
export function useGatewayStatus(client: LlmAdapter) {
  const [status, setStatus] = useState<GatewayStatus>('checking')
  const [models, setModels] = useState<readonly string[]>([])
  const [selected, setSelected] = useState('')

  const refresh = useCallback(async () => {
    setStatus('checking')
    try {
      const list = await client.listModels()
      if (list.length === 0) throw new Error('aucun modèle')
      setModels(list)
      setSelected((prev) => (list.includes(prev) ? prev : (list[0] ?? '')))
      setStatus('up')
    } catch {
      setModels([])
      setSelected('')
      setStatus('down')
    }
  }, [client])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { status, models, selected, select: setSelected, refresh }
}
