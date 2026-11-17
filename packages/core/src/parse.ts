/**
 * Workspace parsing — the CONTEXT.md contract format, frozen as v1.
 *
 * A workspace is a folder with:
 *   - a root CONTEXT.md (the map: goal, stages table, rules);
 *   - numbered stage folders ("01-…"), each with its own CONTEXT.md.
 *
 * Contract v1 (frozen until v0.2.0):
 *   - Sections are "## Entrées", "## Process", "## Sorties". Process is
 *     required; Entrées and Sorties may be absent (then empty).
 *   - Entrées and Sorties are Markdown tables. A cell is a path if and only
 *     if it is wrapped in backticks. Emplacements are relative to the stage
 *     folder and are normalised to workspace-root-relative POSIX paths.
 *   - An input row without a backticked emplacement is the run subject (the
 *     question asked in the UI) — at most one such row per stage.
 *   - Inputs must stay inside the workspace; outputs inside the stage folder.
 *   - "Portion" is guidance text for the model ('—' or "fichier complet"
 *     mean 'full'); v1 always loads whole files, no section extraction.
 *   - The engine writes exactly one output per stage in v1: the first
 *     Sorties row. A contract may not declare more.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join, posix } from 'node:path'
import type { InputRef, StageContract, Workspace } from './index'

/** A stage folder: number + name, e.g. { number: 1, name: '01-recherche' }. */
interface StageDir {
  number: number
  name: string
}

const STAGE_PATTERN = /^(\d+)-(.+)$/

/** One data row of a Markdown table (header and separator rows excluded). */
export interface ParsedTableRow {
  cells: string[]
}

/** Splits raw Markdown into sections keyed by their "## " heading. */
function sections(raw: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let current = ''
  for (const line of raw.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      current = heading[1] ?? ''
      out.set(current, [])
    } else if (current !== '') {
      out.get(current)?.push(line)
    }
  }
  return out
}

/** Data rows of a Markdown table (first row = header, dashed row skipped). */
function tableRows(lines: readonly string[]): ParsedTableRow[] {
  const rows: ParsedTableRow[] = []
  let sawHeader = false
  for (const line of lines) {
    const t = line.trim()
    if (!t.startsWith('|') || !t.endsWith('|') || t.length < 2) continue
    const cells = t
      .slice(1, -1)
      .split('|')
      .map((c) => c.trim())
    if (!sawHeader) {
      sawHeader = true // header row — kept out of the data
      continue
    }
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue // separator
    if (cells.length < 2 || cells.every((c) => c === '')) continue
    rows.push({ cells })
  }
  return rows
}

const cell = (row: ParsedTableRow, i: number): string => row.cells[i] ?? ''

/** '`path`' → 'path'; anything else → null (not a path). */
function backticked(text: string): string | null {
  const m = /^`([^`]+)`$/.exec(text)
  return m ? (m[1] as string) : null
}

/**
 * Stage-relative emplacement → workspace-root-relative POSIX path.
 * Purely lexical guard: anything escaping the workspace throws.
 */
function toRootRelative(stage: string, raw: string): string {
  const rel = posix.normalize(posix.join(stage, raw))
  if (rel === '' || rel === '..' || rel.startsWith('../') || posix.isAbsolute(rel)) {
    throw new Error(`chemin hors workspace : \`${raw}\` (depuis ${stage})`)
  }
  return rel
}

/** Portion cell → scope ('—' and "fichier complet" mean the whole file). */
function toScope(portion: string): string {
  const t = portion.trim()
  return t === '' || t === '—' || t === '-' || t.toLowerCase() === 'fichier complet' ? 'full' : t
}

/** Parses one stage's CONTEXT.md. `stage` is the folder name. */
export function parseStageContract(stage: string, raw: string): StageContract {
  const parts = sections(raw)

  const titleLine = /^#\s+(.+?)\s*$/m.exec(raw)
  const title = titleLine ? (titleLine[1] as string) : stage

  const processLines = parts.get('Process') ?? []
  const process = processLines.map((l) => l.trim()).filter((l) => l !== '')
  if (process.length === 0) {
    throw new Error(`contrat de « ${stage} » : section « ## Process » absente ou vide`)
  }

  const inputs: InputRef[] = []
  for (const row of tableRows(parts.get('Entrées') ?? [])) {
    const origin = cell(row, 0)
    const emplacement = cell(row, 1)
    const path = backticked(emplacement)
    if (path !== null) {
      // '../CONTEXT.md' from stage '01-recherche' → 'CONTEXT.md' (root-relative).
      inputs.push({
        source: toRootRelative(stage, path),
        scope: toScope(cell(row, 2)),
        origin,
        why: cell(row, 3),
      })
    } else {
      // No backticked path: the run subject (the question asked in the UI).
      inputs.push({ source: '', scope: emplacement, origin, why: cell(row, 3) })
    }
  }
  const freeInputs = inputs.filter((i) => i.source === '')
  if (freeInputs.length > 1) {
    throw new Error(
      `contrat de « ${stage} » : une seule entrée sans fichier autorisée (le sujet), ${freeInputs.length} déclarées`,
    )
  }

  const outputs: string[] = []
  for (const row of tableRows(parts.get('Sorties') ?? [])) {
    const emplacement = cell(row, 1)
    const path = backticked(emplacement)
    if (path === null) {
      throw new Error(
        `contrat de « ${stage} » : emplacement de sortie entre backticks attendu, lu « ${emplacement} »`,
      )
    }
    const rel = posix.normalize(path)
    if (rel === '' || rel === '..' || rel.startsWith('../') || rel.startsWith('/')) {
      throw new Error(`contrat de « ${stage} » : sortie hors du dossier de l'étape : \`${path}\``)
    }
    outputs.push(rel)
  }

  return { stage, title, inputs, process, outputs }
}

/**
 * Parses a whole workspace: the root map plus every stage contract, stages
 * sorted by number. Throws clear French errors on broken workspaces.
 */
export async function parseWorkspace(root: string): Promise<Workspace> {
  let map: string
  try {
    map = await readFile(join(root, 'CONTEXT.md'), 'utf8')
  } catch (err) {
    throw new Error(`workspace sans CONTEXT.md racine : ${root} (${(err as NodeJS.ErrnoException).code})`)
  }

  const entries = await readdir(root, { withFileTypes: true })
  const stageDirs: StageDir[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const m = STAGE_PATTERN.exec(entry.name)
    if (m) stageDirs.push({ number: Number(m[1]), name: entry.name })
  }
  if (stageDirs.length === 0) {
    throw new Error(`aucune étape numérotée (dossier « NN-nom ») dans ${root}`)
  }

  const seen = new Map<number, string>()
  for (const dir of stageDirs) {
    const clash = seen.get(dir.number)
    if (clash) {
      throw new Error(`numéro d'étape en double : ${dir.number} (${clash}, ${dir.name})`)
    }
    seen.set(dir.number, dir.name)
  }
  stageDirs.sort((a, b) => a.number - b.number)

  const stages: StageContract[] = []
  for (const dir of stageDirs) {
    let raw: string
    try {
      raw = await readFile(join(root, dir.name, 'CONTEXT.md'), 'utf8')
    } catch (err) {
      throw new Error(`l'étape « ${dir.name} » n'a pas de CONTEXT.md (${(err as NodeJS.ErrnoException).code})`)
    }
    stages.push(parseStageContract(dir.name, raw))
  }

  return { root, map, stages }
}
