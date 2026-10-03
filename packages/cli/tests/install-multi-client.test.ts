/**
 * SMI-4578 Step 6: install --client / --also-link end-to-end tests.
 *
 * Exercises the parseAlsoLink + assertClientId validation surface in
 * install.ts plus the addLink fan-out behaviour from
 * @skillsmith/core/install. Each test runs in a temp $HOME so we
 * never touch the real filesystem.
 *
 * Skill installation itself (the SkillInstallationService.install
 * call) is NOT exercised here — that's covered by install.test.ts,
 * service unit tests, and the post-merge smoke. These tests focus on
 * the multi-client surface: target-directory resolution, fan-out
 * manifest writes, conflict refuse, cycle refuse.
 */
import { mkdtemp, mkdir, readFile, rm, stat, lstat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Regression-test-only mocks for the `install` command's --also-link path.
// SkillInstallationService.install is a network+DB call we don't want to
// exercise for real here; @skillsmith/core/install (addLink, getInstallPath)
// stays real so the fan-out itself runs against the temp $HOME below.
const alsoLinkMocks = vi.hoisted(() => ({
  installFn: vi.fn(),
}))

vi.mock('@skillsmith/core', () => ({
  createDatabaseAsync: vi.fn().mockResolvedValue({ close: vi.fn() }),
  initializeSchema: vi.fn(),
  SkillRepository: vi.fn().mockImplementation(function () {
    return { findById: vi.fn(() => null) }
  }),
  SkillDependencyRepository: vi.fn().mockImplementation(function () {
    return { clearAll: vi.fn() }
  }),
  SkillInstallationService: vi.fn().mockImplementation(function () {
    return { install: alsoLinkMocks.installFn }
  }),
  QuarantineRepository: vi.fn().mockImplementation(function () {
    return { isQuarantined: vi.fn(() => false) }
  }),
  SkillsmithApiClient: Object.assign(vi.fn(), {
    toSkill: (r: { trust_tier?: string }) => ({ trustTier: r.trust_tier ?? 'community' }),
  }),
  loadStoredAccessToken: vi.fn().mockResolvedValue(null),
  createApiClient: vi.fn(() => ({ isOffline: () => true, getSkill: vi.fn() })),
  isGitHubUrl: vi.fn((url: string) => url.startsWith('https://github.com/')),
  emitInstallEvent: vi.fn(async () => undefined),
  // SMI-5893 (Wave 7 Step 4): install.ts's `opts.quiet ?? isQuietModeEnabled()`
  // fallback calls this whenever --quiet/-q isn't passed (every test in this
  // file) — a real, deterministic (env-unset by default) implementation
  // keeps that fallback from throwing under this full-replacement mock.
  isQuietModeEnabled: vi.fn(() => process.env['SKILLSMITH_QUIET'] === 'true'),
}))

const ORIGINAL_HOME = process.env['HOME']
const ORIGINAL_USERPROFILE = process.env['USERPROFILE']
const ORIGINAL_CLIENT = process.env['SKILLSMITH_CLIENT']

let homeDir: string

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(tmpdir(), 'smi4578-multi-'))
  process.env['HOME'] = homeDir
  process.env['USERPROFILE'] = homeDir
  delete process.env['SKILLSMITH_CLIENT']
  // CLIENT_NATIVE_PATHS computes homedir() at module import time —
  // reset modules so each test sees its own $HOME.
  vi.resetModules()
})

afterEach(async () => {
  if (ORIGINAL_HOME === undefined) delete process.env['HOME']
  else process.env['HOME'] = ORIGINAL_HOME
  if (ORIGINAL_USERPROFILE === undefined) delete process.env['USERPROFILE']
  else process.env['USERPROFILE'] = ORIGINAL_USERPROFILE
  if (ORIGINAL_CLIENT === undefined) delete process.env['SKILLSMITH_CLIENT']
  else process.env['SKILLSMITH_CLIENT'] = ORIGINAL_CLIENT
  await rm(homeDir, { recursive: true, force: true })
})

