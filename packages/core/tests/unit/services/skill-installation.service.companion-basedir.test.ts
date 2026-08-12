/**
 * SMI-5982 code-review fix #1 (BLOCKING, cwd-dependent resolution):
 * `SkillInstallationService`'s `companionBaseDir` constructor param must
 * thread all the way through `install()` -> `writeInstallFiles()` ->
 * `resolveCompanionAgentPath()` so the Antigravity companion-agent file
 * lands under an explicitly-passed root, not whatever `process.cwd()`
 * happens to be at the moment the write actually runs — the exact hazard
 * for a long-running MCP server whose cwd is fixed at launch and does not
 * track the calling editor/agent's real project.
 *
 * `applyOptimization` (skill-installation.helpers.ts) is mocked to force a
 * deterministic `subagentContent` without depending on the real
 * TransformationService's content-shape heuristics — this test is about
 * PATH WIRING, not optimization behavior, which is covered elsewhere.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'node:os'

vi.mock('../../../src/services/skill-installation.helpers.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/services/skill-installation.helpers.js')>()
  return {
    ...actual,
    applyOptimization: vi.fn(
      async (_db: unknown, _skillId: string, skillName: string, skillMdContent: string) => ({
        finalSkillContent: skillMdContent,
        subSkillFiles: [],
        subagentContent: `---\nname: ${skillName}-specialist\n---\nCompanion subagent body`,
        claudeMdSnippet: undefined,
        optimizationInfo: {
          optimized: true,
          subSkills: [],
          subagentGenerated: true,
        },
      })
    ),
  }
})

import { SkillInstallationService } from '../../../src/services/skill-installation.service.js'
import { SkillRepository } from '../../../src/repositories/SkillRepository.js'
import { SkillDependencyRepository } from '../../../src/repositories/SkillDependencyRepository.js'
import { createTestDatabase } from '../../helpers/database.js'
import type { Database } from '../../../src/db/database-interface.js'

const VALID_SKILL_MD =
  '---\nname: my-skill\ndescription: test skill for SMI-5982 companionBaseDir wiring\n---\n\n' +
  '# My Skill\n\nEnough content here to clear the 100-character minimum validation threshold ' +
  'the installer enforces before proceeding with the rest of the install pipeline.'

describe('SkillInstallationService companionBaseDir wiring (SMI-5982 code-review fix #1)', () => {
  let db: Database
  let originalCwd: string
  let projectDir: string
  let skillsDir: string
  let manifestPath: string

  beforeEach(async () => {
    db = await createTestDatabase()
    originalCwd = process.cwd()
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skillsmith-service-companion-basedir-'))
    process.chdir(projectDir)
    skillsDir = path.join(projectDir, 'skills')
    manifestPath = path.join(projectDir, 'manifest.json')
    await fs.mkdir(skillsDir, { recursive: true })

    vi.stubGlobal('fetch', vi.fn())
    vi.mocked(fetch).mockImplementation(async (url) => {
      const urlStr = typeof url === 'string' ? url : url.toString()
      if (urlStr.includes('SKILL.md')) {
        return new Response(VALID_SKILL_MD, { status: 200 })
      }
      return new Response('Not found', { status: 404 })
    })
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    db.close()
    vi.restoreAllMocks()
    await fs.rm(projectDir, { recursive: true, force: true }).catch(() => {})
  })

  function buildService(
    overrides: Partial<ConstructorParameters<typeof SkillInstallationService>[0]> = {}
  ): SkillInstallationService {
    return new SkillInstallationService({
      db,
      skillRepo: new SkillRepository(db),
      skillDependencyRepo: new SkillDependencyRepository(db),
      skillsDir,
      manifestPath,
      client: 'antigravity',
      ...overrides,
    })
  }

  it('lands the antigravity companion file under an explicit companionBaseDir, not process.cwd()', async () => {
    const explicitBaseDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'skillsmith-service-explicit-basedir-')
    )
    try {
      const service = buildService({ companionBaseDir: explicitBaseDir })

      const result = await service.install('https://github.com/owner/my-skill')

      expect(result.success).toBe(true)
      const expectedPath = path.join(explicitBaseDir, '.agents', 'agents', 'my-skill', 'agent.md')
      expect(result.optimization?.subagentPath).toBe(expectedPath)
      await expect(fs.access(expectedPath)).resolves.toBeUndefined()
      // Must NOT have landed under process.cwd() (this describe block's projectDir) —
      // the whole point of the fix.
      expect(result.optimization?.subagentPath?.startsWith(projectDir)).toBe(false)
    } finally {
      await fs.rm(explicitBaseDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('defaults companionBaseDir to process.cwd() when omitted (regression: unchanged)', async () => {
    const service = buildService() // companionBaseDir omitted

    const result = await service.install('https://github.com/owner/my-skill')

    expect(result.success).toBe(true)
    const expectedPath = path.join(projectDir, '.agents', 'agents', 'my-skill', 'agent.md')
    expect(result.optimization?.subagentPath).toBe(expectedPath)
    await expect(fs.access(expectedPath)).resolves.toBeUndefined()
  })
})
