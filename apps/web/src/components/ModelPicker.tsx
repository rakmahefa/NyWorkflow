import type { GatewayStatus } from '../lib/gateway'

interface ModelPickerProps {
  status: GatewayStatus
  models: readonly string[]
  selected: string
  onSelect(model: string): void
  onRefresh(): void
}

const DOT_TITLE: Record<GatewayStatus, string> = {
  checking: 'Passerelle : détection en cours…',
  up: 'Passerelle webapi connectée',
  down: 'Passerelle webapi absente — mode simulé',
}

/** Gateway dot + model select + refresh, in the main header. */
export function ModelPicker({ status, models, selected, onSelect, onRefresh }: ModelPickerProps) {
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
          models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))
        ) : (
          <option value="">Passerelle absente — simulé</option>
        )}
      </select>
      <button data-test="model-refresh" onClick={onRefresh} disabled={status === 'checking'}>
        Rafraîchir
      </button>
    </div>
  )
}
