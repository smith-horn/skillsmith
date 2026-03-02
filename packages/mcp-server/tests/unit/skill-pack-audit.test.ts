/**
 * @fileoverview Unit tests for skill_pack_audit tool
 * @module @skillsmith/mcp-server/tests/unit/skill-pack-audit
 *
 * SMI-2905: Version drift detection for skill packs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  executeSkillPackAudit,
  skillPackAuditInputSchema,
} from '../../src/tools/skill-pack-audit.js'
import { createTestDatabase } from '../../../core/tests/helpers/database.js'
import { ErrorCodes } from '@skillsmith/core'
import type { ToolContext } from '../../src/context.js'

// ============================================================================
// Helpers
// ============================================================================

/** Seed a single skill_versions row for testing */
function seedVersion(
  db: ReturnType<typeof createTestDatabase>,
  skillId: string,
  semver: string,
  recordedAt = Math.floor(Date.now() / 1000)
): void {
  // Include semver+recordedAt in hash to keep each row unique across calls
  db.prepare(
    `INSERT OR IGNORE INTO skill_versions (skill_id, content_hash, semver, recorded_at)
     VALUES (?, ?, ?, ?)`
  ).run(skillId, `hash-${skillId}-${semver ?? 'null'}-${recordedAt}`, semver, recordedAt)
}

/** Write a minimal SKILL.md file with given name and optional version */
async function writeSkillMd(dir: string, skillName: string, version?: string): Promise<void> {
  const frontmatter = version
    ? `---\nname: ${skillName}\ndescription: Test skill\nversion: ${version}\n---\n`
    : `---\nname: ${skillName}\ndescription: Test skill\n---\n`
  await fs.writeFile(join(dir, 'SKILL.md'), frontmatter)
}

// ============================================================================
// Test setup
// ============================================================================

