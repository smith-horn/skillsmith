/**
 * SMI-4578 Step 4.5: cross-client `getInstalledSkills` tests.
 *
 * Each test runs in a temp `$HOME` so we never touch the real
 * `~/.claude` etc. Validates: union scan across CLIENT_NATIVE_PATHS,
 * realpath dedup for symlinked aliases, `installedVia` propagation,
 * and the local-over-global precedence rule.
 */
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ORIGINAL_HOME = process.env['HOME']
const ORIGINAL_USERPROFILE = process.env['USERPROFILE']

let homeDir: string
let cwdDir: string

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(tmpdir(), 'smi4578-discover-'))
  cwdDir = await mkdtemp(path.join(tmpdir(), 'smi4578-cwd-'))
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

async function plantSkill(
  skillsRoot: string,
  id: string,
  body: string = '# test\n'
): Promise<string> {
  const dir = path.join(skillsRoot, id)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${id}\nversion: 1.0.0\n---\n${body}`,
    'utf-8'
  )
  return dir
}

describe('getInstalledSkills (SMI-4578)', () => {
  it('returns empty when no client directories exist', async () => {
    const { getInstalledSkills } = await import('../src/utils/skills-directory.js')
    const skills = await getInstalledSkills('/nonexistent.db')
    expect(skills).toEqual([])
  })

  it('discovers skills across multiple client directories', async () => {
    await plantSkill(path.join(homeDir, '.claude', 'skills'), 'docker')
    await plantSkill(path.join(homeDir, '.cursor', 'skills'), 'cursor-only')
    await plantSkill(path.join(homeDir, '.codeium', 'windsurf', 'skills'), 'windsurf-only')

    const { getInstalledSkills } = await import('../src/utils/skills-directory.js')
    const skills = await getInstalledSkills('/nonexistent.db')

    const byName = new Map(skills.map((s) => [s.name, s]))
    expect(byName.get('docker')?.installedVia).toBe('claude-code')
    expect(byName.get('cursor-only')?.installedVia).toBe('cursor')
    expect(byName.get('windsurf-only')?.installedVia).toBe('windsurf')
  })

  it('deduplicates symlinked aliases via realpath', async () => {
    // Plant the canonical skill, then symlink the agents directory at it
    const claudeDir = path.join(homeDir, '.claude', 'skills')
    await plantSkill(claudeDir, 'shared')
    const agentsDir = path.join(homeDir, '.agents', 'skills')
    await mkdir(path.dirname(agentsDir), { recursive: true })
    // symlink the entire agents/skills to claude/skills so 'shared' resolves twice
    await symlink(claudeDir, agentsDir)

    const { getInstalledSkills } = await import('../src/utils/skills-directory.js')
    const skills = await getInstalledSkills('/nonexistent.db')
    const sharedHits = skills.filter((s) => s.name === 'shared')
    expect(sharedHits).toHaveLength(1)
    // First win is canonical (precedence: local > claude-code > others)
    expect(sharedHits[0]?.installedVia).toBe('claude-code')
  })

  it('local repo skills take precedence over global', async () => {
    await plantSkill(path.join(homeDir, '.claude', 'skills'), 'override', '# global\n')
    await plantSkill(path.join(cwdDir, '.claude', 'skills'), 'override', '# local\n')

    const { getInstalledSkills } = await import('../src/utils/skills-directory.js')
    const skills = await getInstalledSkills('/nonexistent.db')
    const overrides = skills.filter((s) => s.name === 'override')
    expect(overrides).toHaveLength(1)
    expect(overrides[0]?.installedVia).toBe('local')
  })

  it('canonical takes precedence over secondary clients on collision', async () => {
    await plantSkill(path.join(homeDir, '.claude', 'skills'), 'collide', '# claude\n')
    await plantSkill(path.join(homeDir, '.cursor', 'skills'), 'collide', '# cursor\n')

    const { getInstalledSkills } = await import('../src/utils/skills-directory.js')
    const skills = await getInstalledSkills('/nonexistent.db')
    const winners = skills.filter((s) => s.name === 'collide')
    expect(winners).toHaveLength(1)
    expect(winners[0]?.installedVia).toBe('claude-code')
  })

  it('does not crash and skips dot-prefixed directories like .backups (SMI-5440/SMI-5442)', async () => {
    // Reproduces the .backups/SKILL.md layout created by apply_recommended_edit
    const claudeDir = path.join(homeDir, '.claude', 'skills')
    await plantSkill(claudeDir, 'real-skill')
    // .backups is a dot-prefixed directory. Previously the EISDIR tolerance kept
    // the scan alive but still listed .backups as an unknown skill. The dot-dir
    // skip (SMI-5442) now silences it entirely before the SKILL.md read occurs.
    await mkdir(path.join(claudeDir, '.backups', 'SKILL.md'), { recursive: true })

    const { getInstalledSkills } = await import('../src/utils/skills-directory.js')
    const skills = await getInstalledSkills('/nonexistent.db')

    // Must not throw, and real-skill must be present.
    expect(skills.some((s) => s.name === 'real-skill')).toBe(true)
    // .backups must be absent — it is a harness internal, not a skill.
    expect(skills.some((s) => s.name === '.backups')).toBe(false)
    // No dot-prefixed entry of any kind should surface.
    expect(skills.some((s) => s.name.startsWith('.'))).toBe(false)
  })
})
