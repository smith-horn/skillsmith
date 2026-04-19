/**
 * LocalFilesystemAdapter coverage sidecar (SMI-4287)
 *
 * Split out of `LocalFilesystemAdapter.test.ts` so that file stays under the
 * 500-line pre-commit ceiling (see memory feedback:
 * "File-length enforcement asymmetry" — pre-commit does NOT exempt
 * `.test.ts` even though `audit:standards` does). Covers symlink
 * containment, permission handling, loop detection, case-insensitive
 * normalisation, and frontmatter-tolerance cases introduced by SMI-4287
 * (GitHub #600, #596).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LocalFilesystemAdapter } from '../src/sources/LocalFilesystemAdapter.js'
import { promises as fs, constants as fsConstants } from 'fs'
import { join } from 'path'
import { tmpdir, platform } from 'os'

describe('LocalFilesystemAdapter SMI-4287 coverage', () => {
  let adapter: LocalFilesystemAdapter
  let testDir: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `skillsmith-4287-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(testDir, { recursive: true })

    await fs.mkdir(join(testDir, 'skill-one'), { recursive: true })
    await fs.writeFile(
      join(testDir, 'skill-one', 'SKILL.md'),
      '---\nname: Skill One\ndescription: First skill\n---\n# Skill One'
    )

    await fs.mkdir(join(testDir, 'skill-two'), { recursive: true })
    await fs.writeFile(
      join(testDir, 'skill-two', 'SKILL.md'),
      '---\nname: Skill Two\n---\n# Skill Two'
    )

    adapter = new LocalFilesystemAdapter({
      id: 'test-local',
      name: 'Test Local',
      type: 'local',
      baseUrl: 'file://',
      enabled: true,
      rootDir: testDir,
      rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
    })

    await adapter.initialize()
  })

  afterEach(async () => {
    // Restore any chmod'd directories so rm can clean up.
    for (const name of ['locked-dir', 'locked-skill']) {
      const p = join(testDir, name)
      try {
        await fs.chmod(p, 0o755)
      } catch {
        // ignore
      }
    }
    try {
      await fs.rm(testDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('Symlink containment', () => {
    it('should follow symlinks that stay inside rootDir when enabled', async () => {
      // Target is a directory _inside_ rootDir, so containment passes without
      // `allowSymlinksOutsideRoot`. SMI-4319 updates the semantics: a symlink
      // whose target realpath is already visited is treated as a loop (the
      // alias does NOT double-surface the same SKILL.md). The scan still
      // succeeds and the original skills are reported.
      const target = join(testDir, 'skill-two')
      const link = join(testDir, 'alias-of-skill-two')
      try {
        await fs.symlink(target, link)
      } catch {
        return
      }

      const followAdapter = new LocalFilesystemAdapter({
        id: 'test-follow-internal',
        name: 'Test Follow Internal',
        type: 'local',
        baseUrl: 'file://',
        enabled: true,
        rootDir: testDir,
        followSymlinks: true,
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })

      await followAdapter.initialize()
      // Post-SMI-4319: aliased directory is de-duplicated via the
      // visited-realpath set. Only the two canonical skill dirs surface.
      expect(followAdapter.skillCount).toBe(2)
      const result = await followAdapter.search({})
      // The alias traversal emits a `loop` warning (already-visited realpath).
      // Non-loop warning categories must still be empty.
      const nonLoop = (result.warnings ?? []).filter((w) => w.code !== 'loop')
      expect(nonLoop).toEqual([])
    })

    it('should reject symlinks escaping rootDir with a symlink-escape warning', async () => {
      const externalDir = join(tmpdir(), `external-escape-${Date.now()}`)
      await fs.mkdir(externalDir, { recursive: true })
      await fs.writeFile(join(externalDir, 'SKILL.md'), '# Should not index')

      try {
        await fs.symlink(externalDir, join(testDir, 'escape-link'))
      } catch {
        return
      }

      const escapeAdapter = new LocalFilesystemAdapter({
        id: 'test-escape',
        name: 'Test Escape',
        type: 'local',
        baseUrl: 'file://',
        enabled: true,
        rootDir: testDir,
        followSymlinks: true,
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })

      await escapeAdapter.initialize()
      // Escaping symlink must NOT be followed.
      expect(escapeAdapter.skillCount).toBe(2)

      const result = await escapeAdapter.search({})
      const escapeWarnings = (result.warnings ?? []).filter((w) => w.code === 'symlink-escape')
      expect(escapeWarnings.length).toBeGreaterThan(0)
      expect(escapeWarnings[0].path).toContain('escape-link')

      await fs.rm(externalDir, { recursive: true, force: true })
    })

    it('should permit escaping symlinks when allowSymlinksOutsideRoot is true', async () => {
      const externalDir = join(tmpdir(), `external-allow-${Date.now()}`)
      await fs.mkdir(externalDir, { recursive: true })
      await fs.writeFile(join(externalDir, 'SKILL.md'), '# Permitted external')

      try {
        await fs.symlink(externalDir, join(testDir, 'allowed-link'))
      } catch {
        return
      }

      const allowAdapter = new LocalFilesystemAdapter({
        id: 'test-allow',
        name: 'Test Allow',
        type: 'local',
        baseUrl: 'file://',
        enabled: true,
        rootDir: testDir,
        followSymlinks: true,
        allowSymlinksOutsideRoot: true,
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })

      await allowAdapter.initialize()
      expect(allowAdapter.skillCount).toBe(3)

      await fs.rm(externalDir, { recursive: true, force: true })
    })
  })

  describe('Circular symlinks', () => {
    it('should emit loop warning for circular symlinks', async () => {
      const a = join(testDir, 'loop-a')
      const b = join(testDir, 'loop-b')
      try {
        await fs.symlink(b, a)
        await fs.symlink(a, b)
      } catch {
        return
      }

      const loopAdapter = new LocalFilesystemAdapter({
        id: 'test-loop',
        name: 'Test Loop',
        type: 'local',
        baseUrl: 'file://',
        enabled: true,
        rootDir: testDir,
        followSymlinks: true,
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })

      await loopAdapter.initialize()
      const result = await loopAdapter.search({})
      const loopWarnings = (result.warnings ?? []).filter((w) => w.code === 'loop')
      expect(loopWarnings.length).toBeGreaterThan(0)
      // Scan must still report the non-symlinked skills.
      expect(loopAdapter.skillCount).toBe(2)
    })
  })

  describe('Permission handling', () => {
    it('should surface EACCES as a permission warning and continue scanning', async () => {
      if (platform() === 'win32') return
      const locked = join(testDir, 'locked-dir')
      await fs.mkdir(locked, { recursive: true })
      await fs.writeFile(join(locked, 'SKILL.md'), '# Locked skill')
      await fs.chmod(locked, 0o000)

      // Skip if root (chmod bypassed).
      let canRead = false
      try {
        await fs.readdir(locked)
        canRead = true
      } catch {
        canRead = false
      }

      try {
        const permAdapter = new LocalFilesystemAdapter({
          id: 'test-perm',
          name: 'Test Perm',
          type: 'local',
          baseUrl: 'file://',
          enabled: true,
          rootDir: testDir,
          rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
        })

        await permAdapter.initialize()
        const result = await permAdapter.search({})

        if (canRead) {
          // Running as root or elevated — skip assertion path.
          return
        }

        expect(permAdapter.skillCount).toBe(2)
        const permWarnings = (result.warnings ?? []).filter((w) => w.code === 'permission')
        expect(permWarnings.length).toBeGreaterThan(0)
        expect(permWarnings[0].path).toContain('locked-dir')
      } finally {
        await fs.chmod(locked, 0o755).catch(() => undefined)
      }
    })

    it('should surface typed message for chmod 000 root in checkHealth', async () => {
      if (platform() === 'win32') return
      const lockedRoot = join(testDir, 'locked-root')
      await fs.mkdir(lockedRoot, { recursive: true })
      await fs.chmod(lockedRoot, 0o000)
      try {
        const lockedAdapter = new LocalFilesystemAdapter({
          id: 'locked',
          name: 'Locked',
          type: 'local',
          baseUrl: 'file://',
          enabled: true,
          rootDir: join(lockedRoot, 'inner'),
          rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
        })
        const health = await lockedAdapter.checkHealth()
        expect(health.healthy).toBe(false)
        expect(health.error).toBeTruthy()
      } finally {
        await fs.chmod(lockedRoot, 0o755).catch(() => undefined)
      }
    })

    it('should surface typed error for chmod 000 SKILL.md via fetchSkillContent', async () => {
      if (platform() === 'win32') return
      const lockedDir = join(testDir, 'locked-skill')
      await fs.mkdir(lockedDir, { recursive: true })
      const skillPath = join(lockedDir, 'SKILL.md')
      await fs.writeFile(skillPath, '# Locked')
      await fs.chmod(skillPath, 0o000)
      try {
        // Skip if running as root — chmod 000 is bypassed by root.
        let canRead = false
        try {
          await fs.access(skillPath, fsConstants.R_OK)
          canRead = true
        } catch {
          canRead = false
        }
        if (canRead) return

        await expect(adapter.fetchSkillContent({ path: skillPath })).rejects.toThrow(
          /Failed to read skill file|Cannot read/
        )
      } finally {
        await fs.chmod(skillPath, 0o644).catch(() => undefined)
      }
    })

    it('should surface typed error for nonexistent path via getRepository', async () => {
      if (platform() === 'win32') return
      const nonexistent = join(testDir, 'never-created')
      await expect(adapter.getRepository({ path: nonexistent })).rejects.toThrow(
        /Skill not found|Not found/
      )
    })
  })

  describe('Frontmatter regressions', () => {
    it('should not fail on malformed frontmatter', async () => {
      await fs.mkdir(join(testDir, 'bad-yaml'), { recursive: true })
      await fs.writeFile(
        join(testDir, 'bad-yaml', 'SKILL.md'),
        '---\nname: oops\n  broken: [\n---\n# Broken'
      )
      const count = await adapter.rescan()
      expect(count).toBe(3)
    })
  })

  describe('Case-insensitive filesystem normalisation', () => {
    it('should accept symlink targets that differ only in case on macOS/Windows', async () => {
      // Only exercise on case-insensitive filesystems; Linux ext4 would
      // genuinely treat these as distinct paths.
      if (platform() !== 'darwin' && platform() !== 'win32') return

      const target = join(testDir, 'skill-one')
      const link = join(testDir, 'case-alias')
      try {
        // Build a target string with different casing than the actual dir.
        // macOS APFS reports realpath with the original casing, so the
        // containment check must normalise.
        await fs.symlink(target.toUpperCase(), link)
      } catch {
        return
      }

      const caseAdapter = new LocalFilesystemAdapter({
        id: 'test-case',
        name: 'Test Case',
        type: 'local',
        baseUrl: 'file://',
        enabled: true,
        rootDir: testDir,
        followSymlinks: true,
        rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
      })

      // Should not error; target is inside rootDir regardless of casing.
      await expect(caseAdapter.initialize()).resolves.not.toThrow()
    })
  })
})
