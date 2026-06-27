/**
 * @fileoverview SMI-5407 end-to-end — `sklx audit sources` recovery (read paths).
 *
 * Real temp filesystem fixture + real temp SQLite (seeded `skills`) + real temp
 * manifest (redirected via $HOME). No value-baked mocks: the only injected edge
 * is network absence (an empty / unseeded candidate DB). Covers:
 *   1. CLI full-path `--json` — per-dir method/confidence/status; no manifest write.
 *   4. ssh-vs-https — both git fixtures normalize to one owner/repo + parse via buildRawUrl.
 *   7. Offline degradation — empty DB: git+plugin resolve, registry/collision unknown, no throw.
 *
 * $HOME is set BEFORE the dynamic import of the action module so its
 * module-level MANIFEST_PATH (utils/manifest.ts) freezes onto the temp home.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  writeSourceFixture,
  seedSkillsDb,
  buildRawUrl,
  FIXTURE_DIRS,
  GIT_OWNER,
  GIT_REPO,
} from './utils/source-recovery-fixture.js'
import type { AuditSourcesOptions } from '../../src/commands/audit-sources.action.js'
import type { SkillRecoveryResult } from '@skillsmith/core'

let runAuditSources: (o: AuditSourcesOptions) => Promise<void>
let tempHome = ''
let skillsRoot = ''
let manifestPath = ''
let originalHome: string | undefined
let dbCounter = 0

function makeOpts(o: Partial<AuditSourcesOptions> & { db: string }): AuditSourcesOptions {
  return {
    skillsRoot,
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

/** Run `audit sources --json` and return the parsed `{ skills, summary }`. */
async function runJson(dbPath: string): Promise<{
  skills: SkillRecoveryResult[]
  summary: Record<string, number>
}> {
  const chunks: string[] = []
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'))
      return true
    })
  try {
    await runAuditSources(makeOpts({ db: dbPath, json: true }))
  } finally {
    spy.mockRestore()
  }
  return JSON.parse(chunks.join('').trim())
}

function bySkill(skills: SkillRecoveryResult[], name: string): SkillRecoveryResult {
  const found = skills.find((s) => s.skillName === name)
  if (!found) throw new Error(`fixture skill not found in report: ${name}`)
  return found
}

/** A fresh seeded candidate DB: registry-skill (1 row) + collision-skill (2 rows). */
async function seededDb(): Promise<string> {
  const dbPath = path.join(tempHome, `cands-${dbCounter++}.db`)
  await seedSkillsDb(dbPath, [
    {
      id: 'reg-uuid-0001',
      name: FIXTURE_DIRS.registry,
      repoUrl: 'https://github.com/regowner/regrepo',
    },
    {
      id: 'coll-uuid-0001',
      name: FIXTURE_DIRS.collision,
      repoUrl: 'https://github.com/coll1/repoA',
    },
    {
      id: 'coll-uuid-0002',
      name: FIXTURE_DIRS.collision,
      repoUrl: 'https://github.com/coll2/repoB',
    },
  ])
  return dbPath
}

/** A fresh EMPTY candidate DB (no skills rows) — models the offline path. */
async function emptyDb(): Promise<string> {
  const dbPath = path.join(tempHome, `empty-${dbCounter++}.db`)
  await seedSkillsDb(dbPath, [])
  return dbPath
}

beforeAll(async () => {
  originalHome = process.env['HOME']
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'smi5407-recov-home-'))
  process.env['HOME'] = tempHome
  skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smi5407-recov-skills-'))
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

describe('SMI-5407 e2e — audit sources --json (scenario 1)', () => {
  it('reports the correct method/confidence/status per directory', async () => {
    const { skills, summary } = await runJson(await seededDb())

    const git = bySkill(skills, FIXTURE_DIRS.git)
    expect(git.method).toBe('git-remote')
    expect(git.confidence).toBe('exact')
    expect(git.status).toBe('recovered')

    const plugin = bySkill(skills, FIXTURE_DIRS.plugin)
    expect(plugin.method).toBe('plugin-json')
    expect(plugin.confidence).toBe('high')
    expect(plugin.status).toBe('recovered')

    const registry = bySkill(skills, FIXTURE_DIRS.registry)
    expect(registry.method).toBe('registry-name')
    expect(registry.confidence).toBe('medium')
    expect(registry.registryId).toBe('reg-uuid-0001')
    expect(registry.status).toBe('recovered')

    const collision = bySkill(skills, FIXTURE_DIRS.collision)
    expect(collision.candidates).toHaveLength(2)
    expect(collision.confidence).toBe('low')
    expect(collision.status).toBe('unknown')

    const backup = bySkill(skills, FIXTURE_DIRS.backup)
    expect(backup.status).toBe('skipped_backup')

    const unknown = bySkill(skills, FIXTURE_DIRS.unknown)
    expect(unknown.status).toBe('unknown')
    expect(unknown.confidence).toBe('unknown')

    // Summary echoes the per-dir tally (3 recovered: git + https + plugin).
    expect(summary['skipped_backup']).toBe(1)
    expect(summary['total']).toBe(skills.length)
  })

  it('does not write the manifest on a dry-run (--json)', async () => {
    await runJson(await seededDb())
    expect(fs.existsSync(manifestPath)).toBe(false)
  })
})

describe('SMI-5407 e2e — ssh vs https git remotes (scenario 4)', () => {
  it('normalizes both git fixtures to one owner/repo and a buildRawUrl-parseable source', async () => {
    const { skills } = await runJson(await seededDb())

    const git = bySkill(skills, FIXTURE_DIRS.git)
    const https = bySkill(skills, FIXTURE_DIRS.https)

    for (const result of [git, https]) {
      expect(result.recoveredSource).not.toBeNull()
      expect(result.recoveredSource?.owner).toBe(GIT_OWNER)
      expect(result.recoveredSource?.repo).toBe(GIT_REPO)
      expect(result.recoveredSource?.url).toBe(`https://github.com/${GIT_OWNER}/${GIT_REPO}`)
      expect(buildRawUrl(result.recoveredSource!.url)).toBe(
        `https://raw.githubusercontent.com/${GIT_OWNER}/${GIT_REPO}/main/SKILL.md`
      )
    }

    expect(git.recoveredSource).toEqual(https.recoveredSource)
  })
})

describe('SMI-5407 e2e — offline degradation (scenario 7)', () => {
  it('resolves git+plugin and degrades registry/collision to unknown without throwing', async () => {
    let report: { skills: SkillRecoveryResult[] } | undefined
    await expect(
      (async () => {
        report = await runJson(await emptyDb())
      })()
    ).resolves.toBeUndefined()

    const skills = report!.skills
    expect(bySkill(skills, FIXTURE_DIRS.git).status).toBe('recovered')
    expect(bySkill(skills, FIXTURE_DIRS.https).status).toBe('recovered')
    expect(bySkill(skills, FIXTURE_DIRS.plugin).status).toBe('recovered')

    // With no candidate rows, the name tiers degrade — no throw, no network.
    expect(bySkill(skills, FIXTURE_DIRS.registry).status).toBe('unknown')
    expect(bySkill(skills, FIXTURE_DIRS.registry).confidence).toBe('unknown')
    expect(bySkill(skills, FIXTURE_DIRS.collision).status).toBe('unknown')
    expect(bySkill(skills, FIXTURE_DIRS.collision).candidates).toHaveLength(0)
  })
})
