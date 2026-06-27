/**
 * SMI-5358 GAP-07: createDbRegistryLookup quarantine enforcement
 *
 * Verifies that createDbRegistryLookup consults the QuarantineRepository
 * so quarantined skills surface quarantined===true in the lookup result —
 * allowing SkillInstallationService to block the install. A regression to
 * hardcoded quarantined:false must fail assertion (1).
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  SkillRepository,
  QuarantineRepository,
  closeDatabase,
  type DatabaseType,
} from '@skillsmith/core'
import { openCliDatabase } from '../src/utils/open-database.js'
import { createDbRegistryLookup } from '../src/commands/install.js'

describe('SMI-5358 GAP-07: createDbRegistryLookup quarantine enforcement', () => {
  const opened: DatabaseType[] = []

  afterEach(() => {
    for (const db of opened) closeDatabase(db)
    opened.length = 0
  })

  async function open(): Promise<DatabaseType> {
    const db = await openCliDatabase(':memory:')
    opened.push(db)
    return db
  }

  it('(1) quarantined skill resolves with quarantined===true', async () => {
    const db = await open()
    const skillRepo = new SkillRepository(db)

    // Insert a skill with a known registry-format ID and a repoUrl so the lookup
    // does not bail out at the "no repoUrl" guard.
    skillRepo.create({
      id: 'test-author/quarantined-skill',
      name: 'Quarantined Skill',
      repoUrl: 'https://github.com/test-author/quarantined-skill',
    })

    // Quarantine the skill via the same DB so isQuarantined() returns true.
    const quarantineRepo = new QuarantineRepository(db)
    quarantineRepo.create({
      skillId: 'test-author/quarantined-skill',
      source: 'github',
      quarantineReason: 'Obfuscated code detected',
      severity: 'SUSPICIOUS',
    })

    const lookup = createDbRegistryLookup(skillRepo, db)
    const result = await lookup.lookup('test-author/quarantined-skill')

    // Regression-catch: reverting createDbRegistryLookup to hardcoded false
    // would make this assertion fail.
    expect(result).not.toBeNull()
    expect(result!.quarantined).toBe(true)
  })

  it('(2) clean (non-quarantined) skill resolves with quarantined===false', async () => {
    const db = await open()
    const skillRepo = new SkillRepository(db)

    skillRepo.create({
      id: 'test-author/clean-skill',
      name: 'Clean Skill',
      repoUrl: 'https://github.com/test-author/clean-skill',
    })

    // No quarantine entry for this skill — QuarantineRepository table is
    // created by the constructor but contains no rows for this ID.
    const lookup = createDbRegistryLookup(skillRepo, db)
    const result = await lookup.lookup('test-author/clean-skill')

    expect(result).not.toBeNull()
    expect(result!.quarantined).toBe(false)
  })

  it('(3) skill with no repoUrl resolves to null', async () => {
    const db = await open()
    const skillRepo = new SkillRepository(db)

    // Insert a skill WITHOUT a repoUrl (metadata-only seed data pattern).
    skillRepo.create({
      id: 'test-author/no-repo-skill',
      name: 'No Repo Skill',
      // repoUrl intentionally omitted
    })

    const lookup = createDbRegistryLookup(skillRepo, db)
    const result = await lookup.lookup('test-author/no-repo-skill')

    expect(result).toBeNull()
  })

  it('unknown skill ID resolves to null', async () => {
    const db = await open()
    const skillRepo = new SkillRepository(db)

    const lookup = createDbRegistryLookup(skillRepo, db)
    const result = await lookup.lookup('nobody/does-not-exist')

    expect(result).toBeNull()
  })
})
