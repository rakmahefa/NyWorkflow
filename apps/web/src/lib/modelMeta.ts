/**
 * Model display metadata (M12) — the client mirror of the gateway's
 * `modelInfo`. The gateway table is the truth (labels, families, thinking
 * flags); this module only derives what a gateway WITHOUT modelInfo (an
 * external OpenAI server, the e2e mock) should show, composes the
 * `@think=N` suffix, and orders the families of the picker.
 */

/** One model as the picker shows it (same shape as the gateway's modelInfo). */
export interface ModelInfoDto {
  id: string
  label: string
  family: string
  thinking: boolean
  defaultThink: number
}

/** Family display order of the grouped picker. */
export const FAMILY_ORDER = ['thinking', 'flash', 'pro', 'auto', 'lite', 'autre'] as const

const FAMILY_LABELS: Record<string, string> = {
  thinking: 'Raisonnement',
  flash: 'Flash',
  pro: 'Pro',
  auto: 'Auto',
  lite: 'Lite',
  autre: 'Autres',
}

export function familyLabel(family: string): string {
  return FAMILY_LABELS[family] ?? 'Autres'
}

/** Slug id → label ("gemini-2.5-pro" → "Gemini 2.5 Pro"). */
export function fallbackLabel(id: string): string {
  const spaced = id.replaceAll('-', ' ').replace(/\s+/g, ' ').trim()
  const cased = spaced
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
  return cased.toLowerCase().startsWith('gemini') ? cased : cased
}

/** The picker's model list: gateway metadata first, honest fallback per id. */
export function withFallbackInfo(models: readonly string[], info: readonly ModelInfoDto[]): ModelInfoDto[] {
  const byId = new Map(info.map((m) => [m.id, m]))
  return models.map((id) => byId.get(id) ?? { id, label: fallbackLabel(id), family: 'autre', thinking: false, defaultThink: 4 })
}

/** Groups models by family, picker order; groups keyed by family id. */
export function groupByFamily(models: readonly ModelInfoDto[]): { family: string; label: string; models: ModelInfoDto[] }[] {
  const groups = new Map<string, ModelInfoDto[]>()
  for (const m of models) {
    const list = groups.get(m.family) ?? []
    list.push(m)
    groups.set(m.family, list)
  }
  const families = [...groups.keys()].sort((a, b) => {
    const ia = FAMILY_ORDER.indexOf(a as (typeof FAMILY_ORDER)[number])
    const ib = FAMILY_ORDER.indexOf(b as (typeof FAMILY_ORDER)[number])
    return (ia === -1 ? FAMILY_ORDER.length : ia) - (ib === -1 ? FAMILY_ORDER.length : ib)
  })
  return families.map((family) => ({ family, label: familyLabel(family), models: groups.get(family) ?? [] }))
}

/** The think levels of the picker: auto (model default) then 0–4. */
export const THINK_LEVELS = [
  { value: 'auto', label: 'Auto' },
  { value: '0', label: '0 · minimal' },
  { value: '1', label: '1 · léger' },
  { value: '2', label: '2 · moyen' },
  { value: '3', label: '3 · élevé' },
  { value: '4', label: '4 · maximum' },
] as const

/** Composes the requested model id: `@think=N` only when a level is chosen. */
export function withThinkLevel(model: string, level: string | null): string {
  const base = model.split('@think=')[0] ?? model
  if (level === null || level === 'auto' || level === '') return base
  const n = Math.min(Math.max(Number.parseInt(level, 10) || 0, 0), 4)
  return `${base}@think=${n}`
}

/** The think level of a selected model string ('auto' when no suffix). */
export function thinkLevelOf(model: string): string {
  const idx = model.indexOf('@think=')
  return idx >= 0 ? (model.slice(idx + '@think='.length) || 'auto') : 'auto'
}

/** The base id of a model string, suffix stripped. */
export function baseModelOf(model: string): string {
  return model.split('@think=')[0] ?? model
}
