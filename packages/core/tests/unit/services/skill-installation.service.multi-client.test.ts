/**
 * SMI-5894 Wave 1 Step 3: multi-client manifest re-keying
 *
 * getInstalledSkills() dedupes same-named skills across clients with
 * Claude Code precedence; before this fix, SkillInstallationService wrote
 * every manifest entry under a bare skill-name key regardless of client,
 * so installing the same skill name under two clients silently collided
 * (the second install's manifest write overwrote the first). This suite
 * is the required cross-cutting regression scenario from the plan's
 * Verification section (both Wave 1 and Wave 2 require coverage).
 *
 * Split out of skill-installation.service.test.ts (CLAUDE.md's 500-line
 * file cap) rather than left inline -- this scenario is also cohesive
 * enough to stand alone.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { SkillInstallationService } from '../../../src/services/skill-installation.service.js'
import { SkillRepository } from '../../../src/repositories/SkillRepository.js'
import { SkillDependencyRepository } from '../../../src/repositories/SkillDependencyRepository.js'
import { createTestDatabase } from '../../helpers/database.js'
import type { Database } from '../../../src/db/database-interface.js'

const VALID_SKILL_MD = `---
name: test-skill
description: A test skill for unit testing
---

# Test Skill

This is a valid skill file with enough content to pass the 100-character minimum
validation threshold that the service checks during installation.

## Usage

Use this skill by saying "Use the test-skill skill to..."
`

let tmpDir: string
let skillsDir: string
let manifestPath: string

async function createTmpDirs(): Promise<void> {
  tmpDir = path.join(
    os.tmpdir(),
    'skillsmith-test-' + Date.now() + '-' + Math.random().toString(36).slice(2)
  )
  skillsDir = path.join(tmpDir, 'skills')
  manifestPath = path.join(tmpDir, 'manifest.json')
  await fs.mkdir(skillsDir, { recursive: true })
}

async function cleanupTmpDirs(): Promise<void> {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
}

function createService(
  db: Database,
  overrides: Partial<ConstructorParameters<typeof SkillInstallationService>[0]> = {}
): SkillInstallationService {
  const skillRepo = new SkillRepository(db)
  const skillDependencyRepo = new SkillDependencyRepository(db)

  return new SkillInstallationService({
    db,
    skillRepo,
    skillDependencyRepo,
    skillsDir,
    manifestPath,
    ...overrides,
  })
}

describe('SMI-5894 Wave 1 Step 3: multi-client manifest re-keying', () => {
  let db: Database
  let cursorSkillsDir: string

  beforeEach(async () => {
    db = await createTestDatabase()
    await createTmpDirs()

    vi.stubGlobal('fetch', vi.fn())
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockImplementation(async (url) => {
      const urlStr = typeof url === 'string' ? url : url.toString()
      if (urlStr.includes('SKILL.md')) {
        return new Response(VALID_SKILL_MD, { status: 200 })
      }
      return new Response('Not found', { status: 404 })
    })

    cursorSkillsDir = path.join(tmpDir, 'cursor-skills')
    await fs.mkdir(cursorSkillsDir, { recursive: true })
  })

  afterEach(async () => {
    db.close()
    await cleanupTmpDirs()
    vi.restoreAllMocks()
  })

  it('installs the same skill name independently under two clients without collision', async () => {
    const claudeService = createService(db, { client: 'claude-code' })
    const cursorService = createService(db, { client: 'cursor', skillsDir: cursorSkillsDir })

    const claudeResult = await claudeService.install('https://github.com/owner/test-repo', {
      skipOptimize: true,
    })
    const cursorResult = await cursorService.install('https://github.com/owner/test-repo', {
      skipOptimize: true,
    })

    expect(claudeResult.success).toBe(true)
    expect(cursorResult.success).toBe(true)

    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'))
    // Canonical client keeps the legacy bare-name key (backward compat).
    expect(manifest.installedSkills['test-repo']).toBeDefined()
    expect(manifest.installedSkills['test-repo'].installPath).toBe(
      path.join(skillsDir, 'test-repo')
    )
    expect(manifest.installedSkills['test-repo'].client).toBe('claude-code')
    // Non-canonical client gets a distinct composite key — does NOT
    // overwrite the claude-code entry above.
    expect(manifest.installedSkills['test-repo::cursor']).toBeDefined()
    expect(manifest.installedSkills['test-repo::cursor'].installPath).toBe(
      path.join(cursorSkillsDir, 'test-repo')
    )
    expect(manifest.installedSkills['test-repo::cursor'].client).toBe('cursor')

    // Both physical directories exist independently.
    await expect(fs.access(path.join(skillsDir, 'test-repo'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(cursorSkillsDir, 'test-repo'))).resolves.toBeUndefined()
  })

  it('uninstalling the Cursor copy leaves the Claude Code copy untouched (and vice versa)', async () => {
    const claudeService = createService(db, { client: 'claude-code' })
    const cursorService = createService(db, { client: 'cursor', skillsDir: cursorSkillsDir })

    await claudeService.install('https://github.com/owner/test-repo', { skipOptimize: true })
    await cursorService.install('https://github.com/owner/test-repo', { skipOptimize: true })

    const uninstallResult = await cursorService.uninstall('test-repo')
    expect(uninstallResult.success).toBe(true)

    // Cursor copy removed from disk and the manifest...
    await expect(fs.access(path.join(cursorSkillsDir, 'test-repo'))).rejects.toThrow()
    const manifestAfterCursorRemove = JSON.parse(await fs.readFile(manifestPath, 'utf-8'))
    expect(manifestAfterCursorRemove.installedSkills['test-repo::cursor']).toBeUndefined()

    // ...but the Claude Code copy is untouched on disk and in the manifest.
    await expect(fs.access(path.join(skillsDir, 'test-repo'))).resolves.toBeUndefined()
    expect(manifestAfterCursorRemove.installedSkills['test-repo']).toBeDefined()
  })
})
