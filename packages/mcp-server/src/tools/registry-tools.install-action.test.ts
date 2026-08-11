/**
 * @fileoverview SMI-5905 Wave 3 — `private_registry_manage(action:'install')` round-trip
 * @see docs/internal/implementation/private-registry-skill-install.md
 *
 * Two levels, deliberately:
 *
 * - **Dispatch**: through the real `executePrivateRegistryManage` handler, proving `install` is
 *   wired into the action switch and that its argument/not-found errors match the other actions'.
 * - **Round-trip**: through `executeRegistryInstall` directly, against the in-memory stub service
 *   (which now persists `content`) and a REAL `SkillInstallationService` writing into a temp
 *   directory — a genuine publish → install → on-disk cycle, not a mock handshake. The installer is
 *   injected only so the write lands in `os.tmpdir()`: `getInstallPath()` resolves from the real
 *   home directory at module load, so without that seam this test would write into the developer's
 *   own `~/.claude/skills`.
 *
 * The load-bearing assertion is the RESULT SHAPE one. `private_registry_manage`'s result is
 * rendered straight into the calling model's context and `content` can be 2 MB (ADR-129 Risks), so
 * it is asserted structurally — exact key sets on both the result and its `install` payload, plus
 * a scan of the serialized result for the published file bytes — rather than by grep alone
 * (Sol plan-review finding #10).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import {
  SkillInstallationService,
  SkillRepository,
  SkillDependencyRepository,
  createDatabaseAsync,
  initializeSchema,
  type Database,
} from '@skillsmith/core'
import type { ToolContext } from '../context.js'
import { executeRegistryInstall } from './registry-tools.install-action.js'
import {
  createStubRegistryService,
  executePrivateRegistryManage,
  privateRegistryManageInputSchema,
  setPrivateRegistryService,
  type PrivateRegistryService,
} from './registry-tools.js'

const mockContext = {} as ToolContext
const TEAM = 'team-alpha'
const SKILL_ID = 'myteam/acme-tool'

/** A line only present inside the published content — the canary for a content leak. */
const SECRET_LINE = 'a private team runbook line that must never reach the model'
const SKILL_MD = `---
name: acme-tool
description: A private-registry skill used to exercise the install action end to end
---

# Acme Tool

${SECRET_LINE}. This file is long enough to clear the 100-character minimum that the
install path's SKILL.md validation enforces.

## Usage

Use this skill by saying "Use the acme-tool skill to...".
`
const EXTRA_FILE = '# Examples\n\nMore private team content here.'
const CONTENT = { 'SKILL.md': SKILL_MD, 'examples.md': EXTRA_FILE }

let db: Database
let service: PrivateRegistryService
let tmpDir: string
let skillsDir: string
let manifestPath: string

function makeInstaller(): SkillInstallationService {
  return new SkillInstallationService({
    db,
    skillRepo: new SkillRepository(db),
    skillDependencyRepo: new SkillDependencyRepository(db),
    skillsDir,
    manifestPath,
  })
}

function runInstall(input: { skillId?: string; version?: string; force?: boolean } = {}) {
  return executeRegistryInstall({
    input: { action: 'install', skillId: SKILL_ID, ...input },
    teamId: TEAM,
    dataSource: 'stub',
    service,
    context: mockContext,
    createInstaller: () => makeInstaller(),
  })
}

