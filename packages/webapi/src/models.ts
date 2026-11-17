/**
 * Table des modèles de l'interface web Gemini — **data-driven**, c'est le point
 * anti-casseurs n°1 : quand Google renomme un modèle ou change un mode, on
 * édite un JSON (NYW_WEBAPI_MODELS_FILE), jamais le code.
 *
 * `mode` : 1=FAST, 2=THINKING, 3=PRO, 4=AUTO, 5=FAST_DYNAMIC_THINKING, 6=FLASH_LITE.
 * `extra` : cases additionnelles du payload f.req spécifiques à un modèle.
 *
 * Table par défaut = vérité connue au 2026-11-17 (portée depuis ny-gemini-acp).
 * Suffixe `@think=N` sur le nom demandé : surcharge le niveau de réflexion (0–4).
 *
 * M12 : MODEL_META ajoute les métadonnées d'AFFICHAGE (libellé, famille,
 * réflexion native) pour l'UI — données, pas de code. Un modèle absent de
 * META reste servi : l'UI replie sur l'id brut, famille « autre ».
 */
import { readFileSync } from 'node:fs'

export interface ModelSpec {
  mode: number
  think: number
  extra?: Record<string, number>
}

export type ModelTable = Record<string, ModelSpec>

/** Display metadata of one model (M12) — labels for a professional picker. */
export interface ModelInfo {
  id: string
  /** Human label, e.g. "Gemini 3.6 Flash". */
  label: string
  /** flash | thinking | pro | auto | lite | autre. */
  family: string
  /** True when the model is a thinking mode (mode 2 or 5). */
  thinking: boolean
  /** Default think level of the table entry (0–4). */
  defaultThink: number
}

export const DEFAULT_MODEL = 'gemini-3.6-flash'

export const DEFAULT_MODEL_TABLE: ModelTable = {
  'gemini-3.6-flash': { mode: 1, think: 4 },
  'gemini-3.5-flash': { mode: 1, think: 4 },
  'gemini-3.5-flash-thinking': { mode: 2, think: 0 },
  'gemini-3.1-pro': { mode: 3, think: 4 },
  'gemini-3.1-pro-enhanced': { mode: 3, think: 4, extra: { 31: 2, 80: 3 } },
  'gemini-auto': { mode: 4, think: 4 },
  'gemini-3.5-flash-thinking-lite': { mode: 5, think: 0 },
  'gemini-flash-lite': { mode: 6, think: 4 },
}

/** Libellés d'affichage par id — la famille se déduit du mode (donnée). */
const FAMILY_OF_MODE: Record<number, string> = { 1: 'flash', 2: 'thinking', 3: 'pro', 4: 'auto', 5: 'thinking', 6: 'lite' }
const MODEL_LABELS: Record<string, string> = {
  'gemini-3.6-flash': 'Gemini 3.6 Flash',
  'gemini-3.5-flash': 'Gemini 3.5 Flash',
  'gemini-3.5-flash-thinking': 'Gemini 3.5 Flash Thinking',
  'gemini-3.1-pro': 'Gemini 3.1 Pro',
  'gemini-3.1-pro-enhanced': 'Gemini 3.1 Pro Enhanced',
  'gemini-auto': 'Gemini Auto',
  'gemini-3.5-flash-thinking-lite': 'Gemini 3.5 Flash Thinking Lite',
  'gemini-flash-lite': 'Gemini Flash Lite',
}

/** Slug id → label ("gemini-3.5-flash-thinking" → "Gemini 3.5 Flash Thinking"). */
function fallbackLabel(id: string): string {
  const spaced = id.replaceAll('-', ' ').replace(/\s+/g, ' ').trim()
  const cased = spaced
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
  return cased.toLowerCase().startsWith('gemini') ? cased : `Gemini ${cased}`.trim()
}

/** Display metadata of every table entry — order preserved (M12). */
export function listModelInfo(table: ModelTable): ModelInfo[] {
  return Object.entries(table).map(([id, spec]) => ({
    id,
    label: MODEL_LABELS[id] ?? fallbackLabel(id),
    family: FAMILY_OF_MODE[spec.mode] ?? 'autre',
    thinking: spec.mode === 2 || spec.mode === 5,
    defaultThink: spec.think,
  }))
}

/** Table effective : défaut, puis remplacement complet si un fichier JSON est fourni. */
export function loadModelTable(modelsFile?: string): ModelTable {
  if (!modelsFile) return DEFAULT_MODEL_TABLE
  try {
    const parsed = JSON.parse(readFileSync(modelsFile, 'utf8')) as ModelTable
    if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) return parsed
  } catch {
    // Fichier illisible : on reste sur la table par défaut — la passerelle démarre toujours.
  }
  return DEFAULT_MODEL_TABLE
}

export function listModelIds(table: ModelTable): string[] {
  return Object.keys(table)
}

export class UnknownModelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnknownModelError'
  }
}

export interface ResolvedModel {
  name: string
  mode: number
  think: number
  extra?: Record<string, number>
}

function resolveEntry(name: string, table: ModelTable): ModelSpec {
  const spec = table[name]
  if (!spec) throw new UnknownModelError(`Modèle inconnu : ${name} (connus : ${listModelIds(table).join(', ')})`)
  return spec
}

/**
 * Résolution souple (côté client) : modèle inconnu → repli sur le défaut,
 * `@think=` surchargé et borné à 4, plusieurs suffixes = erreur.
 */
export function resolveModel(requested: string, table: ModelTable, defaultModel: string): ResolvedModel {
  let name = requested
  let thinkOverride: number | undefined
  const count = (requested.match(/@think=/g) ?? []).length
  if (count > 1) throw new UnknownModelError(`Plusieurs suffixes @think= dans « ${requested} » (un seul attendu)`)
  const idx = requested.indexOf('@think=')
  if (idx >= 0) {
    const level = Number(requested.slice(idx + '@think='.length))
    if (!Number.isFinite(level)) throw new UnknownModelError(`Niveau de réflexion invalide : ${requested.slice(idx + 7)}`)
    thinkOverride = Math.min(Math.max(Math.floor(level), 0), 4)
    name = requested.slice(0, idx)
  }
  let spec: ModelSpec
  try {
    spec = resolveEntry(name, table)
  } catch (err) {
    if (err instanceof UnknownModelError && table[defaultModel]) {
      name = defaultModel
      spec = table[defaultModel] as ModelSpec
    } else {
      throw err
    }
  }
  return { name, mode: spec.mode, think: thinkOverride ?? spec.think, extra: spec.extra }
}

/**
 * Résolution stricte (côté serveur) : le modèle demandé (sans suffixe) doit
 * exister dans la table, sinon 400 — jamais de repli silencieux sur une API publique.
 */
export function resolveModelStrict(requested: string, table: ModelTable, defaultModel: string): ResolvedModel {
  const base = requested.split('@think=')[0] ?? requested
  if (!table[base]) throw new UnknownModelError(`Unknown model: ${requested}`)
  return resolveModel(requested, table, defaultModel)
}
