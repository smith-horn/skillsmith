/**
 * SMI-5390: Tests for `getInstalledSkillsPerHarness` — the cross-harness
 * inventory scanner that returns one entry per (harness × skill). Realpath is
 * used only to MEMOIZE the expensive SKILL.md parse and to collapse multiple
 * aliases to the same target WITHIN a single harness's own directory — it no
 * longer drops the emitted row for the SAME realpath observed under a
 * DIFFERENT harness (GH #1912 / SMI-5717; a prior version's bare realpath
 * `Set` collapsed that case too).
 *
 * Harness pattern follows the existing `skills-directory.test.ts` (SMI-4578):
 * temp `$HOME` + `process.cwd()` spy so we never touch the real `~/.claude`
 * directories. Modules are reset per test so CLIENT_NATIVE_PATHS recomputes
 * against the fake home.
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ORIGINAL_HOME = process.env['HOME']
const ORIGINAL_USERPROFILE = process.env['USERPROFILE']

let homeDir: string
let cwdDir: string

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(tmpdir(), 'smi5390-perharness-'))
  cwdDir = await mkdtemp(path.join(tmpdir(), 'smi5390-cwd-'))
  process.env['HOME'] = homeDir
  process.env['USERPROFILE'] = homeDir
  vi.spyOn(process, 'cwd').mockReturnValue(cwdDir)
  vi.resetModules()
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (ORIGINAL_HOME === undefined) delete process.env['HOME']
  else process.env['HOME'] = ORIGINAL_HOME
  if (ORIGINAL_USERPROFILE === undefined) delete process.env['USERPROFILE']
  else process.env['USERPROFILE'] = ORIGINAL_USERPROFILE
  await Promise.all([
    rm(homeDir, { recursive: true, force: true }),
    rm(cwdDir, { recursive: true, force: true }),
  ])
})

/**
 * Write a minimal SKILL.md under `<skillsRoot>/<id>/SKILL.md` and return
 * the full SKILL.md content so callers can compute the expected hash.
 */
async function plantSkill(
  skillsRoot: string,
  id: string,
  body: string = '# test\n'
): Promise<{ dir: string; content: string }> {
  const dir = path.join(skillsRoot, id)
  await mkdir(dir, { recursive: true })
  const content = `---\nname: ${id}\nversion: 1.0.0\n---\n${body}`
  await writeFile(path.join(dir, 'SKILL.md'), content, 'utf-8')
  return { dir, content }
}

