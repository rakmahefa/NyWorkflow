import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  buildIcmSystemPrompt,
  ensureIcmTree,
  loadIcm,
  renderTree,
  scaffoldAgenticWorkspace,
  scaffoldContext,
  scaffoldFiles,
  walkTree,
  workspaceName,
  ICM_DIR,
  SCAFFOLD_FILES,
  SCAFFOLD_FOLDERS,
  TOOL_NAMES,
  CONTEXT_MAX_CHARS,
  CONTEXT_MAX_FILES,
} from './index.ts'

// M11 — le pivot ICM : l'arbre libre chargé vers le modèle, les CONTEXT.md
// lus racine d'abord, le prompt système assemblé, et le scaffold agentique.
// M14 — l'ICM vit dans le dossier caché .workspace/ du dossier de session :
// scaffold, ensure idempotent, chargement .workspace d'abord + projet après.

const dirs: string[] = []

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'nyw-icm-'))
  dirs.push(d)
  return d
}

describe('workspaceName', () => {
  it('le nom du dossier, sans séparateur final', () => {
    expect(workspaceName('/tmp/mon-ws')).toBe('mon-ws')
    expect(workspaceName('mon-ws/')).toBe('mon-ws')
    expect(workspaceName('mon-ws')).toBe('mon-ws')
  })
})

describe('walkTree + renderTree', () => {
  it('dossiers d’abord puis fichiers, chaque groupe alphabétique, connecteurs', async () => {
    const root = tmp()
    mkdirSync(join(root, 'notes'))
    mkdirSync(join(root, 'inbox'))
    writeFileSync(join(root, 'CONTEXT.md'), '# Carte')
    writeFileSync(join(root, 'a.txt'), 'A')
    writeFileSync(join(root, 'notes', 'plan.md'), 'PLAN')
    writeFileSync(join(root, 'inbox', '.gitkeep'), '')

    const { entries, truncated } = await walkTree(root)
    expect(truncated).toBe(false)
    expect(entries).toEqual([
      { path: 'inbox', dir: true },
      { path: 'inbox/.gitkeep', dir: false },
      { path: 'notes', dir: true },
      { path: 'notes/plan.md', dir: false },
      { path: 'a.txt', dir: false },
      { path: 'CONTEXT.md', dir: false },
    ])

    expect(renderTree(entries)).toBe(
      ['inbox/', '├── .gitkeep', 'notes/', '├── plan.md', 'a.txt', 'CONTEXT.md'].join('\n'),
    )
  })

  it('dossiers cachés et poubelles sautés, .gitkeep et dotfiles gardés', async () => {
    const root = tmp()
    mkdirSync(join(root, '.git'))
    mkdirSync(join(root, 'node_modules'))
    mkdirSync(join(root, 'outputs'))
    mkdirSync(join(root, '.logs', 'une-session'), { recursive: true })
    writeFileSync(join(root, '.git', 'HEAD'), 'x')
    writeFileSync(join(root, 'node_modules', 'pkg.js'), 'x')
    writeFileSync(join(root, 'outputs', '.gitkeep'), '')
    writeFileSync(join(root, '.logs', 'une-session', 'activity.jsonl'), '{}\n')
    writeFileSync(join(root, '.env.local'), 'SECRET=1')

    // M14 — .logs (les logs par session) est exclu de l'arbre, comme .git.
    const { entries } = await walkTree(root)
    expect(entries.map((e) => e.path)).toEqual(['outputs', 'outputs/.gitkeep', '.env.local'])
  })

  it('arbre vide et troncature honnête', () => {
    expect(renderTree([])).toBe('(arbre vide)')
    const many = Array.from({ length: 3 }, (_, i) => ({ path: `d${i}`, dir: true }))
    expect(renderTree(many, true)).toContain('arbre tronqué')
  })
})

