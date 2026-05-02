/**
 * SMI-4578: fan-out.ts unit tests.
 *
 * Tests use a per-test temp directory as $HOME so the manifest and the
 * per-client `~/.cursor/skills/` etc. live in an isolated tree, never
 * touching the real filesystem.
 */
import { mkdtemp, mkdir, readFile, rm, stat, lstat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ORIGINAL_HOME = process.env['HOME']
const ORIGINAL_USERPROFILE = process.env['USERPROFILE']

let homeDir: string

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(tmpdir(), 'smi4578-fanout-'))
  process.env['HOME'] = homeDir
  process.env['USERPROFILE'] = homeDir
  vi.resetModules()
})

afterEach(async () => {
  if (ORIGINAL_HOME === undefined) delete process.env['HOME']
  else process.env['HOME'] = ORIGINAL_HOME
  if (ORIGINAL_USERPROFILE === undefined) delete process.env['USERPROFILE']
  else process.env['USERPROFILE'] = ORIGINAL_USERPROFILE
  await rm(homeDir, { recursive: true, force: true })
})

async function loadModule() {
  return await import('../../src/install/fan-out.js')
}

async function seedSkill(skillId: string, files: Record<string, string> = {}) {
  const skillDir = path.join(homeDir, '.claude', 'skills', skillId)
  await mkdir(skillDir, { recursive: true })
  await writeFile(path.join(skillDir, 'SKILL.md'), files['SKILL.md'] ?? '# test\n', 'utf-8')
  for (const [name, content] of Object.entries(files)) {
    if (name === 'SKILL.md') continue
    const fp = path.join(skillDir, name)
    await mkdir(path.dirname(fp), { recursive: true })
    await writeFile(fp, content, 'utf-8')
  }
  return skillDir
}