describe('getInstalledSkillsPerHarness (SMI-5390)', () => {
  it('returns empty when no client directories exist', async () => {
    const { getInstalledSkillsPerHarness } = await import('../src/utils/skills-directory.js')
    const skills = await getInstalledSkillsPerHarness()
    expect(skills).toEqual([])
  })

  it('same-named skill under two distinct harness directories yields two entries', async () => {
    await plantSkill(path.join(homeDir, '.claude', 'skills'), 'docker', '# claude docker\n')
    await plantSkill(path.join(homeDir, '.cursor', 'skills'), 'docker', '# cursor docker\n')

    const { getInstalledSkillsPerHarness } = await import('../src/utils/skills-directory.js')
    const skills = await getInstalledSkillsPerHarness()

    const dockerEntries = skills.filter((s) => s.skillId === 'docker')
    expect(dockerEntries).toHaveLength(2)
    const harnesses = dockerEntries.map((s) => s.harness)
    expect(harnesses).toContain('claude-code')
    expect(harnesses).toContain('cursor')
  })

  it('symlinked alias (same realpath) yields one entry per harness — preserves cross-harness membership (GH #1912)', async () => {
    // Plant the skill under claude-code, then point ~/.agents/skills at the
    // same directory via a symlink — same inode, different harness path.
    const claudeSkillsDir = path.join(homeDir, '.claude', 'skills')
    await plantSkill(claudeSkillsDir, 'shared', '# shared\n')

    const agentsParent = path.join(homeDir, '.agents')
    await mkdir(agentsParent, { recursive: true })
    // Symlink the entire skills directory, not just the skill subdirectory,
    // matching the real-world scenario where a harness shares another's root.
    await symlink(claudeSkillsDir, path.join(agentsParent, 'skills'))

    const { getInstalledSkillsPerHarness } = await import('../src/utils/skills-directory.js')
    const skills = await getInstalledSkillsPerHarness()

    const sharedEntries = skills.filter((s) => s.skillId === 'shared')
    // A symlinked alias across harnesses must NOT collapse to one row — the
    // skill is genuinely installed (visible) under both harnesses.
    expect(sharedEntries).toHaveLength(2)
    expect(sharedEntries.map((s) => s.harness).sort()).toEqual(['agents', 'claude-code'])
    // Same underlying file: the memoized parse yields the same contentHash
    // for both rows.
    expect(sharedEntries[0]?.contentHash).toBeTruthy()
    expect(sharedEntries[0]?.contentHash).toBe(sharedEntries[1]?.contentHash)
  })

  it('memoizes SkillParser.parse by realpath — called exactly once across two harnesses sharing a symlinked alias (GH #1912)', async () => {
    const claudeSkillsDir = path.join(homeDir, '.claude', 'skills')
    await plantSkill(claudeSkillsDir, 'shared', '# shared\n')

    const agentsParent = path.join(homeDir, '.agents')
    await mkdir(agentsParent, { recursive: true })
    await symlink(claudeSkillsDir, path.join(agentsParent, 'skills'))

    // `skills-directory.ts` imports SkillParser from `@skillsmith/core` (a
    // plain named import, not behind vi.mock), so spying on the prototype
    // method intercepts every call made through the module under test.
    const { SkillParser } = await import('@skillsmith/core')
    const parseSpy = vi.spyOn(SkillParser.prototype, 'parse')

    const { getInstalledSkillsPerHarness } = await import('../src/utils/skills-directory.js')
    const skills = await getInstalledSkillsPerHarness()

    const sharedEntries = skills.filter((s) => s.skillId === 'shared')
    expect(sharedEntries).toHaveLength(2)

    // getSkillsFromDirectory() parses SKILL.md once per harness scan (before
    // dedup is even possible — each harness's readdir is independent), so
    // claude-code and agents each contribute one parse call there. The
    // memoization under test is the SECOND parse inside readSkillMd(), which
    // must be called only once across the two harnesses sharing a realpath.
    // Net: 2 (per-harness scan) + 1 (memoized readSkillMd) = 3, not 4.
    expect(parseSpy).toHaveBeenCalledTimes(3)

    parseSpy.mockRestore()
  })

  it('symlinked INDIVIDUAL skill directory under a different harness is discovered as its own row (GH #1912 literal repro)', async () => {
    // GH #1912's own repro symlinks a single skill directory, not the whole
    // harness root: `ln -s ~/.claude/skills/foo ~/.cursor/skills/foo`.
    // `getSkillsFromDirectory()` previously only accepted `entry.isDirectory()`
    // dirents, and `withFileTypes` reports a symlinked directory as a symlink
    // (not a directory), so this entry was silently skipped entirely — it
    // never even reached the cross-harness dedup logic under test above.
    const claudeSkillsDir = path.join(homeDir, '.claude', 'skills')
    const { dir: realDir } = await plantSkill(claudeSkillsDir, 'foo', '# foo\n')

    const cursorSkillsDir = path.join(homeDir, '.cursor', 'skills')
    await mkdir(cursorSkillsDir, { recursive: true })
    await symlink(realDir, path.join(cursorSkillsDir, 'foo'), 'dir')

    const { getInstalledSkillsPerHarness } = await import('../src/utils/skills-directory.js')
    const skills = await getInstalledSkillsPerHarness()

    const fooEntries = skills.filter((s) => s.skillId === 'foo')
    expect(fooEntries).toHaveLength(2)
    expect(fooEntries.map((s) => s.harness).sort()).toEqual(['claude-code', 'cursor'])
    expect(fooEntries[0]?.contentHash).toBeTruthy()
    expect(fooEntries[0]?.contentHash).toBe(fooEntries[1]?.contentHash)
  })

  it('multiple aliases to the same realpath WITHIN one harness still collapse to a single row', async () => {
    // Two dirents in the SAME harness's directory ('bar' and 'bar-alias')
    // resolving to the same realpath must still collapse to one row for
    // that harness — only the cross-harness case above should stop
    // collapsing. This dedup only became reachable for the CLI scanner once
    // individual symlinked directories were discovered at all (GH #1912).
    const claudeSkillsDir = path.join(homeDir, '.claude', 'skills')
    const { dir: realDir } = await plantSkill(claudeSkillsDir, 'bar', '# bar\n')
    await symlink(realDir, path.join(claudeSkillsDir, 'bar-alias'), 'dir')

    const { getInstalledSkillsPerHarness } = await import('../src/utils/skills-directory.js')
    const skills = await getInstalledSkillsPerHarness()

    // Only 'bar' and 'bar-alias' exist on disk (both resolving to the same
    // realpath, both under claude-code) — the whole result set must collapse
    // to exactly one row, not two.
    expect(skills).toHaveLength(1)
    expect(skills[0]?.harness).toBe('claude-code')
    expect(skills[0]?.skillId).toBe('bar')
  })

  it("skillId fallback uses EACH harness's own directory name, not one cached from another harness (GH #1912 / SMI-5717)", async () => {
    // No SKILL.md at all, so readSkillMd()'s cached skillId is null and the
    // per-harness dirent-name fallback in getInstalledSkillsPerHarness() is
    // exercised directly — this is the actual bug Correction 1 fixed. Every
    // OTHER cross-harness test in this file uses a `name:` front-matter
    // field with matching dirent names on both ends, so none of them would
    // catch a regression that re-cached the resolved directory-name
    // fallback inside readSkillMd() instead of applying it per-harness.
    const realDir = path.join(homeDir, '.claude', 'skills', 'shared-skill')
    await mkdir(realDir, { recursive: true })

    const cursorSkillsDir = path.join(homeDir, '.cursor', 'skills')
    await mkdir(cursorSkillsDir, { recursive: true })
    await symlink(realDir, path.join(cursorSkillsDir, 'renamed-alias'), 'dir')

    const { getInstalledSkillsPerHarness } = await import('../src/utils/skills-directory.js')
    const skills = await getInstalledSkillsPerHarness()

    const claudeCode = skills.find((s) => s.harness === 'claude-code')
    const cursor = skills.find((s) => s.harness === 'cursor')

    expect(claudeCode?.skillId).toBe('shared-skill')
    expect(cursor?.skillId).toBe('renamed-alias')
    // Neither row leaked the other harness's directory name.
    expect(skills.some((s) => s.harness === 'claude-code' && s.skillId === 'renamed-alias')).toBe(
      false
    )
    expect(skills.some((s) => s.harness === 'cursor' && s.skillId === 'shared-skill')).toBe(false)
  })

  it('contentHash is populated for a skill with a readable SKILL.md', async () => {
    const body = '# my tool\n'
    const { content } = await plantSkill(path.join(homeDir, '.claude', 'skills'), 'my-tool', body)

    const { getInstalledSkillsPerHarness } = await import('../src/utils/skills-directory.js')
    const skills = await getInstalledSkillsPerHarness()

    const entry = skills.find((s) => s.skillId === 'my-tool')
    expect(entry).toBeDefined()

    const expectedHash = createHash('sha256').update(content, 'utf8').digest('hex')
    expect(entry?.contentHash).toBe(expectedHash)
  })

  it('contentHash is null for a skill directory without a SKILL.md', async () => {
    // Directory exists but has no SKILL.md — scanner still includes it.
    const dir = path.join(homeDir, '.claude', 'skills', 'bare-dir')
    await mkdir(dir, { recursive: true })

    const { getInstalledSkillsPerHarness } = await import('../src/utils/skills-directory.js')
    const skills = await getInstalledSkillsPerHarness()

    const entry = skills.find((s) => s.skillId === 'bare-dir')
    expect(entry).toBeDefined()
    expect(entry?.contentHash).toBeNull()
  })

  it('version field reflects the SKILL.md version front-matter', async () => {
    await plantSkill(path.join(homeDir, '.claude', 'skills'), 'versioned', '# v\n')

    const { getInstalledSkillsPerHarness } = await import('../src/utils/skills-directory.js')
    const skills = await getInstalledSkillsPerHarness()

    const entry = skills.find((s) => s.skillId === 'versioned')
    expect(entry?.version).toBe('1.0.0')
  })
})