describe('loadIcm — layout M14 (.workspace/)', () => {
  it('ICM dans .workspace/, projet visible à côté : contexts de l’ICM, arbre des deux', async () => {
    const root = tmp()
    mkdirSync(join(root, ICM_DIR, 'notes'), { recursive: true })
    writeFileSync(join(root, ICM_DIR, 'CONTEXT.md'), '# Charte ICM')
    writeFileSync(join(root, ICM_DIR, 'notes', 'CONTEXT.md'), '# Notes ICM')
    writeFileSync(join(root, 'projet.md'), '# Le projet du pilote')
    writeFileSync(join(root, 'CONTEXT.md'), '# CONTEXT racine du projet (PAS chargé comme charte)')

    const icm = await loadIcm(root)
    expect(icm.icmDir).toBe(true)
    // Les contexts viennent de .workspace/ — la charte de l'agent, pas celle du projet.
    expect(icm.contexts.map((c) => c.path)).toEqual(['', 'notes/CONTEXT.md'])
    expect(icm.contexts[0]?.content).toBe('# Charte ICM')
    // L'arbre montre l'ICM caché (racine .workspace/ + sous-arbre) ET le projet.
    expect(icm.tree).toContain(`${ICM_DIR}/\n├── notes/`)
    expect(icm.tree).toContain('├── CONTEXT.md')
    expect(icm.tree).toContain('projet.md')
    expect(icm.tree).toContain('CONTEXT.md')
  })

  it('legacy (avant M14) : sans .workspace/, contexts à la racine', async () => {
    const root = tmp()
    mkdirSync(join(root, 'notes'))
    mkdirSync(join(root, 'research', 'ddg'), { recursive: true })
    writeFileSync(join(root, 'CONTEXT.md'), '# Racine')
    writeFileSync(join(root, 'notes', 'CONTEXT.md'), '# Notes')
    writeFileSync(join(root, 'research', 'CONTEXT.md'), '# Recherche')
    writeFileSync(join(root, 'research', 'ddg', 'CONTEXT.md'), '# DDG')

    const icm = await loadIcm(root)
    expect(icm.icmDir).toBe(false)
    expect(icm.contexts.map((c) => c.path)).toEqual(['', 'notes/CONTEXT.md', 'research/CONTEXT.md', 'research/ddg/CONTEXT.md'])
    expect(icm.contexts[0]?.content).toBe('# Racine')
  })

  it('workspace sans CONTEXT.md : valide, contexts vides', async () => {
    const root = tmp()
    writeFileSync(join(root, 'fichier.md'), 'contenu')
    const icm = await loadIcm(root)
    expect(icm.contexts).toEqual([])
    expect(icm.tree).toContain('fichier.md')
  })

  it('un CONTEXT.md géant est tronqué au plafond, avec marqueur', async () => {
    const root = tmp()
    writeFileSync(join(root, 'CONTEXT.md'), 'x'.repeat(CONTEXT_MAX_CHARS + 5_000))
    const icm = await loadIcm(root)
    expect(icm.contexts[0]?.content).toContain(`tronqué à ${CONTEXT_MAX_CHARS} caractères`)
    expect((icm.contexts[0]?.content.length ?? 0)).toBeLessThanOrEqual(CONTEXT_MAX_CHARS + 100)
  })
})