beforeEach(async () => {
  db = await createDatabaseAsync(':memory:')
  initializeSchema(db)
  tmpDir = path.join(
    os.tmpdir(),
    `skillsmith-registry-install-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  skillsDir = path.join(tmpDir, 'skills')
  manifestPath = path.join(tmpDir, 'manifest.json')
  await fs.mkdir(skillsDir, { recursive: true })
  service = createStubRegistryService()
  setPrivateRegistryService(service)
})

afterEach(async () => {
  db.close()
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

// ---------------------------------------------------------------------------
// Dispatch — the action is really wired into the tool
// ---------------------------------------------------------------------------
describe('private_registry_manage(action:"install") — dispatch', () => {
  it('accepts "install" (with force) in the input schema', () => {
    const parsed = privateRegistryManageInputSchema.parse({
      action: 'install',
      skillId: SKILL_ID,
      force: true,
    })
    expect(parsed.action).toBe('install')
    expect(parsed.force).toBe(true)
  })

  it('rejects install without a skillId', async () => {
    const result = await executePrivateRegistryManage({ action: 'install' }, mockContext)
    expect(result.success).toBe(false)
    expect(result.error).toContain('skillId is required')
  })

  it('reports a never-published skill as not found, in action:"get"\'s exact words', async () => {
    // Byte-identical to the `get` action's message (registrySkillNotFoundMessage,
    // registry-tools.content.types.ts): a cross-team skillId lands here too (RLS returns no
    // rows), and so does a skillId whose only version is pending/rejected (SMI-5949 D-4) — this
    // must not distinguish any of those from "absent". SMI-5949 Wave 2 Step 3 appended a
    // generic, non-leaking hint to the shared message (plan-review finding M11).
    const result = await executePrivateRegistryManage(
      { action: 'install', skillId: 'myteam/nope' },
      mockContext
    )
    expect(result.success).toBe(false)
    expect(result.error).toBe(
      'Skill "myteam/nope" not found in private registry. If you expect this to exist, check ' +
        'with a team admin.'
    )
  })
})

// ---------------------------------------------------------------------------
// Round-trip — publish (stub) → install → on disk
// ---------------------------------------------------------------------------
describe('private_registry_manage(action:"install") — publish → install round-trip', () => {
  it('writes every published file to disk with private-registry provenance', async () => {
    await service.publish(TEAM, SKILL_ID, '1.0.0', CONTENT)

    const result = await runInstall()

    expect(result.success).toBe(true)
    expect(result.install).toMatchObject({
      skillId: SKILL_ID,
      skillName: 'acme-tool',
      version: '1.0.0',
      installPath: path.join(skillsDir, 'acme-tool'),
      fileCount: 2,
      trustTier: 'community',
    })

    const installedSkillMd = await fs.readFile(
      path.join(skillsDir, 'acme-tool', 'SKILL.md'),
      'utf-8'
    )
    expect(installedSkillMd).toContain(SECRET_LINE)
    const installedExtra = await fs.readFile(
      path.join(skillsDir, 'acme-tool', 'examples.md'),
      'utf-8'
    )
    expect(installedExtra).toContain('More private team content')

    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'))
    expect(manifest.installedSkills['acme-tool'].source).toBe(`private-registry:${SKILL_ID}`)
    expect(manifest.installedSkills['acme-tool'].version).toBe('1.0.0')
  })

  it('never carries raw content in the tool result — exact shape, not a grep', async () => {
    await service.publish(TEAM, SKILL_ID, '1.0.0', CONTENT)
    const result = await runInstall()

    // Structural: the result carries exactly these keys, so a future field cannot appear here
    // without this assertion failing first.
    expect(Object.keys(result).sort()).toEqual(['dataSource', 'install', 'message', 'success'])
    expect(Object.keys(result.install!).sort()).toEqual([
      'fileCount',
      'installPath',
      'skillId',
      'skillName',
      'tips',
      'trustTier',
      'version',
    ])
    expect(result).not.toHaveProperty('content')
    expect(result.install).not.toHaveProperty('content')
    expect(result.install).not.toHaveProperty('securityReport')

    // And nothing nested carries the bytes either.
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(SECRET_LINE)
    expect(serialized).not.toContain('More private team content')
  })

  it('refuses a second install without force, and succeeds with it', async () => {
    await service.publish(TEAM, SKILL_ID, '1.0.0', CONTENT)
    await runInstall()

    const blocked = await runInstall()
    expect(blocked.success).toBe(false)
    expect(blocked.error).toContain('already installed')
    // The machine-readable taxonomy code (SMI-4795) rides along with the message.
    expect(blocked.error).toContain('ALREADY_INSTALLED')

    const forced = await runInstall({ force: true })
    expect(forced.success).toBe(true)
  })

  it('surfaces a rejected traversal content key instead of writing outside the skill dir', async () => {
    // Every content-map key is attacker-controlled (any team member with publish access chooses
    // them) — Wave 1's validateContentKeys() is what stops this, and the action must surface it
    // rather than swallowing it into a generic failure.
    await service.publish(TEAM, SKILL_ID, '1.0.0', {
      'SKILL.md': SKILL_MD,
      '../../evil.md': 'pwned',
    })

    const result = await runInstall()
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Rejected content key/i)
    expect(result.error).toContain('INVALID_CONTENT')
    await expect(fs.access(path.join(tmpDir, 'evil.md'))).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Version selection — must agree with `get()`/the Edge Function
// ---------------------------------------------------------------------------
describe('private_registry_manage(action:"install") — version selection', () => {
  it('installs the most recently published version when none is given', async () => {
    await service.publish(TEAM, SKILL_ID, '2.0.0', CONTENT)
    await service.publish(TEAM, SKILL_ID, '1.9.0', CONTENT)

    const result = await runInstall()
    // Most recently PUBLISHED, not the highest semver — the same rule `get()` and the
    // private-registry-get Edge Function apply.
    expect(result.install?.version).toBe('1.9.0')
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'))
    expect(manifest.installedSkills['acme-tool'].version).toBe('1.9.0')
  })

  it('pins an explicitly requested version', async () => {
    await service.publish(TEAM, SKILL_ID, '1.0.0', CONTENT)
    await service.publish(TEAM, SKILL_ID, '2.0.0', CONTENT)

    const result = await runInstall({ version: '1.0.0' })
    expect(result.install?.version).toBe('1.0.0')
  })

  it('reports an unknown explicit version as not found', async () => {
    await service.publish(TEAM, SKILL_ID, '1.0.0', CONTENT)
    const result = await runInstall({ version: '9.9.9' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('not found in private registry')
  })
})
