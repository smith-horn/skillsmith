/**
 * @fileoverview SMI-5407 end-to-end — `sklx audit sources --apply` write paths.
 *
 * Real temp manifest (redirected via $HOME) + real temp SQLite. Covers:
 *   3. Collision safety — ambiguous low match is NOT auto-written; `--set` then
 *      writes the user-specified owner/skill-name id + https source.
 *   6. Idempotency + never-clobber — a second `--apply` is a no-op; a pre-existing
 *      healthy entry with a differing source is left untouched.
 *   8. --write-frontmatter churn guard — never writes `repository:` into a `.git`
 *      dir or when one already exists; DOES write into a non-git dir lacking it.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  writeSourceFixture,
  seedSkillsDb,
  skillMd,
  FIXTURE_DIRS,
} from './utils/source-recovery-fixture.js'
import type { AuditSourcesOptions } from '../../src/commands/audit-sources.action.js'
import type { SkillManifest, SkillManifestEntry } from '@skillsmith/core'

let runAuditSources: (o: AuditSourcesOptions) => Promise<void>
let tempHome = ''
let skillsRoot = ''
let manifestPath = ''
let originalHome: string | undefined
let dbCounter = 0

function makeOpts(o: Partial<AuditSourcesOptions> & { db: string }): AuditSourcesOptions {
  return {
    skillsRoot: o.skillsRoot ?? skillsRoot,
    apply: o.apply ?? false,
    yes: o.yes ?? false,
    set: o.set,
    minConfidence: o.minConfidence ?? 'high',
    json: o.json ?? false,
    embedding: false,
    catalogHint: false,
    writeFrontmatter: o.writeFrontmatter ?? false,
    forceWriteFrontmatter: o.forceWriteFrontmatter ?? false,
    db: o.db,
  }
}

function readManifest(): SkillManifest {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as SkillManifest
}

function entry(name: string): SkillManifestEntry | undefined {
  return readManifest().installedSkills[name]
}

async function seededDb(): Promise<string> {
  const dbPath = path.join(tempHome, `cands-${dbCounter++}.db`)
  await seedSkillsDb(dbPath, [
    { id: 'coll-1', name: FIXTURE_DIRS.collision, repoUrl: 'https://github.com/coll1/repoA' },
    { id: 'coll-2', name: FIXTURE_DIRS.collision, repoUrl: 'https://github.com/coll2/repoB' },
  ])
  return dbPath
}

async function emptyDb(): Promise<string> {
  const dbPath = path.join(tempHome, `empty-${dbCounter++}.db`)
  await seedSkillsDb(dbPath, [])
  return dbPath
}

beforeAll(async () => {
  originalHome = process.env['HOME']
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'smi5407-apply-home-'))
  process.env['HOME'] = tempHome
  skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smi5407-apply-skills-'))
  manifestPath = path.join(tempHome, '.skillsmith', 'manifest.json')
  writeSourceFixture(skillsRoot)
  ;({ runAuditSources } = await import('../../src/commands/audit-sources.action.js'))
})

afterAll(() => {
  if (originalHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = originalHome
  for (const dir of [tempHome, skillsRoot]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

beforeEach(() => {
  fs.rmSync(manifestPath, { force: true })
})

describe('SMI-5407 e2e — collision safety (scenario 3)', () => {
  it('does not auto-write an ambiguous (low) collision, then writes it via --set', async () => {
    const db = await seededDb()

    // Default min high: the low collision match must NOT land in the manifest.
    await runAuditSources(makeOpts({ db, apply: true, yes: true }))
    expect(entry(FIXTURE_DIRS.collision)).toBeUndefined()
    // git + plugin (exact/high) DID land.
    expect(entry(FIXTURE_DIRS.git)).toBeDefined()
    expect(entry(FIXTURE_DIRS.plugin)).toBeDefined()

    // --set resolves it explicitly at user-specified confidence.
    await runAuditSources(
      makeOpts({
        db,
        apply: true,
        yes: true,
        set: [`${FIXTURE_DIRS.collision}=picked-owner/picked-repo`],
      })
    )
    const resolved = entry(FIXTURE_DIRS.collision)
    expect(resolved).toBeDefined()
    expect(resolved!.id).toBe(`picked-owner/${FIXTURE_DIRS.collision}`)
    expect(resolved!.source).toBe('https://github.com/picked-owner/picked-repo')
  })
})

describe('SMI-5407 e2e — idempotency + never-clobber (scenario 6)', () => {
  it('a second --apply writes nothing and leaves the manifest byte-identical', async () => {
    const db = await emptyDb()
    await runAuditSources(makeOpts({ db, apply: true, yes: true }))
    const afterFirst = fs.readFileSync(manifestPath, 'utf-8')

    await runAuditSources(makeOpts({ db, apply: true, yes: true }))
    const afterSecond = fs.readFileSync(manifestPath, 'utf-8')

    expect(afterSecond).toBe(afterFirst)
  })

  it('never clobbers a healthy pre-existing entry whose source differs', async () => {
    const preExisting: SkillManifest = {
      version: '1.0.0',
      installedSkills: {
        [FIXTURE_DIRS.git]: {
          id: 'preexisting-id',
          name: FIXTURE_DIRS.git,
          version: '9.9.9',
          source: 'https://github.com/someoneelse/different',
          installPath: path.join(skillsRoot, FIXTURE_DIRS.git),
          installedAt: '2020-01-01T00:00:00.000Z',
          lastUpdated: '2020-01-01T00:00:00.000Z',
        },
      },
    }
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
    fs.writeFileSync(manifestPath, JSON.stringify(preExisting, null, 2))

    await runAuditSources(makeOpts({ db: await emptyDb(), apply: true, yes: true }))

    const git = entry(FIXTURE_DIRS.git)!
    expect(git.id).toBe('preexisting-id')
    expect(git.source).toBe('https://github.com/someoneelse/different')
    expect(git.version).toBe('9.9.9')
  })
})

describe('SMI-5407 e2e — --write-frontmatter churn guard (scenario 8)', () => {
  it('writes repository: only into non-git dirs lacking one', async () => {
    // Isolated, mutable fixture (write-frontmatter rewrites SKILL.md).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smi5407-fm-'))
    writeSourceFixture(root) // provides git-skill (.git) + plugin-skill (plugin.json)

    const nosrc = path.join(root, 'nosrc-skill')
    fs.mkdirSync(nosrc, { recursive: true })
    fs.writeFileSync(path.join(nosrc, 'SKILL.md'), skillMd('nosrc-skill'))

    const hasrepo = path.join(root, 'hasrepo-skill')
    fs.mkdirSync(hasrepo, { recursive: true })
    fs.writeFileSync(
      path.join(hasrepo, 'SKILL.md'),
      skillMd('hasrepo-skill', 'repository: https://github.com/existing/existing')
    )

    const gitBefore = fs.readFileSync(path.join(root, FIXTURE_DIRS.git, 'SKILL.md'), 'utf-8')
    const hasrepoBefore = fs.readFileSync(path.join(hasrepo, 'SKILL.md'), 'utf-8')

    await runAuditSources(
      makeOpts({
        db: await emptyDb(),
        skillsRoot: root,
        apply: true,
        yes: true,
        writeFrontmatter: true,
        forceWriteFrontmatter: true,
        set: ['nosrc-skill=me/no', 'hasrepo-skill=me/has'],
      })
    )

    // .git dir: never rewritten.
    expect(fs.readFileSync(path.join(root, FIXTURE_DIRS.git, 'SKILL.md'), 'utf-8')).toBe(gitBefore)
    // Non-git, no existing repository: gets the recovered source written in.
    expect(fs.readFileSync(path.join(root, FIXTURE_DIRS.plugin, 'SKILL.md'), 'utf-8')).toContain(
      'repository: https://github.com/o/r'
    )
    expect(fs.readFileSync(path.join(nosrc, 'SKILL.md'), 'utf-8')).toContain(
      'repository: https://github.com/me/no'
    )
    // Already-present repository: never duplicated / overwritten.
    expect(fs.readFileSync(path.join(hasrepo, 'SKILL.md'), 'utf-8')).toBe(hasrepoBefore)

    fs.rmSync(root, { recursive: true, force: true })
  })
})