describe('buildIcmSystemPrompt — identité harness (M14)', () => {
  it('dit AU MODEL ce qu’il est, où il tourne, et comment agir', async () => {
    const root = tmp()
    mkdirSync(join(root, 'outputs'))
    writeFileSync(join(root, 'CONTEXT.md'), '# Mission loutres')
    writeFileSync(join(root, 'outputs', '.gitkeep'), '')

    const prompt = buildIcmSystemPrompt(await loadIcm(root))
    // Identité : harness nommé, pas un chatbot.
    expect(prompt).toContain('harness NyWorkflow')
    expect(prompt).toContain('pas un chatbot')
    expect(prompt).toContain('Agir = appeler un outil')
    expect(prompt).toContain('Interpretable Context Methodology')
    // L'arbre et la charte.
    expect(prompt).toContain('ICM chargé — arbre du workspace')
    expect(prompt).toContain('outputs/')
    expect(prompt).toContain('ICM chargé — charte (CONTEXT.md racine)')
    expect(prompt).toContain('# Mission loutres')
    expect(prompt).toContain('mkdir')
    expect(prompt).toContain('websearch')
  })

  it('layout M14 : le prompt montre .workspace/ et interdit de relire les contexts chargés', async () => {
    const root = tmp()
    await ensureIcmTree(root)
    const prompt = buildIcmSystemPrompt(await loadIcm(root))
    expect(prompt).toContain(`${ICM_DIR}/`)
    expect(prompt).toContain('ne les relis pas')
    expect(prompt).toContain('.logs/')
    expect(prompt).toContain('Parallélise')
    expect(prompt).toContain('"background": true')
    expect(prompt).toContain('shell_output {"jobId"}')
    expect(prompt).toContain('shell_kill {"jobId"}')
    expect(prompt).toContain('Explore sans demander')
  })

  it('M19 — l’arsenal : évaluer ses moyens, construire le manque, améliorer l’ICM', async () => {
    const root = tmp()
    await ensureIcmTree(root)
    const prompt = buildIcmSystemPrompt(await loadIcm(root))
    // La section dédiée, après la méthode ICM.
    expect(prompt).toContain('Évalue tes moyens — l’arsenal')
    // Évaluer : le registre dit ce qui existe, une skill couvrante se SUIT.
    expect(prompt).toContain('Évalue avant d’agir')
    expect(prompt).toContain('registre des skills')
    expect(prompt).toContain('elle ne se réinvente pas')
    // Construire : depuis les outils de base, le gabarit, le registre.
    expect(prompt).toContain('Construis le manque')
    expect(prompt).toContain('skills/_MODELE.md')
    expect(prompt).toContain('inscris-la au registre')
    expect(prompt).toContain('La même procédure improvisée deux fois est une skill qui manque')
    // Améliorer : la boucle après usage, et l’ICM elle-même.
    expect(prompt).toContain('Améliore après usage')
    expect(prompt).toContain('L’ICM elle-même s’améliore')
    expect(prompt).toContain('un arsenal qui grandit à chaque tâche')
    // La méthode ICM porte le temps Évaluer (6 temps désormais).
    expect(prompt).toContain('2. **Évaluer**')
    expect(prompt).toContain('6. **Retenir**')
    // L’environnement montre le dossier skills/.
    expect(prompt).toContain('skills/<nom>/SKILL.md')
    // La charte de l’arsenal est chargée depuis l’arbre (pas juste citée).
    expect(prompt).toContain('Le protocole d’évaluation — avant toute tâche non triviale')
    expect(prompt).toContain('La boucle d’amélioration — après chaque usage')
  })

  it('workspace vierge : invite à écrire le CONTEXT.md', () => {
    const prompt = buildIcmSystemPrompt({ name: 'vierge', tree: '(arbre vide)', contexts: [], icmDir: false })
    expect(prompt).toContain('aucun — ce workspace est vierge')
    expect(prompt).toContain('CONTEXT.md')
  })

  it('M16 — le protocole trois temps : thinking titré, action parallèle, observation du groupe entier', async () => {
    const root = tmp()
    await ensureIcmTree(root)
    const prompt = buildIcmSystemPrompt(await loadIcm(root))
    // Le contrat : le bloc titré ouvre la réponse, AVANT tout le reste.
    expect(prompt).toContain('Protocole de réponse — trois temps')
    expect(prompt).toContain('<thinking title="titre court de l’étape en cours">')
    expect(prompt).toContain('</thinking>')
    expect(prompt).toContain('Le temps du thinking, en premier')
    expect(prompt).toContain('Le temps de l’action')
    expect(prompt).toContain('Le temps de l’observation')
    // Le format de réponse du groupe entier, montré au modèle.
    expect(prompt).toContain('{"tool": "read", "title": "Lire la charte", "ok": true, "result": "…"}')
    expect(prompt).toContain('NOUVEAU protocole démarre')
    // L'action : appels indépendants ENSEMBLE, puis STOP.
    expect(prompt).toContain('INDÉPENDANTS ENSEMBLE')
    expect(prompt).toContain('tu TERMINES ta réponse')
    // Le titre des tool_calls : l’argument `title` que le pilote lira.
    expect(prompt).toContain('`title` (≤ 60 caractères)')
    // Modèle-agnostique : jamais la balise en prose visible.
    expect(prompt).toContain('JAMAIS la balise')
    // L’ICM documente le harness et les outils.
    expect(prompt).toContain('harness/')
    expect(prompt).toContain('tools/')
  })
})

