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

describe('getLocalSkillsDir / getLocalSkillsDirDisplay (SMI-6060)', () => {
  it('getLocalSkillsDir resolves to an absolute path under the mocked cwd', async () => {
    const { getLocalSkillsDir } = await import('../src/utils/skills-directory.js')
    expect(getLocalSkillsDir()).toBe(path.join(cwdDir, '.claude', 'skills'))
  })

  it('getLocalSkillsDirDisplay returns the relative form, independent of cwd', async () => {
    const { getLocalSkillsDirDisplay } = await import('../src/utils/skills-directory.js')
    expect(getLocalSkillsDirDisplay()).toBe('./.claude/skills')
  })

  it('both derive from the same path segments — cannot silently drift apart', async () => {
    const { getLocalSkillsDir, getLocalSkillsDirDisplay } =
      await import('../src/utils/skills-directory.js')
    const absolute = getLocalSkillsDir()
    const display = getLocalSkillsDirDisplay()
    // Strip the leading './' and confirm it's the tail of the absolute path.
    expect(absolute.endsWith(display.slice(2))).toBe(true)
  })
})

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

  it('ADR-139: a skill installed at both scopes for one client now shows as two rows, workspace first', async () => {
    // Pre-ADR-139, dedup was name-keyed only, so only ONE of these two
    // independent installs survived (the SMI-1630 "local overrides global"
    // rule collapsed the pair down to one row). ADR-139 point 1 makes this
    // a supported, non-conflicting state: both scopes may hold the same
    // skill simultaneously, and `list` must show both — see the ADR's own
    // Negative-consequences note ("a user ... now sees two list rows where
    // they previously saw one. Intentional — it reflects disk state").
    await plantSkill(path.join(homeDir, '.claude', 'skills'), 'override', '# global\n')
    await plantSkill(path.join(cwdDir, '.claude', 'skills'), 'override', '# local\n')

    const { getInstalledSkills } = await import('../src/utils/skills-directory.js')
    const skills = await getInstalledSkills('/nonexistent.db')
    const overrides = skills.filter((s) => s.name === 'override')
    expect(overrides).toHaveLength(2)
    // Local/workspace is still scanned first (SMI-1630 ordering preserved
    // for any caller that just wants "the" answer via array index 0).
    expect(overrides[0]?.installedVia).toBe('local')
    expect(overrides[0]?.scope).toBe('workspace')
    expect(overrides[1]?.installedVia).toBe('claude-code')
    expect(overrides[1]?.scope).toBe('global')
  })

  it('ADR-139: two DIFFERENT clients installing the same-named skill (same scope) now both show, not just canonical', async () => {
    // Pre-ADR-139, dedup was name-keyed only, so the cursor install was
    // silently dropped in favor of claude-code's. Extending the dedup key
    // to the full (scope, client, name) triple (ADR-139 point 1, the
    // SMI-5894 (client, name) keying precedent extended to scope) means a
    // same-named skill independently installed under two different
    // clients is no longer collapsed either — each is genuinely distinct
    // disk state, exactly like getInstalledSkillsPerHarness() already
    // treats it (SMI-5390's own docstring: "does not deduplicate by skill
    // name").
    await plantSkill(path.join(homeDir, '.claude', 'skills'), 'collide', '# claude\n')
    await plantSkill(path.join(homeDir, '.cursor', 'skills'), 'collide', '# cursor\n')

    const { getInstalledSkills } = await import('../src/utils/skills-directory.js')
    const skills = await getInstalledSkills('/nonexistent.db')
    const winners = skills.filter((s) => s.name === 'collide')
    expect(winners).toHaveLength(2)
    expect(winners.map((w) => w.installedVia).sort()).toEqual(['claude-code', 'cursor'])
    expect(winners.every((w) => w.scope === 'global')).toBe(true)
  })

  it("ADR-139 test 18: list from workspace A does not report workspace B's installs", async () => {
    // cwdDir (the mocked cwd) IS workspace A — give it its own .git root so
    // the cursor workspace scan resolves against it.
    await mkdir(path.join(cwdDir, '.git'), { recursive: true })
    await plantSkill(path.join(cwdDir, '.cursor', 'skills'), 'workspace-a-skill')

    // Workspace B is a wholly separate repo the current invocation never
    // stands inside — its own workspace-scoped install must never surface
    // in workspace A's `list`. ADR-139 point 1: "It never scans for,
    // discovers, or aggregates workspace manifests elsewhere on the
    // machine ... a workspace is only ever reachable by standing in it."
    const workspaceB = await mkdtemp(path.join(tmpdir(), 'smi4578-workspace-b-'))
    try {
      await mkdir(path.join(workspaceB, '.git'), { recursive: true })
      await plantSkill(path.join(workspaceB, '.cursor', 'skills'), 'workspace-b-skill')

      const { getInstalledSkills } = await import('../src/utils/skills-directory.js')
      const skills = await getInstalledSkills('/nonexistent.db')

      expect(skills.some((s) => s.name === 'workspace-a-skill')).toBe(true)
      expect(skills.some((s) => s.name === 'workspace-b-skill')).toBe(false)
    } finally {
      await rm(workspaceB, { recursive: true, force: true })
    }
  })

  it('ADR-139 (SMI-6274 Wave 4, required test 17): list marks a skill on disk with no manifest entry as untracked, and a manifest-backed skill as tracked', async () => {
    // Two global claude-code skills: one has a manifest entry (tracked),
    // one has none at all (untracked) — the exact "workspace manifest
    // deleted" recovery scenario ADR-139 point 1 describes, at the GLOBAL
    // scope (test 17's core `performUninstall` coverage already exercises
    // the workspace-manifest-deleted case; this proves `list` itself
    // surfaces the marker end-to-end via the real disk-scan + manifest
    // cross-reference path, not just performUninstall's isolated adoption).
    await plantSkill(path.join(homeDir, '.claude', 'skills'), 'tracked-skill')
    await plantSkill(path.join(homeDir, '.claude', 'skills'), 'untracked-skill')

    await mkdir(path.join(homeDir, '.skillsmith'), { recursive: true })
    await writeFile(
      path.join(homeDir, '.skillsmith', 'manifest.json'),
      JSON.stringify({
        version: '1.0.0',
        installedSkills: {
          // Canonical (claude-code) client keeps the bare-name key
          // (manifestKeyFor's own documented backward-compat rule).
          'tracked-skill': {
            id: 'someone/tracked-skill',
            name: 'tracked-skill',
            version: '1.0.0',
            source: 'github:someone/tracked-skill',
            installPath: path.join(homeDir, '.claude', 'skills', 'tracked-skill'),
            installedAt: '2026-01-01T00:00:00Z',
            lastUpdated: '2026-01-01T00:00:00Z',
          },
        },
      }),
      'utf-8'
    )

    const { getInstalledSkills } = await import('../src/utils/skills-directory.js')
    const skills = await getInstalledSkills('/nonexistent.db')

    const tracked = skills.find((s) => s.name === 'tracked-skill')
    const untracked = skills.find((s) => s.name === 'untracked-skill')
    expect(tracked?.untracked).toBe(false)
    expect(untracked?.untracked).toBe(true)
  })

  it('ADR-139 (SMI-6274 Wave 4): displaySkillsTable marks an untracked skill with an [untracked] suffix', async () => {
    // Short name: the Name column has a fixed 30-char colWidth (cli-table3),
    // so a long name + ' [untracked]' would be silently truncated to
    // '[un…' — irrelevant to what this test actually verifies (that the
    // marker is appended at all).
    await plantSkill(path.join(homeDir, '.claude', 'skills'), 'utrk')

    const { getInstalledSkills } = await import('../src/utils/skills-directory.js')
    const { displaySkillsTable } = await import('../src/commands/manage.js')
    const skills = await getInstalledSkills('/nonexistent.db')
    const skill = skills.find((s) => s.name === 'utrk')
    expect(skill?.untracked).toBe(true)

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    displaySkillsTable(skill ? [skill] : [])
    const allOutput = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(allOutput).toContain('[untracked]')
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
