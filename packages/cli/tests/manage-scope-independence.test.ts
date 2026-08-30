/**
 * ADR-139 (SMI-6274 Wave 4) — required test 9, GPT-5.6-Sol PR review
 * follow-up: the existing workspace-scope.test.ts test 9 only proves the
 * RESOLVER picks the right directory/manifest for a given scope; it never
 * exercised `remove`/`update` end to end to prove each independently
 * targets its OWN scope's copy when the SAME skill name is installed at
 * BOTH global and workspace scope for one client — the exact SMI-5894
 * defect class (one axis over: scope, not client) ADR-139 point 1 commits
 * to closing.
 *
 * Mirrors `manage-multi-client.test.ts`'s real-end-to-end technique (real
 * SkillInstallationService against a temp $HOME, mocked only `fetch`) —
 * this file adds a SECOND isolated directory (a real `.git` workspace root,
 * distinct from $HOME) so scope, not client, is the axis under test.
 */
import { mkdtemp, mkdir, rm, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// updateSkill() prompts for confirmation before a real (non-dry-run) update
// — auto-confirm, matching manage-update-multi-client.test.ts's identical mock.
vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(async () => true),
}))

const VALID_SKILL_MD = `---
name: test-skill
description: A test skill for the ADR-139 scope-independence regression test
---

# Test Skill

This is a valid skill file with enough content to pass the 100-character
minimum validation threshold that the install service checks during
installation. Nothing suspicious here, just plain instructional prose.
`

const ORIGINAL_HOME = process.env['HOME']
const ORIGINAL_USERPROFILE = process.env['USERPROFILE']
const ORIGINAL_CLIENT = process.env['SKILLSMITH_CLIENT']
const ORIGINAL_SCOPE = process.env['SKILLSMITH_SCOPE']

let homeDir: string
let workspaceDir: string
let dbPath: string

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(tmpdir(), 'smi6274-scope-independence-home-'))
  // A SEPARATE, real workspace root — a `.git` directory makes it a VCS
  // boundary findWorkspaceRoot() can resolve `--scope workspace` against.
  // Deliberately not nested inside homeDir and not literally equal to it
  // (see manage-multi-client.test.ts's identical note on why that would
  // collapse the local/global scan targets onto the same directory).
  workspaceDir = await mkdtemp(path.join(tmpdir(), 'smi6274-scope-independence-workspace-'))
  await mkdir(path.join(workspaceDir, '.git'), { recursive: true })

  process.env['HOME'] = homeDir
  process.env['USERPROFILE'] = homeDir
  delete process.env['SKILLSMITH_CLIENT']
  delete process.env['SKILLSMITH_SCOPE']
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

  vi.resetModules()
  vi.spyOn(process, 'cwd').mockReturnValue(workspaceDir)
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
  if (ORIGINAL_SCOPE === undefined) delete process.env['SKILLSMITH_SCOPE']
  else process.env['SKILLSMITH_SCOPE'] = ORIGINAL_SCOPE
  await Promise.all([
    rm(homeDir, { recursive: true, force: true }),
    rm(workspaceDir, { recursive: true, force: true }),
  ])
})

/** Install the fixture skill for claude-code at the given scope, asserting success. */
async function installAtScope(scope: 'global' | 'workspace'): Promise<void> {
  const { installAction } = await import('../src/commands/install.js')
  await installAction('https://github.com/owner/test-repo', {
    db: dbPath,
    client: 'claude-code',
    scope,
    quiet: true,
    json: true,
    skipOptimize: true,
  })
}

async function readGlobalManifest(): Promise<Record<string, unknown>> {
  const raw = await readFile(path.join(homeDir, '.skillsmith', 'manifest.json'), 'utf-8')
  return JSON.parse(raw) as Record<string, unknown>
}

async function readWorkspaceManifest(): Promise<Record<string, unknown>> {
  const raw = await readFile(path.join(workspaceDir, '.skillsmith', 'manifest.json'), 'utf-8')
  return JSON.parse(raw) as Record<string, unknown>
}

