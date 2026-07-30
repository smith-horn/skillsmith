/**
 * SMI-5894 Wave 1 Step 3 — same-name, multi-client regression test.
 *
 * Cross-cutting Verification requirement (plan doc: "Same-name-installed-
 * under-two-clients regression scenario covered by tests in both Wave 1
 * (remove/update --client) and Wave 2 (manifest resolution)"). This file
 * covers the Wave 1 half: installing the same skill name independently
 * under both Claude Code and Cursor, then verifying `remove`/`update
 * --client cursor` acts only on the Cursor copy and leaves the Claude Code
 * copy untouched (and vice versa).
 *
 * Unlike manage.test.ts / manage.update.test.ts (which mock
 * @skillsmith/core's SkillInstallationService entirely — appropriate for
 * their shallow command-shape / dispatch tests), this file exercises the
 * REAL SkillInstallationService end-to-end against a temp $HOME, mocking
 * only `fetch` (GitHub SKILL.md fetch), the same technique
 * skill-installation.service.test.ts uses at the core level. This is the
 * only way to actually prove the manifest re-keying + per-invocation
 * skillsDir resolution fix (Wave 1 Steps 2/3) behaves correctly end to end
 * through the CLI's own install/remove/update actions, not just that a
 * mock was called with the right arguments.
 */
import { mkdtemp, rm, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const VALID_SKILL_MD = `---
name: test-skill
description: A test skill for the SMI-5894 multi-client regression test
---

# Test Skill

This is a valid skill file with enough content to pass the 100-character
minimum validation threshold that the install service checks during
installation. Nothing suspicious here, just plain instructional prose.
`

const ORIGINAL_HOME = process.env['HOME']
const ORIGINAL_USERPROFILE = process.env['USERPROFILE']
const ORIGINAL_CLIENT = process.env['SKILLSMITH_CLIENT']

let homeDir: string
let dbPath: string

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(tmpdir(), 'smi5894-manage-multi-'))
  process.env['HOME'] = homeDir
  process.env['USERPROFILE'] = homeDir
  delete process.env['SKILLSMITH_CLIENT']
  dbPath = path.join(homeDir, 'skills.db')

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const urlStr = typeof url === 'string' ? url : url.toString()
      if (urlStr.includes('SKILL.md')) {
        return new Response(VALID_SKILL_MD, { status: 200 })
      }
      return new Response('Not found', { status: 404 })
    })
  )

  // CLIENT_NATIVE_PATHS and DEFAULT_MANIFEST_PATH compute homedir() at
  // module import time — reset modules so each test sees its own $HOME
  // (same technique as install-multi-client.test.ts).
  vi.resetModules()

  // Quiet the install/remove commands' own console.log output — none of
  // these tests assert on stdout, only on filesystem/manifest state.
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (ORIGINAL_HOME === undefined) delete process.env['HOME']
  else process.env['HOME'] = ORIGINAL_HOME
  if (ORIGINAL_USERPROFILE === undefined) delete process.env['USERPROFILE']
  else process.env['USERPROFILE'] = ORIGINAL_USERPROFILE
  if (ORIGINAL_CLIENT === undefined) delete process.env['SKILLSMITH_CLIENT']
  else process.env['SKILLSMITH_CLIENT'] = ORIGINAL_CLIENT
  await rm(homeDir, { recursive: true, force: true })
})

/** Install the fixture skill for a given client, asserting success. */
async function installForClient(client: string): Promise<void> {
  const { installAction } = await import('../src/commands/install.js')
  await installAction('https://github.com/owner/test-repo', {
    db: dbPath,
    client,
    quiet: true,
    json: true,
    skipOptimize: true,
  })
}

async function readManifest(): Promise<Record<string, unknown>> {
  const raw = await readFile(path.join(homeDir, '.skillsmith', 'manifest.json'), 'utf-8')
  return JSON.parse(raw) as Record<string, unknown>
}