describe('scaffoldAgenticWorkspace (M14 — arbre dans .workspace/)', () => {
  it('crée l’arbre ICM COMPLET dans le dossier caché .workspace/', async () => {
    const parent = tmp()
    const root = join(parent, 'mon-agent')
    await scaffoldAgenticWorkspace(root)

    // Chaque fichier du scaffold existe DANS .workspace/, prêt à l'emploi.
    for (const rel of SCAFFOLD_FILES) {
      expect(existsSync(join(root, ICM_DIR, rel)), rel).toBe(true)
      expect(readFileSync(join(root, ICM_DIR, rel), 'utf8').length, rel).toBeGreaterThan(20)
    }
    for (const folder of SCAFFOLD_FOLDERS) {
      expect(existsSync(join(root, ICM_DIR, folder, 'CONTEXT.md')), folder).toBe(true)
    }
    // La racine du workspace reste propre : rien en dehors de .workspace/.
    const rootEntries = await walkTree(root)
    expect(rootEntries.entries).toEqual([]) // walkTree saute les dossiers cachés

    const charter = readFileSync(join(root, ICM_DIR, 'CONTEXT.md'), 'utf8')
    expect(charter).toContain('# mon-agent — ICM du workspace')
    expect(charter).toContain('## Mission')
    expect(charter).toContain('## Méthode ICM')
    expect(charter).toContain('## Carte de l’arbre')
    expect(charter).toContain('.workspace/notes/plan.md')
    expect(charter).toContain('.workspace/memory/core.md')
    expect(charter).toContain('.workspace/research/sources.md')
    expect(charter).toContain('## Outils')
    expect(charter).toContain('## Règles')

    // Les templates de notes/ sont de vrais documents, pas des .gitkeep.
    for (const template of ['plan.md', 'tasks.md', 'journal.md', 'decisions.md']) {
      expect(readFileSync(join(root, ICM_DIR, 'notes', template), 'utf8')).toContain('#')
    }
    expect(readFileSync(join(root, ICM_DIR, 'memory', 'core.md'), 'utf8')).toContain('Mémoire vive')
    expect(readFileSync(join(root, ICM_DIR, 'memory', 'lessons.md'), 'utf8')).toContain('Leçons')
    expect(readFileSync(join(root, ICM_DIR, 'research', 'sources.md'), 'utf8')).toContain('Registre des sources')

    // L'ICM charge ce workspace fraîchement scaffoldé : 10 CONTEXT.md (≤ cap),
    // l'arbre .workspace/ complet, et le prompt porte la charte.
    const icm = await loadIcm(root)
    expect(icm.icmDir).toBe(true)
    expect(icm.tree).toContain(`${ICM_DIR}/\n├── archive/`)
    expect(icm.tree).toContain('├── harness/')
    expect(icm.tree).toContain('├── inbox/')
    expect(icm.tree).toContain('├── memory/')
    expect(icm.tree).toContain('├── notes/')
    expect(icm.tree).toContain('├── skills/')
    expect(icm.tree).toContain('├── tools/')
    expect(icm.contexts).toHaveLength(10)
    expect(icm.contexts.length).toBeLessThanOrEqual(CONTEXT_MAX_FILES)
    const prompt = buildIcmSystemPrompt(icm)
    expect(prompt).toContain('# mon-agent — ICM du workspace')
    expect(prompt).toContain('.workspace/notes/plan.md')
    // M16 — la charte du harness et le protocole des outils sont chargés.
    expect(prompt).toContain('# harness/ — le harness NyWorkflow')
    expect(prompt).toContain('# tools/ — le protocole d’utilisation des outils')
    // M19 — la charte de l’arsenal (évaluation + registre) est chargée.
    expect(prompt).toContain('# skills/ — ton arsenal : les compétences que tu construis')
    expect(prompt).toContain('Registre des skills')
    // Les fiches rigoureuses existent dans l'arbre (lus à la demande).
    expect(icm.tree).toContain('├── read.md')
    expect(icm.tree).toContain('├── websearch.md')
    // Le gabarit d'une skill existe, lu à la demande.
    expect(icm.tree).toContain('├── _MODELE.md')
  })

  it('scaffoldFiles : la carte est pure et exhaustive — 28 fichiers, 10 CONTEXT.md', () => {
    const files = scaffoldFiles('demo')
    expect(Object.keys(files).sort()).toEqual([...SCAFFOLD_FILES].sort())
    expect(SCAFFOLD_FILES.filter((f) => f.endsWith('CONTEXT.md'))).toHaveLength(10)
    expect(SCAFFOLD_FOLDERS).toHaveLength(9)
    // M16 — une fiche rigoureuse par outil, au catalogue complet.
    for (const tool of TOOL_NAMES) {
      expect(files[`tools/${tool}.md`], tool).toBeDefined()
      const fiche = files[`tools/${tool}.md`] as string
      expect(fiche).toContain(`# ${tool} —`)
      expect(fiche).toContain('## Arguments')
      expect(fiche).toContain('## Lancement correct')
      expect(fiche).toContain('## Erreurs courantes')
    }
    // La doc du harness : charte + moteur.
    expect(files['harness/CONTEXT.md']).toContain('le harness NyWorkflow')
    expect(files['harness/ENGINE.md']).toContain('La boucle de tour')
    // Le protocole trois temps est chargé à chaque tour.
    expect(files['tools/CONTEXT.md']).toContain('Le protocole trois temps')
    expect(files['tools/CONTEXT.md']).toContain('{"tool": "read", "title": "Lire la charte", "ok": true, "result": "…"}')
    // M19 — l'arsenal : charte chargée (évaluation + registre) et gabarit à la demande.
    expect(files['skills/CONTEXT.md']).toContain('Le protocole d’évaluation')
    expect(files['skills/CONTEXT.md']).toContain('Registre des skills')
    expect(files['skills/CONTEXT.md']).toContain('porte PAS de CONTEXT.md')
    expect(files['skills/_MODELE.md']).toContain('## Mission')
    expect(files['skills/_MODELE.md']).toContain('## Quand l’utiliser (déclencheurs)')
    expect(files['skills/_MODELE.md']).toContain('## Historique')
  })

  it('refuse un workspace existant — jamais d’écrasement', async () => {
    const root = tmp()
    await expect(scaffoldAgenticWorkspace(root)).rejects.toThrow(/existe déjà/)
    expect(existsSync(join(root, ICM_DIR))).toBe(false)
  })

  it('scaffoldContext : nom du workspace dans le titre', () => {
    expect(scaffoldContext('demo')).toContain('# demo — ICM du workspace')
  })
})