describe('install/fan-out', () => {
  describe('getLinkManifestPath', () => {
    it('returns ~/.skillsmith/links/manifest.json', async () => {
      const { getLinkManifestPath } = await loadModule()
      expect(getLinkManifestPath()).toBe(
        path.join(homeDir, '.skillsmith', 'links', 'manifest.json')
      )
    })
  })

  describe('loadManifest', () => {
    it('returns empty manifest when file missing', async () => {
      const { loadManifest } = await loadModule()
      const m = await loadManifest()
      expect(m).toEqual({ version: 1, links: [] })
    })

    it('returns empty manifest when file is malformed', async () => {
      const { loadManifest, getLinkManifestPath } = await loadModule()
      await mkdir(path.dirname(getLinkManifestPath()), { recursive: true })
      await writeFile(getLinkManifestPath(), 'not json', 'utf-8')
      const m = await loadManifest()
      expect(m.links).toEqual([])
    })
  })

  describe('addLink (copy default)', () => {
    it('copies the source skill into the destination client directory', async () => {
      const { addLink, listLinks } = await loadModule()
      await seedSkill('foo', { 'SKILL.md': '# foo\n', 'helpers/util.ts': 'export {}\n' })
      const result = await addLink({
        skillId: 'foo',
        fromClient: 'claude-code',
        toClient: 'cursor',
      })

      expect(result.record.kind).toBe('copy')
      expect(result.fellBackToCopy).toBe(false)

      const dest = path.join(homeDir, '.cursor', 'skills', 'foo')
      const skillMd = await readFile(path.join(dest, 'SKILL.md'), 'utf-8')
      expect(skillMd).toBe('# foo\n')
      const util = await readFile(path.join(dest, 'helpers', 'util.ts'), 'utf-8')
      expect(util).toBe('export {}\n')

      // copies are independent: editing the destination must not change the source
      await writeFile(path.join(dest, 'SKILL.md'), '# modified\n', 'utf-8')
      const sourceAfter = await readFile(
        path.join(homeDir, '.claude', 'skills', 'foo', 'SKILL.md'),
        'utf-8'
      )
      expect(sourceAfter).toBe('# foo\n')

      const listed = await listLinks('foo')
      expect(listed).toHaveLength(1)
      expect(listed[0]?.kind).toBe('copy')
    })

    it('skips symlinks inside the source tree (matches install policy)', async () => {
      const { addLink } = await loadModule()
      const sourceDir = await seedSkill('bar', { 'SKILL.md': '# bar\n' })
      // Plant a symlink inside the source tree pointing outside; the copy
      // should silently skip it rather than follow.
      const outside = path.join(homeDir, 'outside.txt')
      await writeFile(outside, 'secret', 'utf-8')
      await symlink(outside, path.join(sourceDir, 'leaky.txt'))

      await addLink({ skillId: 'bar', fromClient: 'claude-code', toClient: 'cursor' })
      const dest = path.join(homeDir, '.cursor', 'skills', 'bar')

      // SKILL.md copied
      await expect(stat(path.join(dest, 'SKILL.md'))).resolves.toBeDefined()
      // symlink NOT recreated, NOT followed (no leaky.txt at destination)
      await expect(lstat(path.join(dest, 'leaky.txt'))).rejects.toThrow(/ENOENT/)
    })
  })

  describe('addLink (symlink opt-in)', () => {
    it('creates a relative symlink when preferSymlink=true', async () => {
      const { addLink } = await loadModule()
      await seedSkill('baz')
      const result = await addLink({
        skillId: 'baz',
        fromClient: 'claude-code',
        toClient: 'windsurf',
        preferSymlink: true,
      })
      expect(result.record.kind).toBe('symlink')

      const dest = path.join(homeDir, '.codeium', 'windsurf', 'skills', 'baz')
      const linkStat = await lstat(dest)
      expect(linkStat.isSymbolicLink()).toBe(true)

      // Editing through the symlink mutates the source — proves it's a real symlink
      await writeFile(path.join(dest, 'SKILL.md'), '# edited via symlink\n', 'utf-8')
      const sourceAfter = await readFile(
        path.join(homeDir, '.claude', 'skills', 'baz', 'SKILL.md'),
        'utf-8'
      )
      expect(sourceAfter).toBe('# edited via symlink\n')
    })

    it('falls back to copy on EPERM (Windows non-developer-mode behaviour)', async () => {
      // Mock fs/promises so addLink's `await fsp.symlink(...)` throws EPERM.
      // vi.spyOn can't redefine the export's property descriptor on Node's
      // promises module, so use vi.doMock + module re-import.
      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
        return {
          ...actual,
          default: actual,
          symlink: vi.fn(() => {
            const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException
            err.code = 'EPERM'
            return Promise.reject(err)
          }),
        }
      })
      try {
        // Re-import after the doMock so fan-out picks up the patched symlink
        const { addLink } = await import('../../src/install/fan-out.js')
        await seedSkill('qux')
        const result = await addLink({
          skillId: 'qux',
          fromClient: 'claude-code',
          toClient: 'cursor',
          preferSymlink: true,
        })
        expect(result.fellBackToCopy).toBe(true)
        expect(result.record.kind).toBe('copy')
      } finally {
        vi.doUnmock('node:fs/promises')
        vi.resetModules()
      }
    })
  })

  describe('addLink validation', () => {
    it('rejects fromClient === toClient', async () => {
      const { addLink } = await loadModule()
      await seedSkill('same')
      await expect(
        addLink({ skillId: 'same', fromClient: 'cursor', toClient: 'cursor' })
      ).rejects.toThrow(/must differ/)
    })

    it('rejects when source skill does not exist', async () => {
      const { addLink } = await loadModule()
      await expect(
        addLink({ skillId: 'missing', fromClient: 'claude-code', toClient: 'cursor' })
      ).rejects.toThrow(/install for claude-code first/)
    })

    it('refuses to overwrite a pre-existing destination without force', async () => {
      const { addLink } = await loadModule()
      await seedSkill('clash')
      // pre-create destination with different content
      const destDir = path.join(homeDir, '.cursor', 'skills', 'clash')
      await mkdir(destDir, { recursive: true })
      await writeFile(path.join(destDir, 'SKILL.md'), '# different\n', 'utf-8')

      await expect(
        addLink({ skillId: 'clash', fromClient: 'claude-code', toClient: 'cursor' })
      ).rejects.toThrow(/already exists.*--force/)

      // force overrides
      await addLink({
        skillId: 'clash',
        fromClient: 'claude-code',
        toClient: 'cursor',
        force: true,
      })
      const final = await readFile(path.join(destDir, 'SKILL.md'), 'utf-8')
      expect(final).toBe('# test\n') // matches seedSkill default
    })

    it('detects a reverse-direction cycle in an existing manifest entry', async () => {
      const { addLink } = await loadModule()
      // Seed forward link cursor → agents
      await seedSkill('cycle', {})
      // Seed an artificial source for the reverse hop (agents → claude-code)
      const agentsDir = path.join(homeDir, '.agents', 'skills', 'cycle')
      await mkdir(agentsDir, { recursive: true })
      await writeFile(path.join(agentsDir, 'SKILL.md'), '# cycle\n', 'utf-8')
      await addLink({
        skillId: 'cycle',
        fromClient: 'agents',
        toClient: 'claude-code',
        force: true,
      })

      // Reverse: claude-code → agents — should be flagged
      await expect(
        addLink({ skillId: 'cycle', fromClient: 'claude-code', toClient: 'agents', force: true })
      ).rejects.toThrow(/cycle detected/)
    })
  })

  describe('removeLinks', () => {
    it('returns 0 when no manifest exists', async () => {
      const { removeLinks } = await loadModule()
      const removed = await removeLinks('nothing')
      expect(removed).toBe(0)
    })

    it('removes both copies and symlinks for a skillId', async () => {
      const { addLink, removeLinks, listLinks } = await loadModule()
      await seedSkill('multi')
      await addLink({ skillId: 'multi', fromClient: 'claude-code', toClient: 'cursor' })
      await addLink({
        skillId: 'multi',
        fromClient: 'claude-code',
        toClient: 'windsurf',
        preferSymlink: true,
      })

      const removed = await removeLinks('multi')
      expect(removed).toBe(2)

      // both destinations are gone
      await expect(stat(path.join(homeDir, '.cursor', 'skills', 'multi'))).rejects.toThrow(/ENOENT/)
      await expect(
        lstat(path.join(homeDir, '.codeium', 'windsurf', 'skills', 'multi'))
      ).rejects.toThrow(/ENOENT/)

      // manifest is cleaned
      const remaining = await listLinks('multi')
      expect(remaining).toEqual([])

      // canonical source is untouched
      await expect(stat(path.join(homeDir, '.claude', 'skills', 'multi'))).resolves.toBeDefined()
    })
  })
})
