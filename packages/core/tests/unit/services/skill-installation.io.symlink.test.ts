/**
 * @fileoverview writeInstallFiles nested sub-skill path + symlink-safety tests
 * @see SMI-5905 final code review (Sol, GPT-5.6-Sol via NEEDLE) findings #2/#4
 *
 * Split out of skill-installation.io.test.ts (515/500 lines once these tests landed).
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { writeInstallFiles } from '../../../src/services/skill-installation.io.js'

/**
 * SMI-5905 Sol final-code-review findings #2/#4: nested sub-skill filenames (e.g.
 * "scripts/run.sh", used by private-registry content installs) previously had no parent
 * directory created (ENOENT on any clean install) and, once fixed, must not silently write
 * through a pre-existing symlink at an intermediate path component.
 */
describe('writeInstallFiles nested sub-skill paths (SMI-5905 final review #2/#4)', () => {
  it('creates the parent directory for a nested sub-skill filename', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wif-nested-'))
    try {
      const skillsDir = path.join(root, 'skills')
      await fs.mkdir(skillsDir, { recursive: true })
      const installPath = path.join(skillsDir, 'my-skill')

      const result = await writeInstallFiles(
        installPath,
        skillsDir,
        'my-skill',
        '# hello',
        [{ filename: 'scripts/run.sh', content: 'echo hi' }],
        undefined
      )

      expect(await fs.readFile(path.join(installPath, 'scripts', 'run.sh'), 'utf8')).toBe('echo hi')
      expect(result.writtenFiles).toContain(path.join(installPath, 'scripts', 'run.sh'))
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('creates parents for two nested files sharing the same new subdirectory (concurrent-write race)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wif-nested-race-'))
    try {
      const skillsDir = path.join(root, 'skills')
      await fs.mkdir(skillsDir, { recursive: true })
      const installPath = path.join(skillsDir, 'my-skill')

      await writeInstallFiles(
        installPath,
        skillsDir,
        'my-skill',
        '# hello',
        [
          { filename: 'scripts/a.sh', content: 'a' },
          { filename: 'scripts/b.sh', content: 'b' },
        ],
        undefined
      )

      expect(await fs.readFile(path.join(installPath, 'scripts', 'a.sh'), 'utf8')).toBe('a')
      expect(await fs.readFile(path.join(installPath, 'scripts', 'b.sh'), 'utf8')).toBe('b')
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('refuses to write through a pre-existing symlinked intermediate directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wif-symlink-'))
    try {
      const skillsDir = path.join(root, 'skills')
      await fs.mkdir(skillsDir, { recursive: true })
      const installPath = path.join(skillsDir, 'my-skill')
      await fs.mkdir(installPath, { recursive: true })

      // A directory OUTSIDE skillsDir the attack would try to write into.
      const outsideTarget = path.join(root, 'outside-target')
      await fs.mkdir(outsideTarget, { recursive: true })

      // Plant "scripts" as a symlink pointing outside skillsDir, as if left behind by a
      // prior force-reinstall or planted directly by an attacker with local write access.
      await fs.symlink(outsideTarget, path.join(installPath, 'scripts'))

      await expect(
        writeInstallFiles(
          installPath,
          skillsDir,
          'my-skill',
          '# hello',
          [{ filename: 'scripts/run.sh', content: 'malicious' }],
          undefined
        )
      ).rejects.toThrow(/symlink/)

      // Nothing was written to the symlink target.
      await expect(fs.access(path.join(outsideTarget, 'run.sh'))).rejects.toThrow()
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })
})