describe('SMI-5894 Wave 1: same-name skill installed under two clients', () => {
  it('remove --client cursor removes only the Cursor copy, leaving Claude Code untouched', async () => {
    await installForClient('claude-code')
    await installForClient('cursor')

    const claudePath = path.join(homeDir, '.claude', 'skills', 'test-repo')
    const cursorPath = path.join(homeDir, '.cursor', 'skills', 'test-repo')
    await expect(access(claudePath)).resolves.toBeUndefined()
    await expect(access(cursorPath)).resolves.toBeUndefined()

    const { removeAction } = await import('../src/commands/manage.js')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await removeAction('test-repo', { force: true, db: dbPath, client: 'cursor' })
    exitSpy.mockRestore()

    // Cursor copy removed from disk...
    await expect(access(cursorPath)).rejects.toThrow()
    // ...Claude Code copy untouched on disk.
    await expect(access(claudePath)).resolves.toBeUndefined()

    const manifest = await readManifest()
    const installedSkills = manifest['installedSkills'] as Record<string, unknown>
    expect(installedSkills['test-repo::cursor']).toBeUndefined()
    expect(installedSkills['test-repo']).toBeDefined()
  })

  it('remove --client cursor on an independent Cursor install does not tear down an unrelated canonical fan-out link (SMI-5894 review finding)', async () => {
    // Canonical install, fanned out to Windsurf via addLink -- this
    // fan-out link is NOT related to the independent Cursor install below;
    // it belongs entirely to the canonical copy. Calling the fan-out
    // primitive directly (rather than through `install --also-link`)
    // isolates the behavior under test -- removeLinks scoping -- from the
    // CLI's own fan-out wiring.
    await installForClient('claude-code')
    const { addLink } = await import('@skillsmith/core/install')
    await addLink({ skillId: 'test-repo', fromClient: 'claude-code', toClient: 'windsurf' })

    // A second, fully independent install of the SAME skill name directly
    // for Cursor (not a fan-out of the canonical copy).
    await installForClient('cursor')

    const windsurfPath = path.join(homeDir, '.codeium', 'windsurf', 'skills', 'test-repo')
    const cursorPath = path.join(homeDir, '.cursor', 'skills', 'test-repo')
    await expect(access(windsurfPath)).resolves.toBeUndefined()
    await expect(access(cursorPath)).resolves.toBeUndefined()

    const { removeAction } = await import('../src/commands/manage.js')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await removeAction('test-repo', { force: true, db: dbPath, client: 'cursor' })
    exitSpy.mockRestore()

    // The independent Cursor install is gone...
    await expect(access(cursorPath)).rejects.toThrow()
    // ...but the canonical install's unrelated Windsurf fan-out link must
    // survive -- removeLinks(skillId) has no per-destination client
    // scoping, so calling it for a non-canonical client-scoped removal
    // would previously delete every fan-out link for this skill name,
    // including this one, even though it belongs to a completely
    // different (canonical) install.
    await expect(access(windsurfPath)).resolves.toBeUndefined()
  })

  it('remove --client claude-code (the default, no flag) removes only the Claude Code copy, leaving Cursor untouched', async () => {
    await installForClient('claude-code')
    await installForClient('cursor')

    const claudePath = path.join(homeDir, '.claude', 'skills', 'test-repo')
    const cursorPath = path.join(homeDir, '.cursor', 'skills', 'test-repo')

    const { removeAction } = await import('../src/commands/manage.js')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    // No --client passed and no SKILLSMITH_CLIENT set — defaults to
    // claude-code, matching install's own default (Wave 1 Step 1).
    await removeAction('test-repo', { force: true, db: dbPath })
    exitSpy.mockRestore()

    await expect(access(claudePath)).rejects.toThrow()
    await expect(access(cursorPath)).resolves.toBeUndefined()

    const manifest = await readManifest()
    const installedSkills = manifest['installedSkills'] as Record<string, unknown>
    expect(installedSkills['test-repo']).toBeUndefined()
    expect(installedSkills['test-repo::cursor']).toBeDefined()
  })

  it('SKILLSMITH_CLIENT=cursor (no --client flag) scopes remove to the Cursor copy', async () => {
    await installForClient('claude-code')
    await installForClient('cursor')
    process.env['SKILLSMITH_CLIENT'] = 'cursor'

    const claudePath = path.join(homeDir, '.claude', 'skills', 'test-repo')
    const cursorPath = path.join(homeDir, '.cursor', 'skills', 'test-repo')

    const { removeAction } = await import('../src/commands/manage.js')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await removeAction('test-repo', { force: true, db: dbPath })
    exitSpy.mockRestore()

    await expect(access(cursorPath)).rejects.toThrow()
    await expect(access(claudePath)).resolves.toBeUndefined()
  })

  it('list --client cursor shows only the Cursor copy, not the Claude Code copy', async () => {
    await installForClient('claude-code')
    await installForClient('cursor')

    // Scoped scans also include repo-local (`./.claude/skills`) skills —
    // real when this test runs from the actual monorepo checkout, whose
    // own `.claude/skills` mount-point is populated. Filter down to the
    // fixture skill under test so that pre-existing local inventory
    // doesn't make this assertion flaky depending on cwd.
    const { getInstalledSkillsForClient } = await import('../src/utils/skills-directory.js')
    const cursorSkills = (await getInstalledSkillsForClient('cursor', dbPath)).filter(
      (s) => s.name === 'test-skill'
    )
    expect(cursorSkills.map((s) => s.installedVia)).toEqual(['cursor'])

    const claudeSkills = (await getInstalledSkillsForClient('claude-code', dbPath)).filter(
      (s) => s.name === 'test-skill'
    )
    expect(claudeSkills.map((s) => s.installedVia)).toEqual(['claude-code'])
  })

  it("update --client cursor resolves the Cursor copy as installed without being redirected to Claude Code's copy", async () => {
    // Install ONLY under Cursor — a Claude Code copy of the same name does
    // NOT exist. Before Wave 1 Step 3, getSkillDiff() consulted the global,
    // cross-client-deduped getInstalledSkills(), so a client-scoped lookup
    // for a skill that only exists under a non-canonical client had no way
    // to distinguish "not installed anywhere" from "not installed under
    // Claude Code but installed elsewhere" — this is exactly that case.
    await installForClient('cursor')

    const { getSkillDiff } = await import('../src/commands/manage.js')

    const cursorDiff = await getSkillDiff('test-skill', dbPath, 'cursor')
    expect(cursorDiff).not.toBe('not-installed')

    const claudeDiff = await getSkillDiff('test-skill', dbPath, 'claude-code')
    expect(claudeDiff).toBe('not-installed')
  })
})