describe('ensureIcmTree (M14 création, M16 upgrade)', () => {
  it('crée l’arbre complet quand .workspace/ manque', async () => {
    const root = tmp()
    writeFileSync(join(root, 'projet.md'), 'le projet du pilote')
    expect(await ensureIcmTree(root)).toBe('created')
    for (const rel of SCAFFOLD_FILES) {
      expect(existsSync(join(root, ICM_DIR, rel)), rel).toBe(true)
    }
    // Le projet du pilote est intact.
    expect(readFileSync(join(root, 'projet.md'), 'utf8')).toBe('le projet du pilote')
  })

  it('NE TOUCHE JAMAIS un .workspace/ existant — la mémoire vivante continue', async () => {
    const root = tmp()
    expect(await ensureIcmTree(root)).toBe('created')
    // L'agent travaille : son plan devient le sien.
    writeFileSync(join(root, ICM_DIR, 'notes', 'plan.md'), '# MON plan, pas le template')
    // Une seconde session sur le même dossier continue la mémoire.
    expect(await ensureIcmTree(root)).toBe('present')
    expect(readFileSync(join(root, ICM_DIR, 'notes', 'plan.md'), 'utf8')).toBe('# MON plan, pas le template')
  })

  it('M16 — un .workspace/ d’avant M16 est UPGRADE : fichiers de base manquants ajoutés, mémoire intacte', async () => {
    const root = tmp()
    // Un workspace d’avant M16 : pas de harness/, pas de tools/.
    mkdirSync(join(root, ICM_DIR, 'notes'), { recursive: true })
    writeFileSync(join(root, ICM_DIR, 'CONTEXT.md'), '# Charte VIVANTE de l’agent')
    writeFileSync(join(root, ICM_DIR, 'notes', 'plan.md'), '# MON plan, pas le template')
    expect(await ensureIcmTree(root)).toBe('upgraded')
    // La mémoire vivante est INTACTE : rien d’existant n’est écrasé.
    expect(readFileSync(join(root, ICM_DIR, 'CONTEXT.md'), 'utf8')).toBe('# Charte VIVANTE de l’agent')
    expect(readFileSync(join(root, ICM_DIR, 'notes', 'plan.md'), 'utf8')).toBe('# MON plan, pas le template')
    // Les fichiers de base manquants sont là (doc harness + outils + templates).
    expect(existsSync(join(root, ICM_DIR, 'harness', 'CONTEXT.md'))).toBe(true)
    expect(existsSync(join(root, ICM_DIR, 'harness', 'ENGINE.md'))).toBe(true)
    expect(existsSync(join(root, ICM_DIR, 'tools', 'CONTEXT.md'))).toBe(true)
    expect(existsSync(join(root, ICM_DIR, 'tools', 'read.md'))).toBe(true)
    expect(existsSync(join(root, ICM_DIR, 'notes', 'journal.md'))).toBe(true)
    // Complet désormais : un nouvel appel ne rajoute rien.
    expect(await ensureIcmTree(root)).toBe('present')
  })

  it('M19 — un .workspace/ d’avant M19 (M16 complet, sans skills/) est UPGRADE : l’arsenal ajouté, le reste intact', async () => {
    const root = tmp()
    // Un workspace M16 complet : harness/ et tools/ présents, skills/ absent.
    expect(await ensureIcmTree(root)).toBe('created')
    rmSync(join(root, ICM_DIR, 'skills'), { recursive: true, force: true })
    // L’agent a vécu : son registre potentiel et sa mémoire sont les siens.
    writeFileSync(join(root, ICM_DIR, 'memory', 'core.md'), '# MA mémoire vive')
    expect(await ensureIcmTree(root)).toBe('upgraded')
    // La charte de l’arsenal et le gabarit sont là — le reste intact.
    expect(readFileSync(join(root, ICM_DIR, 'skills', 'CONTEXT.md'), 'utf8')).toContain('ton arsenal')
    expect(existsSync(join(root, ICM_DIR, 'skills', '_MODELE.md'))).toBe(true)
    expect(readFileSync(join(root, ICM_DIR, 'memory', 'core.md'), 'utf8')).toBe('# MA mémoire vive')
    // Complet désormais : un nouvel appel ne rajoute rien.
    expect(await ensureIcmTree(root)).toBe('present')
  })

  it('M19 — un registre VIVANT n’est JAMAIS écrasé par l’upgrade', async () => {
    const root = tmp()
    expect(await ensureIcmTree(root)).toBe('created')
    // L’agent a construit une skill et tenu son registre.
    writeFileSync(
      join(root, ICM_DIR, 'skills', 'CONTEXT.md'),
      '# skills/ — ton arsenal\n\n| Skill | Ce qu’elle fait | Statut |\n|---|---|---|\n| conversion-pdf | images → PDF propres | v2 |\n',
    )
    mkdirSync(join(root, ICM_DIR, 'skills', 'conversion-pdf'))
    writeFileSync(join(root, ICM_DIR, 'skills', 'conversion-pdf', 'SKILL.md'), '# conversion-pdf — la procédure VIVANTE')
    expect(await ensureIcmTree(root)).toBe('present')
    expect(readFileSync(join(root, ICM_DIR, 'skills', 'CONTEXT.md'), 'utf8')).toContain('conversion-pdf')
    expect(readFileSync(join(root, ICM_DIR, 'skills', 'conversion-pdf', 'SKILL.md'), 'utf8')).toBe('# conversion-pdf — la procédure VIVANTE')
  })
})

