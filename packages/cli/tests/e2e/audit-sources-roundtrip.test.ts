/**
 * @fileoverview SMI-5407 end-to-end — GATE (write half): recover -> backfill.
 *
 * Drives the REAL CLI apply path (`audit sources --apply --yes --min-confidence
 * medium`) into a REAL temp manifest and asserts the load-bearing backfill keys:
 *   - a single registry-name match (medium) writes the registry UUID as `id`
 *     (the only id form `skill_outdated` can resolve a registry skill by);
 *   - a git remote (exact) writes an owner/skill-name `id` (no UUID — the git
 *     tier has none);
 *   - both write an https `source` that `buildRawUrl` accepts (View-Changes).
 *
 * The READ half — that real `skill_outdated` resolves the UUID id (and NOT the
 * owner/skill-name, owner/repo, or URL decoy forms), while the git owner/skill-
 * name id resolves to `unknown` yet keeps a working View-Changes source — lives
 * in `packages/mcp-server/src/__tests__/skill-outdated-resolution.test.ts`.
 * It cannot live here: importing the mcp-server `executeOutdated`/`ToolContext`
 * source across the package boundary is structurally invalid under the CLI
 * tsconfig rootDir (TS6059/TS6307), and those symbols are not part of the
 * mcp-server package's public exports. The shared REG_UUID + manifest shape are
 * the contract linking the two halves.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
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
import type { SkillManifest, SkillManifestEntry } from '@skillsmith/core'

let runAuditSources: (o: AuditSourcesOptions) => Promise<void>
let tempHome = ''
let skillsRoot = ''
let manifestPath = ''
let originalHome: string | undefined
let dbCounter = 0

// git tier: owner/skill-name id (no registry UUID).
const GIT_ID = `${GIT_OWNER}/${FIXTURE_DIRS.git}`
// git tier canonical recovered source (both git fixtures share owner/repo).
const GIT_SOURCE = `https://github.com/${GIT_OWNER}/${GIT_REPO}`
// SMI-5411: registry UUID a catalog-known git repo enriches its manifest id to.
const GIT_REG_UUID = 'b2c3d4e5-0000-4000-8000-000000000002'
// registry tier: a single-name match carrying the UUID.
const REG_UUID = 'a1b2c3d4-0000-4000-8000-000000000001'
const REG_OWNER = 'regowner'
const REG_REPO = 'regrepo'
const REG_SOURCE = `https://github.com/${REG_OWNER}/${REG_REPO}`

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
    writeFrontmatter: false,
    forceWriteFrontmatter: false,
    db: o.db,
  }
}

function entry(name: string): SkillManifestEntry | undefined {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as SkillManifest
  return manifest.installedSkills[name]
}

beforeAll(async () => {
  originalHome = process.env['HOME']
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'smi5407-rt-home-'))
  process.env['HOME'] = tempHome
  skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smi5407-rt-skills-'))
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

describe('SMI-5407 e2e GATE (write) — recover -> backfill (scenario 2)', () => {
  it('writes the registry UUID id (medium) and the git owner/skill-name id (exact)', async () => {
    const db = path.join(tempHome, `rt-${dbCounter++}.db`)
    await seedSkillsDb(db, [{ id: REG_UUID, name: FIXTURE_DIRS.registry, repoUrl: REG_SOURCE }])

    // --min-confidence medium so the single registry-name match qualifies
    // (fixed qualifies(): the minConfidence floor IS the gate, no AUTO_QUALIFY).
    await runAuditSources(makeOpts({ db, apply: true, yes: true, minConfidence: 'medium' }))

    // registry: the load-bearing UUID id + https owner/repo source.
    const registry = entry(FIXTURE_DIRS.registry)!
    expect(registry.id).toBe(REG_UUID)
    expect(registry.source).toBe(REG_SOURCE)
    expect(buildRawUrl(registry.source)).toBe(
      `https://raw.githubusercontent.com/${REG_OWNER}/${REG_REPO}/main/SKILL.md`
    )

    // git: exact, owner/skill-name id, buildRawUrl-parseable source.
    const git = entry(FIXTURE_DIRS.git)!
    expect(git.id).toBe(GIT_ID)
    expect(git.source).toBe(`https://github.com/${GIT_OWNER}/${GIT_REPO}`)
    expect(buildRawUrl(git.source)).not.toBeNull()
  })

  it('default min-confidence (high) leaves the medium registry match unwritten', async () => {
    const db = path.join(tempHome, `rt-${dbCounter++}.db`)
    await seedSkillsDb(db, [{ id: REG_UUID, name: FIXTURE_DIRS.registry, repoUrl: REG_SOURCE }])

    await runAuditSources(makeOpts({ db, apply: true, yes: true }))

    expect(entry(FIXTURE_DIRS.registry)).toBeUndefined()
    expect(entry(FIXTURE_DIRS.git)).toBeDefined()
  })

  // SMI-5411: when the git skill's recovered repo_url IS in the local catalog,
  // `audit sources --apply` enriches its manifest id from owner/skill-name to the
  // registry UUID (so skill_outdated can resolve it) WITHOUT changing the exact
  // git SOURCE (View-Changes unchanged). The READ half — that real
  // skill_outdated resolves this UUID id and rejects decoy forms — lives in
  // packages/mcp-server/src/__tests__/skill-outdated-resolution.test.ts.
  it('enriches a catalog-known git skill id to the registry UUID at default confidence', async () => {
    const db = path.join(tempHome, `rt-${dbCounter++}.db`)
    // Seed a catalog row whose repo_url matches the git fixture's recovered
    // source. `name` is distinct from the git fixture dir so the name-match tier
    // is never reached — the git tier short-circuits and only the id is enriched.
    await seedSkillsDb(db, [{ id: GIT_REG_UUID, name: GIT_REPO, repoUrl: GIT_SOURCE }])

    await runAuditSources(makeOpts({ db, apply: true, yes: true }))

    const git = entry(FIXTURE_DIRS.git)!
    expect(git.id).toBe(GIT_REG_UUID) // enriched UUID, not owner/skill-name
    expect(git.id).not.toBe(GIT_ID) // the un-enriched decoy form must not win
    expect(git.source).toBe(GIT_SOURCE) // exact git source unchanged
    expect(buildRawUrl(git.source)).toBe(
      `https://raw.githubusercontent.com/${GIT_OWNER}/${GIT_REPO}/main/SKILL.md`
    )
  })

  it('leaves the git id as owner/skill-name when the repo is NOT catalog-known (graceful)', async () => {
    const db = path.join(tempHome, `rt-${dbCounter++}.db`)
    // No skills row for the git repo_url -> findRegistryIdByRepoUrl returns null.
    await seedSkillsDb(db, [{ id: REG_UUID, name: FIXTURE_DIRS.registry, repoUrl: REG_SOURCE }])

    await runAuditSources(makeOpts({ db, apply: true, yes: true }))

    const git = entry(FIXTURE_DIRS.git)!
    expect(git.id).toBe(GIT_ID) // unchanged fallback
    expect(git.source).toBe(GIT_SOURCE)
  })
})
