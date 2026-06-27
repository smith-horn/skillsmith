/**
 * @fileoverview SMI-5407 end-to-end — GATE (read half): skill_outdated resolution.
 *
 * The READ half of the recover -> backfill -> skill_outdated gate (the WRITE
 * half lives in `packages/cli/tests/e2e/audit-sources-roundtrip.test.ts`). It
 * runs the REAL `executeOutdated` against a REAL temp manifest ($HOME-redirected)
 * + a REAL temp SQLite `skill_versions` table — nothing mocked.
 *
 * Load-bearing claim: `skill_outdated` keys update resolution on the manifest
 * entry `id` (getVersionHistory(entry.id)). The manifest mirrors what the CLI
 * backfill writes — registry `id` = the UUID, git `id` = owner/skill-name — and
 * skill_versions is seeded with the registry UUID PLUS decoy rows under the
 * owner/skill-name, owner/repo, and full-URL forms. The test passes only if the
 * UUID row resolves (not a decoy), proving the UUID is the load-bearing id; the
 * git owner/skill-name id (no row) resolves to `unknown`, yet its `source` still
 * passes `buildRawUrl` so View-Changes works. id and source are independent.
 *
 * SMI-5411 adds a third entry: a git-recovered skill whose repo IS catalog-known,
 * so `audit sources` enriched its id from owner/skill-name to the registry UUID.
 * Like the registry case, it resolves ONLY via that UUID (decoys under owner/
 * skill-name, owner/repo, and URL must lose) — proving the enriched id, not the
 * git tier's owner/skill-name, is what skill_outdated keys on.
 *
 * $HOME is set BEFORE the dynamic import of outdated.js (its install.helpers
 * module-level MANIFEST_PATH freezes at import).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { SkillVersionRepository, SkillDependencyRepository } from '@skillsmith/core'
import { createTestDatabase, closeDatabase } from '@skillsmith/core/testkit'
import type { Database } from '@skillsmith/core'
import type { ToolContext } from '../context.js'
import { writeSourceFixture, FIXTURE_DIRS, GIT_OWNER, GIT_REPO } from './source-recovery-fixture.js'

type OutdatedFn = (
  input: { include_deps: boolean },
  context: ToolContext
) => Promise<{
  skills: Array<{ id: string; status: string; semver: string | null }>
}>

const GIT_ID = `${GIT_OWNER}/${FIXTURE_DIRS.git}`
const GIT_SOURCE = `https://github.com/${GIT_OWNER}/${GIT_REPO}`
// SMI-5411: a git-recovered skill whose repo IS catalog-known — its manifest id
// is enriched to the registry UUID (source stays the git remote). Mounted at the
// `https` fixture dir (a real git checkout of the same owner/repo, real SKILL.md).
const GIT_ENRICHED_UUID = 'c3d4e5f6-0000-4000-8000-000000000003'
const REG_UUID = 'a1b2c3d4-0000-4000-8000-000000000001'
const REG_OWNER = 'regowner'
const REG_REPO = 'regrepo'
const REG_SOURCE = `https://github.com/${REG_OWNER}/${REG_REPO}`

/** Replica of diff.ts:buildRawUrl — asserts a source is View-Changes-parseable. */
function buildRawUrl(source: string): string | null {
  if (source.startsWith('https://raw.githubusercontent.com/')) return source
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+))?/.exec(source)
  if (!m) return null
  const [, owner, repo, ref = 'main'] = m
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/SKILL.md`
}

function makeContext(db: Database): ToolContext {
  return {
    db,
    skillDependencyRepository: new SkillDependencyRepository(db),
  } as unknown as ToolContext
}

let executeOutdated: OutdatedFn
let tempHome = ''
let skillsRoot = ''
let originalHome: string | undefined

beforeAll(async () => {
  originalHome = process.env['HOME']
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'smi5407-out-home-'))
  process.env['HOME'] = tempHome
  skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smi5407-out-skills-'))
  writeSourceFixture(skillsRoot) // gives each entry a real SKILL.md to hash

  // Manifest mirrors exactly what the CLI backfill writes (see the write half).
  const now = '2026-06-26T00:00:00.000Z'
  const manifest = {
    version: '1.0.0',
    installedSkills: {
      [FIXTURE_DIRS.registry]: {
        id: REG_UUID, // registry tier -> UUID
        name: FIXTURE_DIRS.registry,
        version: '1.0.0',
        source: REG_SOURCE,
        installPath: path.join(skillsRoot, FIXTURE_DIRS.registry),
        installedAt: now,
        lastUpdated: now,
      },
      [FIXTURE_DIRS.git]: {
        id: GIT_ID, // git tier -> owner/skill-name (no UUID)
        name: FIXTURE_DIRS.git,
        version: '1.0.0',
        source: GIT_SOURCE,
        installPath: path.join(skillsRoot, FIXTURE_DIRS.git),
        installedAt: now,
        lastUpdated: now,
      },
      [FIXTURE_DIRS.https]: {
        id: GIT_ENRICHED_UUID, // SMI-5411: git source, id enriched to the catalog UUID
        name: FIXTURE_DIRS.https,
        version: '1.0.0',
        source: GIT_SOURCE,
        installPath: path.join(skillsRoot, FIXTURE_DIRS.https),
        installedAt: now,
        lastUpdated: now,
      },
    },
  }
  const manifestPath = path.join(tempHome, '.skillsmith', 'manifest.json')
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  ;({ executeOutdated } = (await import('../tools/outdated.js')) as unknown as {
    executeOutdated: OutdatedFn
  })
})

afterAll(() => {
  if (originalHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = originalHome
  for (const dir of [tempHome, skillsRoot]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('SMI-5407 e2e GATE (read) — skill_outdated keys on the manifest id', () => {
  it('resolves the registry skill ONLY via its UUID id, never a decoy form', async () => {
    const db = await createTestDatabase()
    const versionRepo = new SkillVersionRepository(db)
    await versionRepo.recordVersion(REG_UUID, 'feedfacefeedface', '2.1.0') // correct registry key (UUID)
    await versionRepo.recordVersion(`${REG_OWNER}/${FIXTURE_DIRS.registry}`, 'aaaa1111', '7.7.7') // owner/skill-name decoy
    await versionRepo.recordVersion(`${REG_OWNER}/${REG_REPO}`, 'bbbb2222', '6.6.6') // owner/repo decoy
    await versionRepo.recordVersion(REG_SOURCE, 'cccc3333', '5.5.5') // full-URL decoy
    // NOTE: no skill_versions row under the git owner/skill-name id.

    const result = await executeOutdated({ include_deps: false }, makeContext(db))
    const registryOut = result.skills.find((s) => s.id === REG_UUID)
    const gitOut = result.skills.find((s) => s.id === GIT_ID)

    // registry resolves via the UUID — NOT owner/skill-name (7.7.7), owner/repo
    // (6.6.6), or URL (5.5.5). The exact id the backfill writes is load-bearing.
    expect(registryOut).toBeDefined()
    expect(registryOut!.semver).toBe('2.1.0')
    expect(['current', 'outdated']).toContain(registryOut!.status)
    expect(buildRawUrl(REG_SOURCE)).not.toBeNull()

    // git's owner/skill-name id has no skill_versions row -> unknown, yet its
    // source still powers View-Changes (buildRawUrl non-null).
    expect(gitOut).toBeDefined()
    expect(gitOut!.status).toBe('unknown')
    expect(gitOut!.semver).toBeNull()
    expect(buildRawUrl(GIT_SOURCE)).not.toBeNull()

    closeDatabase(db)
  })

  it('SMI-5411: resolves a git skill via its enriched registry UUID, never a decoy', async () => {
    const db = await createTestDatabase()
    const versionRepo = new SkillVersionRepository(db)
    await versionRepo.recordVersion(GIT_ENRICHED_UUID, 'deadbeefdeadbeef', '3.4.0') // correct enriched UUID key
    await versionRepo.recordVersion(`${GIT_OWNER}/${FIXTURE_DIRS.https}`, 'aaaa1111', '9.9.9') // owner/skill-name decoy
    await versionRepo.recordVersion(`${GIT_OWNER}/${GIT_REPO}`, 'bbbb2222', '8.8.8') // owner/repo decoy
    await versionRepo.recordVersion(GIT_SOURCE, 'cccc3333', '7.7.7') // full-URL decoy

    const result = await executeOutdated({ include_deps: false }, makeContext(db))
    const enrichedOut = result.skills.find((s) => s.id === GIT_ENRICHED_UUID)

    // Before SMI-5411 a git-recovered id was owner/skill-name and resolved
    // `unknown`. The enriched UUID now resolves — and NOT owner/skill-name
    // (9.9.9), owner/repo (8.8.8), or URL (7.7.7).
    expect(enrichedOut).toBeDefined()
    expect(enrichedOut!.semver).toBe('3.4.0')
    expect(['current', 'outdated']).toContain(enrichedOut!.status)
    // The SOURCE stays the git remote, so View-Changes is unchanged.
    expect(buildRawUrl(GIT_SOURCE)).not.toBeNull()

    closeDatabase(db)
  })
})
