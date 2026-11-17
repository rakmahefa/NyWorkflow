import { useCallback, useEffect, useState } from 'react'
import type { LlmAdapter } from '@nyworkflow/adapter-llm'
import type { ModelInfoDto } from './modelMeta'

export type GatewayStatus = 'checking' | 'up' | 'down'

/**
 * Tracks the gemini-web2api gateway through the /api proxy. 'down' covers
 * unreachable, HTTP and empty-model cases: the UI then falls back to
 * simulated replies (M1 behaviour).
 *
 * M12: the gateway's own diagnostic (`GET /api/`) is fetched alongside the
 * model list — it carries `modelInfo` (labels, families, thinking flags)
 * and `defaultModel`, so the picker can group and label models. A gateway
 * without modelInfo (an external OpenAI server, the e2e mock) simply gets
 * fallback labels derived from the ids.
 */
export function useGatewayStatus(client: LlmAdapter) {
  const [status, setStatus] = useState<GatewayStatus>('checking')
  const [models, setModels] = useState<readonly string[]>([])
  const [selected, setSelected] = useState('')
  const [modelInfo, setModelInfo] = useState<readonly ModelInfoDto[]>([])

  const refresh = useCallback(async () => {
    setStatus('checking')
    try {
      const list = await client.listModels()
      if (list.length === 0) throw new Error('aucun modèle')
      setModels(list)
      setSelected((prev) => (list.includes(prev.split('@think=')[0] ?? prev) ? prev : (list[0] ?? '')))
      // Diagnostic additif — jamais bloquant : sans lui, repli sur les ids.
      try {
        const res = await fetch('/api/')
        if (res.ok) {
          const d = (await res.json()) as { modelInfo?: ModelInfoDto[] }
          setModelInfo(Array.isArray(d.modelInfo) ? d.modelInfo : [])
        } else {
          setModelInfo([])
        }
      } catch {
        setModelInfo([])
      }
      setStatus('up')
    } catch {
      setModels([])
      setSelected('')
      setModelInfo([])
      setStatus('down')
    }
  }, [client])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { status, models, selected, select: setSelected, modelInfo, refresh }
}
