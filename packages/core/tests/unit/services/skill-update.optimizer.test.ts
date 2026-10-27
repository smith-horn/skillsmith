/**
 * SMI-6531 (A1 step 7b): T-U2, the optimizer is off for an in-place update
 * (A1 plan §3.7 item 1).
 *
 * The behaviour: a SKILL.md over the optimizer's decomposition threshold is
 * written byte-for-byte as fetched, with no generated sub-skill and no
 * companion file. The import graph: no `skill-update*.ts` module, and not the
 * fetch-and-scan module they share with `install()`, imports the optimizer or
 * the companion writer. The same parser finds `applyOptimization` in
 * `skill-installation.service.ts`, so an empty answer is not a parser that
 * sees nothing.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveCompanionAgentDir } from '../../../src/install/paths.js'
import { quickTransformCheck } from '../../../src/services/SkillAnalyzer.js'
import { buildUpdateTarget } from '../../../src/services/skill-update.target.js'
import { planSkillUpdate } from '../../../src/services/skill-update.plan.js'
import { updateInPlace } from '../../../src/services/skill-update.js'
import {
  changedBetween,
  recorded,
  SKILL_ID,
  skillMd,
  updateFixture,
  useTmpCleanup,
  useUpstream,
  useUpstreamCleanup,
  walk,
} from './skill-update.helpers.js'

useTmpCleanup()
useUpstreamCleanup()

const SERVICES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/services')

/** A SKILL.md long enough that the optimizer would decompose it, in ten sections. */
function longSkillMd(): string {
  let body = ''
  for (let s = 1; s <= 10; s++) {
    body += `\n## Section ${s}\n\n`
    for (let l = 1; l <= 60; l++)
      body += `Step ${s}.${l}: write the summary line for change ${l}.\n`
  }
  return skillMd('v2', body)
}

describe('T-U2: the optimizer is off', () => {
  it('writes the over-threshold SKILL.md as fetched, with no sub-skill and no companion file', async () => {
    const upstream = useUpstream()
    const big = longSkillMd()
    upstream['SKILL.md'] = big
    upstream['README.md'] = '# Readme\n\nHow to use the skill.\n'
    // The fixture is one the optimizer would act on.
    expect(quickTransformCheck(big)).toBe(true)

    const fx = updateFixture({ 'SKILL.md': skillMd('v1'), 'notes.txt': 'mine\n' })
    const companionDir = resolveCompanionAgentDir(fx.client)
    const before = { folder: walk(fx.realDir), companion: walk(companionDir) }
    const t = await buildUpdateTarget({
      skillsDir: fx.skillsDir,
      client: fx.client,
      scope: 'global',
      manifestPath: fx.manifestPath,
      comparedPath: fx.comparedPath,
    })
    if (!t.ok) throw new Error(t.detail)
    const plan = await planSkillUpdate({ target: t.target, skillId: SKILL_ID })
    if (!plan.ok) throw new Error(plan.detail)
    const result = await updateInPlace(plan, { swap: recorded().swap })
    expect(result.status).toBe('committed')

    // The folder gained exactly the fetched files: no generated sub-skill.
    expect(changedBetween(before.folder, walk(fx.realDir))).toEqual(['README.md', 'SKILL.md'])
    expect(changedBetween(before.companion, walk(companionDir))).toEqual([])
    // Per approved file, the bytes in the folder are the fetched bytes, SKILL.md included.
    for (const rel of ['SKILL.md', 'README.md']) {
      expect(fs.readFileSync(path.join(fx.realDir, rel), 'utf8')).toBe(upstream[rel])
    }
  })
})

/** The named bindings and module specifiers a module imports or re-exports. */
function importsOf(file: string): { names: Set<string>; modules: Set<string> } {
  const src = fs.readFileSync(file, 'utf8')
  const names = new Set<string>()
  const modules = new Set<string>()
  const re = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g
  for (const m of src.matchAll(re)) {
    modules.add(path.basename(m[2]!))
    for (const part of m[1]!.replace(/[{}*]/g, ',').split(',')) {
      const name = part
        .replace(/^\s*type\s+/, '')
        .split(/\s+as\s+/)[0]!
        .trim()
      if (name !== '') names.add(name)
    }
  }
  return { names, modules }
}

const OPTIMIZER_NAMES = ['applyOptimization', 'TransformationService', 'SkillDecomposer']
const COMPANION_WRITER_NAMES = ['writeInstallFiles']
const FORBIDDEN_MODULES = [
  'TransformationService.js',
  'SkillDecomposer.js',
  'SubagentGenerator.js',
  'skill-installation.io.write.js',
]

describe('T-U2: the import graph', () => {
  it('no skill-update*.ts module and not the shared fetch-and-scan module imports the optimizer or the companion writer', () => {
    const files = fs
      .readdirSync(SERVICES)
      .filter((n) => /^skill-update(\..+)?\.ts$/.test(n) && !n.endsWith('.test.ts'))
      .concat('skill-installation.fetch-scan.ts')
    expect(files.sort()).toEqual([
      'skill-installation.fetch-scan.ts',
      'skill-update.owner.ts',
      'skill-update.plan.ts',
      'skill-update.target.ts',
      'skill-update.ts',
      'skill-update.types.ts',
    ])
    for (const f of files) {
      const { names, modules } = importsOf(path.join(SERVICES, f))
      expect(modules.size).toBeGreaterThan(0)
      for (const n of [...OPTIMIZER_NAMES, ...COMPANION_WRITER_NAMES]) {
        expect([f, names.has(n)]).toEqual([f, false])
      }
      for (const m of FORBIDDEN_MODULES) expect([f, modules.has(m)]).toEqual([f, false])
    }
  })

  it('the control: the same parser finds the optimizer and the companion writer in install()', () => {
    const { names } = importsOf(path.join(SERVICES, 'skill-installation.service.ts'))
    expect(names.has('applyOptimization')).toBe(true)
    expect(names.has('writeInstallFiles')).toBe(true)
  })
})
