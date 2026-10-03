/**
 * SMI-6529 Wave A0 — real end-to-end proof that `update` cannot force-install
 * into a directory OTHER than the one it diffed against, even when a tracked
 * manifest entry's recorded source resolves to a differently-named directory
 * (the exact "Linear -> linear-claude-skill" data-loss class: a registry or
 * raw-URL resolution lands in a NEW, wrongly-named directory instead of
 * overwriting the one being updated).
 *
 * Real `SkillInstallationService` / `ManifestManager` / `getSkillDiff` /
 * `updateSkill` against a temp $HOME — mirrors manage-update-adoption-real
 * .test.ts's technique (no `@skillsmith/core` mocking), mocking only
 * `@inquirer/prompts` (the confirm prompt) and `fetch` (which this guard
 * must prevent from ever being reached).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(async () => true),
}))

const ORIGINAL_HOME = process.env['HOME']
const ORIGINAL_USERPROFILE = process.env['USERPROFILE']

let homeDir: string
let dbPath: string
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(tmpdir(), 'smi6529-target-guard-real-'))
  process.env['HOME'] = homeDir
  process.env['USERPROFILE'] = homeDir
  dbPath = path.join(homeDir, 'skills.db')

  // This guard must refuse BEFORE any network fetch — a call here would be a
  // regression. Kept as a loud, defensive failure (never resolves 200) so a
  // regression is unmistakable rather than silently "succeeding" via a stub.
  fetchMock = vi.fn(async () => new Response('should never be reached', { status: 404 }))
  vi.stubGlobal('fetch', fetchMock)

  vi.resetModules()
  vi.spyOn(process, 'cwd').mockReturnValue(path.join(homeDir, 'no-such-workspace'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (ORIGINAL_HOME === undefined) delete process.env['HOME']
  else process.env['HOME'] = ORIGINAL_HOME
  if (ORIGINAL_USERPROFILE === undefined) delete process.env['USERPROFILE']
  else process.env['USERPROFILE'] = ORIGINAL_USERPROFILE
  await rm(homeDir, { recursive: true, force: true })
})

const SKILL_MD_BODY =
  '\n# Test Skill\n\nThis is a valid skill file with enough content to pass the ' +
  '100-character minimum validation threshold real callers check. Plain prose.\n'

describe('SMI-6529 Wave A0: update refuses INSTALL_TARGET_MISMATCH end to end', () => {
  it('refuses to write a NEW, differently-named directory when the tracked source resolves elsewhere — the on-disk directory and its content are untouched', async () => {
    const skillsDir = path.join(homeDir, '.claude', 'skills')
    const trackedDir = path.join(skillsDir, 'linear')
    await mkdir(trackedDir, { recursive: true })
    const skillMdPath = path.join(trackedDir, 'SKILL.md')
    const originalContent = `---\nname: linear\ndescription: test\n---\n${SKILL_MD_BODY}`
    await writeFile(skillMdPath, originalContent, 'utf-8')

    // A tracked manifest entry whose recorded `id` resolves to a DIFFERENT
    // repo name than the actual on-disk directory — exactly the "Linear ->
    // linear-claude-skill" incident shape (a raw-URL / registry resolution
    // pointed at an upstream repo whose name differs from the directory the
    // user actually has installed).
    const manifestPath = path.join(homeDir, '.skillsmith', 'manifest.json')
    await mkdir(path.dirname(manifestPath), { recursive: true })
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: '1.0.0',
        installedSkills: {
          linear: {
            id: 'https://github.com/someorg/linear-claude-skill',
            name: 'linear',
            version: '1.0.0',
            source: 'github:someorg/linear-claude-skill',
            installPath: trackedDir,
            installedAt: '2026-01-01T00:00:00.000Z',
            lastUpdated: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
      'utf-8'
    )

    const { updateSkill } = await import('../src/commands/manage.js')
    const success = await updateSkill('linear', dbPath, false, 'claude-code')

    expect(success).toBe(false)
    // The guard fires before any network fetch.
    expect(fetchMock).not.toHaveBeenCalled()
    // No new, wrongly-named directory was ever created.
    const wrongDir = path.join(skillsDir, 'linear-claude-skill')
    await expect(readFile(path.join(wrongDir, 'SKILL.md'), 'utf-8')).rejects.toThrow()
    // The original directory and its content are completely untouched.
    expect(await readFile(skillMdPath, 'utf-8')).toBe(originalContent)
  })

  // SMI-6529 M6 (round 2): `getSkillDiff` can resolve a manifest entry whose
  // OWN recorded `installPath` points at a DIFFERENT directory than the one
  // it actually just scanned and diffed against (`getInstalledSkillsForClient`'s
  // repo-local-overrides-global precedence, SMI-1630, is the concrete way
  // this happens: a repo-local `./.claude/skills/<name>` copy wins the name
  // match over an unrelated GLOBAL directory of the same name whose manifest
  // entry — keyed purely by name+client, with no scope component — still
  // records the GLOBAL path). `update` must refuse rather than silently
  // write to the GLOBAL directory the manifest entry names, since that is
  // NOT the directory whose version was actually compared.
  it("refuses when the manifest entry's recorded path is a DIFFERENT (global) directory than the one actually diffed (repo-local)", async () => {
    const workspaceDir = path.join(homeDir, 'workspace')
    await mkdir(workspaceDir, { recursive: true })
    vi.spyOn(process, 'cwd').mockReturnValue(workspaceDir)

    const { getLocalSkillsDir } = await import('../src/utils/local-skills-dir.js')
    const repoLocalDir = getLocalSkillsDir()
    await mkdir(repoLocalDir, { recursive: true })
    const repoLocalSkillDir = path.join(repoLocalDir, 'foo')
    await mkdir(repoLocalSkillDir, { recursive: true })
    const repoLocalContent = `---\nname: foo\ndescription: test\n---\n${SKILL_MD_BODY}`
    await writeFile(path.join(repoLocalSkillDir, 'SKILL.md'), repoLocalContent, 'utf-8')

    // An UNRELATED global directory of the same name, with different
    // content — this is what the (stale, scope-blind) manifest entry
    // records as this skill's installPath, and what service.install()
    // would actually write to if the guard didn't refuse.
    const globalSkillsDir = path.join(homeDir, '.claude', 'skills')
    const globalSkillDir = path.join(globalSkillsDir, 'foo')
    await mkdir(globalSkillDir, { recursive: true })
    const globalContent = `---\nname: foo\ndescription: unrelated global copy\n---\n${SKILL_MD_BODY}`
    await writeFile(path.join(globalSkillDir, 'SKILL.md'), globalContent, 'utf-8')

    const manifestPath = path.join(homeDir, '.skillsmith', 'manifest.json')
    await mkdir(path.dirname(manifestPath), { recursive: true })
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: '1.0.0',
        installedSkills: {
          foo: {
            id: 'https://github.com/someorg/foo',
            name: 'foo',
            version: '1.0.0',
            source: 'github:someorg/foo',
            installPath: globalSkillDir, // the DIVERGENT, scope-blind recorded path
            installedAt: '2026-01-01T00:00:00.000Z',
            lastUpdated: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
      'utf-8'
    )

    const { updateSkill } = await import('../src/commands/manage.js')
    const success = await updateSkill('foo', dbPath, false, 'claude-code')

    expect(success).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    // Neither copy was touched.
    expect(await readFile(path.join(repoLocalSkillDir, 'SKILL.md'), 'utf-8')).toBe(repoLocalContent)
    expect(await readFile(path.join(globalSkillDir, 'SKILL.md'), 'utf-8')).toBe(globalContent)
  })
})