describe('buildIcmSystemPrompt — charte scaffold (M12/M13 conservés)', () => {
  it('la charte scaffold pointe vers le protocole et les fiches, et garde le parallélisme', () => {
    const charter = scaffoldContext('exemple-agentique')
    expect(charter).toContain('protocole trois temps')
    expect(charter).toContain('.workspace/tools/CONTEXT.md')
    expect(charter).toContain('.workspace/tools/<outil>.md')
    expect(charter).toContain('.workspace/harness/')
    expect(charter).toContain('ENSEMBLE')
    expect(charter).toContain('aucun outil')
    // Le détail rigoureux vit dans les fiches (chargées à la demande).
    const files = scaffoldFiles('exemple-agentique')
    expect(files['tools/shell.md']).toContain('"background": true')
    expect(files['tools/shell_output.md']).toContain('shell_output {"jobId":')
    expect(files['tools/shell_kill.md']).toContain('shell_kill {"jobId":')
  })

  it('le prompt enseigne le comportement quand les outils sont désactivés', () => {
    const prompt = buildIcmSystemPrompt({ name: 'demo', tree: '(arbre vide)', contexts: [], icmDir: false })
    // La note dynamique est ajoutée par l’app ; le scaffold, lui, documente le cas.
    expect(scaffoldContext('demo')).toContain('aucun outil')
    expect(prompt).toContain('websearch')
  })
})