async function seedSkill(skillId: string, body: string = '# test\n'): Promise<string> {
  const dir = path.join(homeDir, '.claude', 'skills', skillId)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${skillId}\n---\n${body}`, 'utf-8')
  return dir
}

describe('install --client / --also-link', () => {
  describe('--client target directory', () => {
    it('getInstallPath returns the cursor directory for --client cursor', async () => {
      const { getInstallPath } = await import('@skillsmith/core/install')
      expect(getInstallPath('cursor')).toBe(path.join(homeDir, '.cursor', 'skills'))
    })

    it('SKILLSMITH_CLIENT env var routes resolveClientPath', async () => {
      process.env['SKILLSMITH_CLIENT'] = 'windsurf'
      const { resolveClientPath } = await import('@skillsmith/core/install')
      expect(resolveClientPath()).toBe(path.join(homeDir, '.codeium', 'windsurf', 'skills'))
    })

    it('explicit override beats env var', async () => {
      process.env['SKILLSMITH_CLIENT'] = 'cursor'
      const { resolveClientPath } = await import('@skillsmith/core/install')
      expect(resolveClientPath('agents')).toBe(path.join(homeDir, '.agents', 'skills'))
    })

    it('rejects invalid SKILLSMITH_CLIENT with a friendly hint', async () => {
      process.env['SKILLSMITH_CLIENT'] = 'codex'
      const { resolveClientPath } = await import('@skillsmith/core/install')
      expect(() => resolveClientPath()).toThrow(/--client agents/)
    })
  })

  describe('--also-link copy default', () => {
    it('copies the source skill into a secondary client directory', async () => {
      await seedSkill('foo', '# foo\n')
      const { addLink, listLinks } = await import('@skillsmith/core/install')

      const result = await addLink({
        skillId: 'foo',
        fromClient: 'claude-code',
        toClient: 'cursor',
      })

      expect(result.record.kind).toBe('copy')
      const dest = path.join(homeDir, '.cursor', 'skills', 'foo')
      const skillMd = await readFile(path.join(dest, 'SKILL.md'), 'utf-8')
      expect(skillMd).toContain('# foo')

      const links = await listLinks('foo')
      expect(links).toHaveLength(1)
      expect(links[0]?.kind).toBe('copy')
      expect(links[0]?.to).toBe(dest)
    })

    it('writes a manifest entry per fan-out target', async () => {
      await seedSkill('multi')
      const { addLink, getLinkManifestPath, loadManifest } =
        await import('@skillsmith/core/install')

      await addLink({ skillId: 'multi', fromClient: 'claude-code', toClient: 'cursor' })
      await addLink({ skillId: 'multi', fromClient: 'claude-code', toClient: 'agents' })

      const manifest = await loadManifest()
      expect(manifest.links.filter((l) => l.skillId === 'multi')).toHaveLength(2)
      expect(manifest.version).toBe(1)

      // manifest path is under ~/.skillsmith/links/manifest.json
      const manifestPath = getLinkManifestPath()
      expect(manifestPath).toBe(path.join(homeDir, '.skillsmith', 'links', 'manifest.json'))
      await expect(stat(manifestPath)).resolves.toBeDefined()
    })
  })

  describe('--also-link --symlink (POSIX opt-in)', () => {
    it('creates a relative symlink instead of a copy', async () => {
      await seedSkill('linkme')
      const { addLink } = await import('@skillsmith/core/install')

      const result = await addLink({
        skillId: 'linkme',
        fromClient: 'claude-code',
        toClient: 'windsurf',
        preferSymlink: true,
      })

      expect(result.record.kind).toBe('symlink')
      const dest = path.join(homeDir, '.codeium', 'windsurf', 'skills', 'linkme')
      const linkStat = await lstat(dest)
      expect(linkStat.isSymbolicLink()).toBe(true)
    })
  })

  describe('conflict policy', () => {
    it('refuses to overwrite a pre-existing destination without force', async () => {
      await seedSkill('clash')
      // Pre-create destination with different content
      const destDir = path.join(homeDir, '.cursor', 'skills', 'clash')
      await mkdir(destDir, { recursive: true })
      await writeFile(path.join(destDir, 'SKILL.md'), '# DIFFERENT\n', 'utf-8')

      const { addLink } = await import('@skillsmith/core/install')
      await expect(
        addLink({ skillId: 'clash', fromClient: 'claude-code', toClient: 'cursor' })
      ).rejects.toThrow(/already exists/)

      // Destination contents unchanged
      const after = await readFile(path.join(destDir, 'SKILL.md'), 'utf-8')
      expect(after).toBe('# DIFFERENT\n')
    })

    // SMI-6529 H3 (round 2): `force` no longer recursively deletes a
    // pre-existing REAL directory at the fan-out destination — only a
    // symlink Skillsmith itself created is safe to clear. A real directory
    // (even one with no special content, as here) is refused with a clear
    // error naming the path, and its content is left completely untouched.
    it('refuses to force-overwrite a pre-existing REAL directory — never recursively deletes it', async () => {
      await seedSkill('clash')
      const destDir = path.join(homeDir, '.cursor', 'skills', 'clash')
      await mkdir(destDir, { recursive: true })
      await writeFile(path.join(destDir, 'SKILL.md'), '# OLD\n', 'utf-8')

      const { addLink } = await import('@skillsmith/core/install')
      await expect(
        addLink({
          skillId: 'clash',
          fromClient: 'claude-code',
          toClient: 'cursor',
          force: true,
        })
      ).rejects.toThrow(/not a fan-out destination Skillsmith recorded/)
      const after = await readFile(path.join(destDir, 'SKILL.md'), 'utf-8')
      expect(after).toBe('# OLD\n')
    })
  })

  describe('cycle detection', () => {
    it('refuses A→B when an existing B→A entry would form a cycle', async () => {
      // SMI-6529 H3 (round 2): seed ONLY the agents-side source, not the
      // canonical claude-code location — the forward hop below no longer
      // needs `force` to overwrite anything (claude-code's own `cycle`
      // doesn't exist yet), and `detectCycle()` fires before the reverse
      // hop ever considers overwriting agents' own pre-existing directory.
      const agentsDir = path.join(homeDir, '.agents', 'skills', 'cycle')
      await mkdir(agentsDir, { recursive: true })
      await writeFile(path.join(agentsDir, 'SKILL.md'), '# cycle\n', 'utf-8')

      const { addLink } = await import('@skillsmith/core/install')
      // Forward: agents → claude-code
      await addLink({
        skillId: 'cycle',
        fromClient: 'agents',
        toClient: 'claude-code',
        force: true,
      })
      // Reverse: claude-code → agents — should refuse
      await expect(
        addLink({
          skillId: 'cycle',
          fromClient: 'claude-code',
          toClient: 'agents',
          force: true,
        })
      ).rejects.toThrow(/cycle detected/)
    })
  })

  describe('uninstall fan-out cleanup', () => {
    it('removeLinks tears down both copies and symlinks', async () => {
      await seedSkill('teardown')
      const { addLink, removeLinks, listLinks } = await import('@skillsmith/core/install')

      await addLink({ skillId: 'teardown', fromClient: 'claude-code', toClient: 'cursor' })
      await addLink({
        skillId: 'teardown',
        fromClient: 'claude-code',
        toClient: 'windsurf',
        preferSymlink: true,
      })

      const removed = await removeLinks('teardown')
      expect(removed).toEqual({ removed: 2, refused: [] })
      expect(await listLinks('teardown')).toEqual([])

      // Both destinations gone
      await expect(stat(path.join(homeDir, '.cursor', 'skills', 'teardown'))).rejects.toThrow(
        /ENOENT/
      )
      await expect(
        lstat(path.join(homeDir, '.codeium', 'windsurf', 'skills', 'teardown'))
      ).rejects.toThrow(/ENOENT/)

      // Source untouched
      await expect(stat(path.join(homeDir, '.claude', 'skills', 'teardown'))).resolves.toBeDefined()
    })

    it('removeLinks reports nothing removed when no manifest exists', async () => {
      const { removeLinks } = await import('@skillsmith/core/install')
      const removed = await removeLinks('nothing-installed')
      expect(removed).toEqual({ removed: 0, refused: [] })
    })
  })

  describe('install command --also-link with an owner/repo skillId', () => {
    beforeEach(() => {
      alsoLinkMocks.installFn.mockReset()
    })

    it('fans out using the resolved directory name, not the raw owner/repo skillId', async () => {
      // Real installs key the manifest/directory by the resolved skill name
      // (e.g. "commit"), which can differ from the owner/repo argument the
      // user typed (e.g. "getsentry/commit"). Seed the source dir the way
      // SkillInstallationService really lays it out.
      const installPath = await seedSkill('commit', '# commit skill\n')
      alsoLinkMocks.installFn.mockResolvedValue({
        success: true,
        skillId: 'getsentry/commit',
        installPath,
        trustTier: 'verified',
      })

      const { createInstallCommand } = await import('../src/commands/install.js')
      const cmd = createInstallCommand()
      await cmd.parseAsync([
        'node',
        'test',
        'getsentry/commit',
        '--client',
        'claude-code',
        '--also-link',
        'agents',
      ])

      const dest = path.join(homeDir, '.agents', 'skills', 'commit')
      const skillMd = await readFile(path.join(dest, 'SKILL.md'), 'utf-8')
      expect(skillMd).toContain('# commit skill')

      // The buggy path constructed .../.agents/skills/getsentry/commit instead.
      await expect(stat(path.join(homeDir, '.agents', 'skills', 'getsentry'))).rejects.toThrow(
        /ENOENT/
      )
    })
  })

  describe('interrupted-refresh leftover backup warning (SMI-6529)', () => {
    beforeEach(() => {
      alsoLinkMocks.installFn.mockReset()
    })

    it('prints the fan-out leftover-backup warning in human output but omits it from --json stdout', async () => {
      const installPath = await seedSkill('leftover', '# leftover skill\n')
      alsoLinkMocks.installFn.mockResolvedValue({
        success: true,
        skillId: 'author/leftover',
        installPath,
        trustTier: 'verified',
      })

      const { saveManifest } = await import('@skillsmith/core/install')
      const destDir = path.join(homeDir, '.cursor', 'skills', 'leftover')
      await mkdir(destDir, { recursive: true })
      await writeFile(path.join(destDir, 'SKILL.md'), '# stale copy\n', 'utf-8')

      // Recorded as a fan-out copy already so a --force overwrite is
      // allowed (assertOverwritable in fan-out.overwrite.ts).
      await saveManifest({
        version: 1,
        links: [
          {
            skillId: 'leftover',
            from: path.join(homeDir, '.claude', 'skills', 'leftover'),
            to: destDir,
            kind: 'copy',
            createdAt: new Date().toISOString(),
          },
        ],
      })

      // A hidden backup folder left behind by an earlier interrupted
      // refresh, sitting next to the fan-out destination. recoverDestination
      // only restores such a folder when the destination is MISSING, so
      // seeding it while destDir already exists (above) keeps it in place
      // as a superseded copy for listLeftoverBackups() to report.
      const backupDir = path.join(
        homeDir,
        '.cursor',
        'skills',
        '.leftover.skillsmith-backup-AbC123'
      )
      await mkdir(path.join(backupDir, 'original'), { recursive: true })
      await writeFile(path.join(backupDir, 'original', 'SKILL.md'), '# orphaned\n', 'utf-8')

      const originalConsoleWarn = console.warn
      const originalConsoleLog = console.log
      const mockConsoleWarn = vi.fn()
      const mockConsoleLog = vi.fn()
      console.warn = mockConsoleWarn
      console.log = mockConsoleLog

      try {
        const { createInstallCommand } = await import('../src/commands/install.js')

        // Human-mode run: the warning must reach console output.
        const cmdHuman = createInstallCommand()
        await cmdHuman.parseAsync([
          'node',
          'test',
          'author/leftover',
          '--client',
          'claude-code',
          '--also-link',
          'cursor',
          '--force',
        ])

        const humanWarnText = mockConsoleWarn.mock.calls.map((args) => String(args[0])).join('\n')
        expect(humanWarnText).toContain('an interrupted refresh')

        // JSON-mode run: the same leftover backup is still sitting there
        // (neither recoverDestination nor the swap ever deletes it), but the
        // CLI must not print the warning anywhere in --json mode.
        mockConsoleWarn.mockClear()
        mockConsoleLog.mockClear()
        const cmdJson = createInstallCommand()
        await cmdJson.parseAsync([
          'node',
          'test',
          'author/leftover',
          '--client',
          'claude-code',
          '--also-link',
          'cursor',
          '--force',
          '--json',
        ])

        expect(mockConsoleWarn).not.toHaveBeenCalled()
        const jsonStdout = mockConsoleLog.mock.calls.map((args) => String(args[0])).join('\n')
        expect(jsonStdout).not.toContain('an interrupted refresh')
      } finally {
        console.warn = originalConsoleWarn
        console.log = originalConsoleLog
      }

      // The leftover backup itself is left alone -- only ever reported,
      // never deleted by addLink's own swap logic.
      await expect(stat(path.join(backupDir, 'original', 'SKILL.md'))).resolves.toBeDefined()
    })
  })
})
