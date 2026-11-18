#!/usr/bin/env node
/**
 * M16 — régénère les GABARITS versionnés de l'exemple agentique depuis le
 * scaffold (v4 : harness/ + tools/ joints à l'arbre de base ; v5/M19 :
 * skills/ — l'arsenal — en plus). Seuls les fichiers du scaffold sont
 * écrits : ce que l'agent a pu écrire d'autre dans .workspace/ (racine
 * comprise) reste local, hors git.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { scaffoldFiles } from '../packages/core/src/index.ts'

const root = join(import.meta.dirname, '..', 'examples', 'workspaces', 'exemple-agentique', '.workspace')
const files = scaffoldFiles('exemple-agentique')
let count = 0
for (const rel of Object.keys(files).sort()) {
  const target = join(root, rel)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, files[rel], 'utf8')
  count++
  console.log(`OK ${rel}`)
}
console.log(`${count} gabarits écrits dans examples/workspaces/exemple-agentique/.workspace/`)