describe('skill_pack_audit', () => {
  let testDir: string
  let skillsDir: string
  let db: ReturnType<typeof createTestDatabase>
  let toolContext: ToolContext

  beforeEach(async () => {
    testDir = await fs.mkdtemp(join(tmpdir(), 'pack-audit-test-' + Date.now() + '-'))
    skillsDir = join(testDir, 'skills')
    await fs.mkdir(skillsDir)

    db = createTestDatabase()
    toolContext = { db } as unknown as ToolContext
  })

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true })
  })

  // ============================================================================
  // Input schema
  // ============================================================================

  describe('skillPackAuditInputSchema', () => {
    it('requires pack_path', () => {
      expect(() => skillPackAuditInputSchema.parse({})).toThrow()
    })

    it('rejects empty pack_path', () => {
      expect(() => skillPackAuditInputSchema.parse({ pack_path: '' })).toThrow()
    })

    it('accepts a valid pack_path', () => {
      const result = skillPackAuditInputSchema.parse({ pack_path: '/some/path' })
      expect(result.pack_path).toBe('/some/path')
    })
  })

  // ============================================================================
  // Path traversal protection
  // ============================================================================

  describe('path traversal protection', () => {
    it('throws VALIDATION_INVALID_TYPE for path traversal in pack_path', async () => {
      await expect(
        executeSkillPackAudit({ pack_path: '../../../etc/passwd' }, toolContext)
      ).rejects.toMatchObject({
        code: ErrorCodes.VALIDATION_INVALID_TYPE,
      })
    })

    it('throws VALIDATION_INVALID_TYPE for encoded path traversal', async () => {
      await expect(
        executeSkillPackAudit({ pack_path: '%2e%2e/secrets' }, toolContext)
      ).rejects.toMatchObject({
        code: ErrorCodes.VALIDATION_INVALID_TYPE,
      })
    })
  })

  // ============================================================================
  // Missing skills/ directory
  // ============================================================================

  describe('missing skills/ directory', () => {
    it('throws SKILL_NOT_FOUND when pack has no skills/ directory', async () => {
      const emptyPack = await fs.mkdtemp(join(tmpdir(), 'empty-pack-'))
      try {
        await expect(
          executeSkillPackAudit({ pack_path: emptyPack }, toolContext)
        ).rejects.toMatchObject({
          code: ErrorCodes.SKILL_NOT_FOUND,
        })
      } finally {
        await fs.rm(emptyPack, { recursive: true, force: true })
      }
    })
  })

  // ============================================================================
  // Empty skills/ directory
  // ============================================================================

  describe('empty skills/ directory', () => {
    it('returns zero skills for empty skills/ directory', async () => {
      const result = await executeSkillPackAudit({ pack_path: testDir }, toolContext)

      expect(result.skillCount).toBe(0)
      expect(result.driftCount).toBe(0)
      expect(result.noRegistryDataCount).toBe(0)
      expect(result.skills).toEqual([])
    })
  })

  // ============================================================================
  // no_registry_data — skill not in local cache
  // ============================================================================

  describe('no_registry_data', () => {
    it('marks skill as no_registry_data when not in skill_versions', async () => {
      const skillDir = join(skillsDir, 'linear')
      await fs.mkdir(skillDir)
      await writeSkillMd(skillDir, 'linear', '1.2.0')

      const result = await executeSkillPackAudit({ pack_path: testDir }, toolContext)

      expect(result.skillCount).toBe(1)
      expect(result.skills[0]).toMatchObject({
        name: 'linear',
        bundledVersion: '1.2.0',
        registryVersion: null,
        skillId: null,
        status: 'no_registry_data',
      })
      expect(result.noRegistryDataCount).toBe(1)
      expect(result.driftCount).toBe(0)
    })

    it('marks skill as no_registry_data when registry row has null semver', async () => {
      seedVersion(db, 'smith-horn/linear', null as unknown as string)
      const skillDir = join(skillsDir, 'linear')
      await fs.mkdir(skillDir)
      await writeSkillMd(skillDir, 'linear', '1.2.0')

      const result = await executeSkillPackAudit({ pack_path: testDir }, toolContext)
      expect(result.skills[0].status).toBe('no_registry_data')
    })
  })

  // ============================================================================
  // current — versions match
  // ============================================================================

  describe('current', () => {
    it('marks skill as current when bundled equals registry version', async () => {
      seedVersion(db, 'smith-horn/linear', '1.2.0')
      const skillDir = join(skillsDir, 'linear')
      await fs.mkdir(skillDir)
      await writeSkillMd(skillDir, 'linear', '1.2.0')

      const result = await executeSkillPackAudit({ pack_path: testDir }, toolContext)

      expect(result.skills[0]).toMatchObject({
        name: 'linear',
        bundledVersion: '1.2.0',
        registryVersion: '1.2.0',
        skillId: 'smith-horn/linear',
        status: 'current',
      })
      expect(result.driftCount).toBe(0)
    })
  })

  // ============================================================================
  // outdated — registry is newer
  // ============================================================================

  describe('outdated', () => {
    it('marks skill as outdated when registry has newer minor version', async () => {
      seedVersion(db, 'smith-horn/linear', '1.3.0')
      const skillDir = join(skillsDir, 'linear')
      await fs.mkdir(skillDir)
      await writeSkillMd(skillDir, 'linear', '1.2.0')

      const result = await executeSkillPackAudit({ pack_path: testDir }, toolContext)

      expect(result.skills[0].status).toBe('outdated')
      expect(result.skills[0].registryVersion).toBe('1.3.0')
      expect(result.driftCount).toBe(1)
    })

    it('marks skill as outdated when registry has newer patch version', async () => {
      seedVersion(db, 'author/docker', '2.1.5')
      const skillDir = join(skillsDir, 'docker')
      await fs.mkdir(skillDir)
      await writeSkillMd(skillDir, 'docker', '2.1.3')

      const result = await executeSkillPackAudit({ pack_path: testDir }, toolContext)

      expect(result.skills[0].status).toBe('outdated')
      expect(result.driftCount).toBe(1)
    })

    it('marks skill as outdated when registry has newer major version', async () => {
      seedVersion(db, 'org/governance', '2.0.0')
      const skillDir = join(skillsDir, 'governance')
      await fs.mkdir(skillDir)
      await writeSkillMd(skillDir, 'governance', '1.9.9')

      const result = await executeSkillPackAudit({ pack_path: testDir }, toolContext)

      expect(result.skills[0].status).toBe('outdated')
    })
  })

  // ============================================================================
  // ahead — bundled is newer than registry
  // ============================================================================

  describe('ahead', () => {
    it('marks skill as ahead when bundled version is newer', async () => {
      seedVersion(db, 'smith-horn/linear', '1.0.0')
      const skillDir = join(skillsDir, 'linear')
      await fs.mkdir(skillDir)
      await writeSkillMd(skillDir, 'linear', '1.1.0')

      const result = await executeSkillPackAudit({ pack_path: testDir }, toolContext)

      expect(result.skills[0].status).toBe('ahead')
      expect(result.driftCount).toBe(1)
    })
  })

  // ============================================================================
  // missing_version — SKILL.md has no valid version
  // ============================================================================

  describe('missing_version', () => {
    it('marks skill as missing_version when SKILL.md has no version field', async () => {
      const skillDir = join(skillsDir, 'varlock')
      await fs.mkdir(skillDir)
      await writeSkillMd(skillDir, 'varlock') // no version arg

      const result = await executeSkillPackAudit({ pack_path: testDir }, toolContext)

      expect(result.skills[0]).toMatchObject({
        name: 'varlock',
        bundledVersion: null,
        status: 'missing_version',
      })
    })

    it('marks skill as missing_version when version is non-semver', async () => {
      const skillDir = join(skillsDir, 'docker')
      await fs.mkdir(skillDir)
      await fs.writeFile(
        join(skillDir, 'SKILL.md'),
        '---\nname: docker\ndescription: Test\nversion: latest\n---\n'
      )

      const result = await executeSkillPackAudit({ pack_path: testDir }, toolContext)

      expect(result.skills[0].status).toBe('missing_version')
      expect(result.skills[0].bundledVersion).toBeNull()
    })
  })

  // ============================================================================
  // Multiple skills
  // ============================================================================

  describe('multiple skills', () => {
    it('handles a mix of statuses across multiple skills', async () => {
      // current: governance 1.0.0 === registry 1.0.0
      seedVersion(db, 'smith-horn/governance', '1.0.0')
      const govDir = join(skillsDir, 'governance')
      await fs.mkdir(govDir)
      await writeSkillMd(govDir, 'governance', '1.0.0')

      // outdated: linear 1.0.0 but registry has 1.2.0
      seedVersion(db, 'smith-horn/linear', '1.2.0')
      const linDir = join(skillsDir, 'linear')
      await fs.mkdir(linDir)
      await writeSkillMd(linDir, 'linear', '1.0.0')

      // no_registry_data: docker not in DB
      const dockerDir = join(skillsDir, 'docker')
      await fs.mkdir(dockerDir)
      await writeSkillMd(dockerDir, 'docker', '3.0.0')

      const result = await executeSkillPackAudit({ pack_path: testDir }, toolContext)

      expect(result.skillCount).toBe(3)
      expect(result.driftCount).toBe(1) // only linear
      expect(result.noRegistryDataCount).toBe(1) // only docker

      const byName = Object.fromEntries(result.skills.map((s) => [s.name, s]))
      expect(byName['governance']?.status).toBe('current')
      expect(byName['linear']?.status).toBe('outdated')
      expect(byName['docker']?.status).toBe('no_registry_data')
    })

    it('returns skills sorted alphabetically', async () => {
      for (const name of ['zebra', 'apple', 'mango']) {
        const dir = join(skillsDir, name)
        await fs.mkdir(dir)
        await writeSkillMd(dir, name, '1.0.0')
      }

      const result = await executeSkillPackAudit({ pack_path: testDir }, toolContext)

      expect(result.skills.map((s) => s.name)).toEqual(['apple', 'mango', 'zebra'])
    })

    it('skips subdirectories with no SKILL.md', async () => {
      // subdirectory with no SKILL.md
      await fs.mkdir(join(skillsDir, 'empty-subdir'))
      // valid skill
      const dir = join(skillsDir, 'linear')
      await fs.mkdir(dir)
      await writeSkillMd(dir, 'linear', '1.0.0')

      const result = await executeSkillPackAudit({ pack_path: testDir }, toolContext)

      expect(result.skillCount).toBe(1)
      expect(result.skills[0].name).toBe('linear')
    })
  })

  // ============================================================================
  // packPath in response
  // ============================================================================

  describe('packPath in response', () => {
    it('returns resolved absolute packPath in response', async () => {
      const result = await executeSkillPackAudit({ pack_path: testDir }, toolContext)

      // resolve() normalises any symlinks; testDir from mkdtemp is already absolute
      expect(result.packPath).toBeTruthy()
      expect(result.packPath).toContain('pack-audit-test')
    })
  })

  // ============================================================================
  // Registry lookup uses most recent record
  // ============================================================================

  describe('registry version selection', () => {
    it('uses the most recently recorded version when multiple registry rows exist', async () => {
      const now = Math.floor(Date.now() / 1000)
      // Older record
      seedVersion(db, 'smith-horn/linear', '1.0.0', now - 3600)
      // Newer record
      seedVersion(db, 'smith-horn/linear', '1.5.0', now)

      const skillDir = join(skillsDir, 'linear')
      await fs.mkdir(skillDir)
      await writeSkillMd(skillDir, 'linear', '1.0.0')

      const result = await executeSkillPackAudit({ pack_path: testDir }, toolContext)

      // Most recent record (1.5.0) should be used — bundled 1.0.0 is outdated
      expect(result.skills[0].registryVersion).toBe('1.5.0')
      expect(result.skills[0].status).toBe('outdated')
    })
  })
})
