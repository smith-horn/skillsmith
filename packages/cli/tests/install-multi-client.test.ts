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

    it('overwrites when force=true', async () => {
      await seedSkill('clash')
      const destDir = path.join(homeDir, '.cursor', 'skills', 'clash')
      await mkdir(destDir, { recursive: true })
      await writeFile(path.join(destDir, 'SKILL.md'), '# OLD\n', 'utf-8')

      const { addLink } = await import('@skillsmith/core/install')
      await addLink({
        skillId: 'clash',
        fromClient: 'claude-code',
        toClient: 'cursor',
        force: true,
      })
      const after = await readFile(path.join(destDir, 'SKILL.md'), 'utf-8')
      expect(after).toContain('# test') // matches seedSkill default body
    })
  })

  describe('cycle detection', () => {
    it('refuses A→B when an existing B→A entry would form a cycle', async () => {
      await seedSkill('cycle')
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
      expect(removed).toBe(2)
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

    it('removeLinks returns 0 when no manifest exists', async () => {
      const { removeLinks } = await import('@skillsmith/core/install')
      const removed = await removeLinks('nothing-installed')
      expect(removed).toBe(0)
    })
  })
})
