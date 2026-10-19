/**
 * SMI-6531 (A1 step 1): install's main SKILL.md scan refuses to run under a
 * rank '1' lock. The fetch guard fires earlier in `install()`, so the fetch
 * helper is replaced with an unguarded stand-in here to reach the scan.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

vi.mock('../../../src/services/skill-installation.io.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/services/skill-installation.io.js')>()
  return { ...actual, fetchFromGitHub: vi.fn() }
})

import { fetchFromGitHub } from '../../../src/services/skill-installation.io.js'
import { SkillInstallationService } from '../../../src/services/skill-installation.service.js'
import { SecurityScanner } from '../../../src/security/index.js'
import { SkillRepository } from '../../../src/repositories/SkillRepository.js'
import { SkillDependencyRepository } from '../../../src/repositories/SkillDependencyRepository.js'
import { withFileLock } from '../../../src/config/file-lock.js'
import { createTestDatabase } from '../../helpers/database.js'
import type { Database } from '../../../src/db/database-interface.js'
import type { InstallResult } from '../../../src/services/skill-installation.types.js'

const VALID_SKILL_MD = `---
name: test-skill
description: A test skill for unit testing
---

# Test Skill

This is a valid skill file with enough content to pass the 100-character minimum
validation threshold that the service checks during installation.
`

describe('install() main SKILL.md scan guard', () => {
  let db: Database
  let tmpDir: string
  let skillsDir: string
  let manifestPath: string

  beforeEach(async () => {
    db = await createTestDatabase()
    tmpDir = path.join(
      os.tmpdir(),
      'skillsmith-lock-order-scan-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    )
    skillsDir = path.join(tmpDir, 'skills')
    manifestPath = path.join(tmpDir, 'manifest.json')
    await fs.mkdir(skillsDir, { recursive: true })
    vi.mocked(fetchFromGitHub).mockResolvedValue(VALID_SKILL_MD)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Not found', { status: 404 }))
    )
  })

  afterEach(async () => {
    db.close()
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const service = (): SkillInstallationService =>
    new SkillInstallationService({
      db,
      skillRepo: new SkillRepository(db),
      skillDependencyRepo: new SkillDependencyRepository(db),
      skillsDir,
      manifestPath,
    })

  it('refuses the scan under a rank 1 lock and never reaches the scanner', async () => {
    const scan = vi.spyOn(SecurityScanner.prototype, 'scan')
    let result: InstallResult | undefined
    await withFileLock(
      path.join(tmpDir, 'root'),
      'test lock 1',
      async () => {
        result = await service().install('https://github.com/test-owner/test-repo')
      },
      { rank: '1' }
    )
    expect(result?.success).toBe(false)
    expect(result?.error).toContain('scan: install SKILL.md')
    expect(result?.error).toContain('must run before the skills-root lock is taken')
    expect(scan).not.toHaveBeenCalled()
  })

  it('control: outside any lock the scan runs', async () => {
    const scan = vi.spyOn(SecurityScanner.prototype, 'scan')
    const result = await service().install('https://github.com/test-owner/test-repo')
    expect(result.success).toBe(true)
    expect(scan).toHaveBeenCalled()
  })
})
