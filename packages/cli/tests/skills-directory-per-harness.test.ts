/**
 * SMI-5390: Tests for `getInstalledSkillsPerHarness` — the cross-harness
 * inventory scanner that returns one entry per (harness × skill) with
 * realpath-only deduplication.
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

  it('symlinked alias (same realpath) yields one entry', async () => {
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
    expect(sharedEntries).toHaveLength(1)
    // claude-code is scanned before agents in precedence order so it wins.
    expect(sharedEntries[0]?.harness).toBe('claude-code')
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
