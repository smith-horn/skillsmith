/**
 * SMI-6531 (A1 step 1): a lock-order refusal inside `install()` must reach the
 * caller as itself. The fetch guard used to be swallowed by the bare `catch`
 * around `fetchFromGitHub` and reported as FETCH_FAILED ("Could not find
 * SKILL.md"). Runs the real `install()` under a rank '1' lock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { SkillInstallationService } from '../../../src/services/skill-installation.service.js'
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
const REFUSAL = 'must run before the skills-root lock is taken'

describe('install() surfaces a lock-order refusal', () => {
  let db: Database
  let tmpDir: string
  let skillsDir: string
  let manifestPath: string

  beforeEach(async () => {
    db = await createTestDatabase()
    tmpDir = path.join(
      os.tmpdir(),
      'skillsmith-lock-order-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    )
    skillsDir = path.join(tmpDir, 'skills')
    manifestPath = path.join(tmpDir, 'manifest.json')
    await fs.mkdir(skillsDir, { recursive: true })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = typeof url === 'string' ? url : url.toString()
        return u.includes('SKILL.md')
          ? new Response(VALID_SKILL_MD, { status: 200 })
          : new Response('Not found', { status: 404 })
      })
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

  const installUnderLockOne = async (): Promise<InstallResult> => {
    let result: InstallResult | undefined
    await withFileLock(
      path.join(tmpDir, 'root'),
      'test lock 1',
      async () => {
        result = await service().install('https://github.com/test-owner/test-repo')
      },
      { rank: '1' }
    )
    return result as InstallResult
  }

  it('reports the held-while-planning refusal, not FETCH_FAILED or an internal error', async () => {
    const result = await installUnderLockOne()
    expect(result.success).toBe(false)
    expect(result.error).toContain('fetch: fetchFromGitHub')
    expect(result.error).toContain(REFUSAL)
    expect(result.errorCode).not.toBe('FETCH_FAILED')
    expect(result.error).not.toContain('Could not find SKILL.md')
    expect(result.error).not.toMatch(/internal error/i)
    await expect(fs.access(path.join(skillsDir, 'test-repo'))).rejects.toThrow()
  })

  it('control: the same install outside any lock produces no lock-order error', async () => {
    const result = await service().install('https://github.com/test-owner/test-repo')
    expect(result.success).toBe(true)
    expect(result.error ?? '').not.toContain(REFUSAL)
  })
})
