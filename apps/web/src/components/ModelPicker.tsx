import { groupByFamily, THINK_LEVELS, withFallbackInfo, type ModelInfoDto } from '../lib/modelMeta'
import type { GatewayStatus } from '../lib/gateway'

interface ModelPickerProps {
  status: GatewayStatus
  models: readonly string[]
  /** Gateway metadata (labels, families, thinking) — may be empty (fallback). */
  modelInfo: readonly ModelInfoDto[]
  /** Base model id (no @think suffix). */
  selected: string
  onSelect(model: string): void
  /** M12 — think level: 'auto' or '0'..'4'. */
  thinkLevel: string
  onThinkLevel(level: string): void
  onRefresh(): void
}

const DOT_TITLE: Record<GatewayStatus, string> = {
  checking: 'Passerelle : détection en cours…',
  up: 'Passerelle webapi connectée',
  down: 'Passerelle webapi absente — mode simulé',
}

/**
 * Gateway dot + grouped model picker (labels and families from the
 * gateway's modelInfo, M12) + the thinking-level selector (@think=N,
 * applied on top of the model) + refresh.
 */
export function ModelPicker({ status, models, modelInfo, selected, onSelect, thinkLevel, onThinkLevel, onRefresh }: ModelPickerProps) {
  const groups = groupByFamily(withFallbackInfo(models, modelInfo))
  return (
    <div className="model-picker">
      <span
        data-test="gateway-status"
        data-state={status}
        className="gw-dot"
        title={DOT_TITLE[status]}
      />
      <select
        data-test="model-select"
        aria-label="Modèle"
        value={selected}
        disabled={status !== 'up'}
        onChange={(e) => onSelect(e.target.value)}
      >
        {status === 'up' ? (
          groups.map((g) => (
            <optgroup key={g.family} label={g.label}>
              {g.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {m.thinking ? ' ✳' : ''}
                </option>
              ))}
            </optgroup>
          ))
        ) : (
          <option value="">Passerelle absente — simulé</option>
        )}
      </select>
      <select
        data-test="think-select"
        aria-label="Niveau de réflexion"
        value={thinkLevel}
        disabled={status !== 'up'}
        title="Niveau de réflexion du modèle (suffixe @think=N vers la passerelle)"
        onChange={(e) => onThinkLevel(e.target.value)}
      >
        {THINK_LEVELS.map((l) => (
          <option key={l.value} value={l.value}>
            Réflexion {l.label}
          </option>
        ))}
      </select>
      <button data-test="model-refresh" onClick={onRefresh} disabled={status === 'checking'}>
        Rafraîchir
      </button>
    </div>
  )
}