// Suite-level timeout bump for the same reason manage-multi-client.test.ts
// documents: real end-to-end SkillInstallationService work (install x2 +
// remove/update) under full-suite CI contention.
describe('ADR-139 (SMI-6274 Wave 4): remove/update independently target their own scope copy', () => {
  it('installs the same skill name at BOTH global and workspace scope, independently', async () => {
    await installAtScope('global')
    await installAtScope('workspace')

    const globalPath = path.join(homeDir, '.claude', 'skills', 'test-repo')
    const workspacePath = path.join(workspaceDir, '.claude', 'skills', 'test-repo')
    await expect(access(globalPath)).resolves.toBeUndefined()
    await expect(access(workspacePath)).resolves.toBeUndefined()

    const globalManifest = await readGlobalManifest()
    const workspaceManifest = await readWorkspaceManifest()
    expect(
      (globalManifest['installedSkills'] as Record<string, unknown>)['test-repo']
    ).toBeDefined()
    expect(
      (workspaceManifest['installedSkills'] as Record<string, unknown>)['test-repo']
    ).toBeDefined()
  })

  it('remove --scope global removes only the global copy, leaving the workspace copy and its manifest entry untouched', async () => {
    await installAtScope('global')
    await installAtScope('workspace')

    const globalPath = path.join(homeDir, '.claude', 'skills', 'test-repo')
    const workspacePath = path.join(workspaceDir, '.claude', 'skills', 'test-repo')

    const { removeAction } = await import('../src/commands/manage.js')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await removeAction('test-repo', { force: true, db: dbPath, scope: 'global' })
    exitSpy.mockRestore()

    // Global copy gone from disk AND manifest...
    await expect(access(globalPath)).rejects.toThrow()
    const globalManifest = await readGlobalManifest()
    expect(
      (globalManifest['installedSkills'] as Record<string, unknown>)['test-repo']
    ).toBeUndefined()

    // ...workspace copy fully untouched on disk AND in its own manifest.
    await expect(access(workspacePath)).resolves.toBeUndefined()
    const workspaceManifest = await readWorkspaceManifest()
    expect(
      (workspaceManifest['installedSkills'] as Record<string, unknown>)['test-repo']
    ).toBeDefined()
  })

  it('remove --scope workspace removes only the workspace copy, leaving the global copy and its manifest entry untouched', async () => {
    await installAtScope('global')
    await installAtScope('workspace')

    const globalPath = path.join(homeDir, '.claude', 'skills', 'test-repo')
    const workspacePath = path.join(workspaceDir, '.claude', 'skills', 'test-repo')

    const { removeAction } = await import('../src/commands/manage.js')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await removeAction('test-repo', { force: true, db: dbPath, scope: 'workspace' })
    exitSpy.mockRestore()

    await expect(access(workspacePath)).rejects.toThrow()
    const workspaceManifest = await readWorkspaceManifest()
    expect(
      (workspaceManifest['installedSkills'] as Record<string, unknown>)['test-repo']
    ).toBeUndefined()

    await expect(access(globalPath)).resolves.toBeUndefined()
    const globalManifest = await readGlobalManifest()
    expect(
      (globalManifest['installedSkills'] as Record<string, unknown>)['test-repo']
    ).toBeDefined()
  })

  it("remove --scope workspace on a canonical-client install does not tear down the unrelated GLOBAL canonical install's fan-out link (GPT-5.6-Sol PR review round 3)", async () => {
    // Same removeLinks(skillId) global-manifest/bare-name-only mechanism as
    // manage-multi-client.test.ts's SMI-5894 fan-out guard test, but the
    // scenario round 3 caught: BOTH installs here are the canonical client
    // (claude-code) -- one global, one workspace-scoped, independent of each
    // other. A client-only guard (the pre-round-3 shape) would still fire
    // for this workspace-scoped removal, deleting the GLOBAL canonical
    // install's fan-out link even though only the workspace copy was being
    // removed. Fixed by also requiring scope === 'global' in
    // manage.action.ts.
    await installAtScope('global')
    const { addLink } = await import('@skillsmith/core/install')
    await addLink({ skillId: 'test-repo', fromClient: 'claude-code', toClient: 'windsurf' })
    await installAtScope('workspace')

    const windsurfPath = path.join(homeDir, '.codeium', 'windsurf', 'skills', 'test-repo')
    const workspacePath = path.join(workspaceDir, '.claude', 'skills', 'test-repo')
    await expect(access(windsurfPath)).resolves.toBeUndefined()
    await expect(access(workspacePath)).resolves.toBeUndefined()

    const { removeAction } = await import('../src/commands/manage.js')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    await removeAction('test-repo', { force: true, db: dbPath, scope: 'workspace' })
    exitSpy.mockRestore()

    // The workspace copy is gone...
    await expect(access(workspacePath)).rejects.toThrow()
    // ...but the GLOBAL canonical install's fan-out link to Windsurf must
    // survive -- it belongs to a completely different (global) install.
    await expect(access(windsurfPath)).resolves.toBeUndefined()
  })

  it('update --scope workspace force-reinstalls only the workspace copy, leaving the global manifest entry byte-identical', async () => {
    await installAtScope('global')
    await installAtScope('workspace')

    const globalManifestBefore = await readGlobalManifest()

    const { updateSkill } = await import('../src/commands/manage.js')
    const { resolveScopedSkillsDir } = await import('@skillsmith/core/install')
    const scopeTarget = resolveScopedSkillsDir({
      client: 'claude-code',
      cwd: workspaceDir,
      explicitScope: 'workspace',
    })

    // getSkillDiff()/updateSkill() (unlike a --force remove) resolve by
    // SCANNING and matching InstalledSkill.name — the SKILL.md front-matter
    // `name:` field (VALID_SKILL_MD declares `name: test-skill`), not the
    // install directory basename ('test-repo', from the GitHub URL) —
    // matching manage-multi-client.test.ts's identical `getSkillDiff`
    // call convention.
    const success = await updateSkill('test-skill', dbPath, false, 'claude-code', scopeTarget)
    expect(success).toBe(true)

    // The global manifest — a completely separate file — must be
    // byte-identical before and after: update --scope workspace must never
    // touch it (ADR-139 point 1: workspace-scoped writes stay in the
    // workspace-local manifest).
    const globalManifestAfter = await readGlobalManifest()
    expect(globalManifestAfter).toEqual(globalManifestBefore)

    // The workspace manifest's own entry was refreshed by the update.
    const workspaceManifest = await readWorkspaceManifest()
    const workspaceEntry = (workspaceManifest['installedSkills'] as Record<string, unknown>)[
      'test-repo'
    ] as { installPath: string }
    expect(workspaceEntry.installPath).toBe(
      path.join(workspaceDir, '.claude', 'skills', 'test-repo')
    )
  })
}, 60_000)
