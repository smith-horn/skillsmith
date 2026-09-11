/**
 * SMI-4578: fan-out.ts unit tests.
 *
 * Tests use a per-test temp directory as $HOME so the manifest and the
 * per-client `~/.cursor/skills/` etc. live in an isolated tree, never
 * touching the real filesystem.
 */
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  lstat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mintDeadPid } from '../helpers/deterministic-dead-pid.js'

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

/** Make every link-manifest lock attempt fail, as when that lock can't be taken. */
function mockManifestLockFailure(): void {
  vi.doMock('../../src/install/fan-out.overwrite.js', async () => {
    const actual = await vi.importActual<typeof import('../../src/install/fan-out.overwrite.js')>(
      '../../src/install/fan-out.overwrite.js'
    )
    return {
      ...actual,
      withFileLock: vi.fn(
        async <T>(target: string, label: string, fn: () => Promise<T>): Promise<T> => {
          if (label.includes('manifest')) throw new Error('manifest lock unavailable')
          return actual.withFileLock(target, label, fn)
        }
      ),
    }
  })
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

      // SMI-6529 H3 (round 2) / N7 (round 4): `--force` no longer
      // recursively deletes a pre-existing REAL directory at the
      // destination unless it's a RECORDED Skillsmith copy (see the N7
      // tests below) — an UNRECORDED real directory (this one was created
      // by hand via mkdir/writeFile, never through addLink, so it has no
      // manifest entry) is refused with a clear error, and its content is
      // left completely untouched. N7 corrected the message: it no longer
      // says "not a link Skillsmith created" (false for a recorded COPY,
      // which round-2's H3 wording conflated with this genuinely-unrecorded
      // case) — it now says "not a fan-out destination Skillsmith recorded".
      await expect(
        addLink({
          skillId: 'clash',
          fromClient: 'claude-code',
          toClient: 'cursor',
          force: true,
        })
      ).rejects.toThrow(/not a fan-out destination Skillsmith recorded/)
      const stillThere = await readFile(path.join(destDir, 'SKILL.md'), 'utf-8')
      expect(stillThere).toBe('# different\n')
    })

    // SMI-6529 H3 regression: a pre-existing SYMLINK (Skillsmith's own prior
    // fan-out) at `toDir` is still safely replaceable under `force: true` —
    // the strict clear only refuses non-symlinks.
    it('H3: force replaces a pre-existing SYMLINK destination', async () => {
      const { addLink } = await loadModule()
      await seedSkill('symclash')
      const destDir = path.join(homeDir, '.cursor', 'skills', 'symclash')
      const staleTarget = path.join(homeDir, 'stale-target')
      await mkdir(staleTarget, { recursive: true })
      await writeFile(path.join(staleTarget, 'SKILL.md'), '# stale\n', 'utf-8')
      await mkdir(path.dirname(destDir), { recursive: true })
      await symlink(staleTarget, destDir, 'dir')

      await addLink({
        skillId: 'symclash',
        fromClient: 'claude-code',
        toClient: 'cursor',
        force: true,
      })

      const linkStat = await lstat(destDir)
      expect(linkStat.isSymbolicLink()).toBe(false) // default kind is copy
      const final = await readFile(path.join(destDir, 'SKILL.md'), 'utf-8')
      expect(final).toBe('# test\n') // matches seedSkill default — real fan-out content
    })

    // SMI-6529 H3 regression (exact reviewer scenario): a real pre-existing
    // directory containing `.git` and a user file must be left COMPLETELY
    // untouched under `force: true` — the strict clear must never recurse
    // into it, and the error must name the path. This directory is
    // UNRECORDED (created by hand, never through addLink), so — per N7's
    // check ordering (unrecorded-ness is checked BEFORE the `.git` check,
    // since an unrecorded directory is refused regardless of its content)
    // — it hits the "not a fan-out destination Skillsmith recorded"
    // message, not the git-specific one (that message is reserved for a
    // RECORDED copy that later grew a `.git` directory — see the N6/N7
    // tests below for that exact scenario).
    it('H3: force never deletes a real directory containing .git and user content', async () => {
      const { addLink } = await loadModule()
      await seedSkill('gitclash')
      const destDir = path.join(homeDir, '.cursor', 'skills', 'gitclash')
      await mkdir(path.join(destDir, '.git'), { recursive: true })
      await writeFile(path.join(destDir, 'my-notes.md'), 'do not delete me\n', 'utf-8')

      await expect(
        addLink({
          skillId: 'gitclash',
          fromClient: 'claude-code',
          toClient: 'cursor',
          force: true,
        })
      ).rejects.toThrow(new RegExp(`${destDir}.*not a fan-out destination Skillsmith recorded`))

      // Untouched: both the .git entry and the user's own file survive.
      await expect(stat(path.join(destDir, '.git'))).resolves.toBeDefined()
      const notes = await readFile(path.join(destDir, 'my-notes.md'), 'utf-8')
      expect(notes).toBe('do not delete me\n')
    })

    it('detects a reverse-direction cycle in an existing manifest entry', async () => {
      const { addLink } = await loadModule()
      // Seed an artificial source for the reverse hop (agents → claude-code)
      // — NOT the canonical claude-code location itself (SMI-6529 H3: a
      // force-overwrite of a REAL pre-existing directory there would now be
      // correctly refused as "not a link Skillsmith created"; seeding only
      // the agents-side source means claude-code's own `cycle` doesn't exist
      // yet when this forward link is created, so no overwrite is needed).
      const agentsDir = path.join(homeDir, '.agents', 'skills', 'cycle')
      await mkdir(agentsDir, { recursive: true })
      await writeFile(path.join(agentsDir, 'SKILL.md'), '# cycle\n', 'utf-8')
      await addLink({
        skillId: 'cycle',
        fromClient: 'agents',
        toClient: 'claude-code',
        force: true,
      })

      // Reverse: claude-code → agents — detectCycle() must fire BEFORE any
      // overwrite is even considered (it runs ahead of the pathExists/force
      // check in addLink()), so this never needs to touch agents' own
      // pre-existing `cycle` directory either.
      await expect(
        addLink({ skillId: 'cycle', fromClient: 'claude-code', toClient: 'agents', force: true })
      ).rejects.toThrow(/cycle detected/)
    })
  })

  describe('removeLinks', () => {
    // SMI-6529 N6 (round 4): `removeLinks` now returns `{removed, refused}`
    // instead of a bare number, so a caller can distinguish "nothing was
    // recorded" from "something was recorded but refused removal" (see the
    // N6 test below). These two tests updated for the new return shape —
    // behavior for the happy paths they cover is unchanged.
    it('returns {removed: 0, refused: []} when no manifest exists', async () => {
      const { removeLinks } = await loadModule()
      const result = await removeLinks('nothing')
      expect(result).toEqual({ removed: 0, refused: [] })
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

      const result = await removeLinks('multi')
      expect(result.removed).toBe(2)
      expect(result.refused).toEqual([])

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

    // SMI-6529 N6 (round 4, reviewer probe-removelinks.mjs exact scenario):
    // a RECORDED copy-mode fan-out destination that has since become the
    // user's own git clone (with uncommitted work) must survive an
    // uninstall's `removeLinks` call — it must be refused and reported, not
    // recursively deleted on the strength of a stale manifest record alone.
    it('N6: refuses to recursively delete a recorded copy that has since become a .git working tree', async () => {
      const { addLink, removeLinks, listLinks } = await loadModule()
      await seedSkill('gitreplaced')
      const { record } = await addLink({
        skillId: 'gitreplaced',
        fromClient: 'claude-code',
        toClient: 'cursor',
      })
      expect(record.kind).toBe('copy')

      // The user later replaces the fan-out copy with their own git clone +
      // uncommitted work.
      await rm(record.to, { recursive: true, force: true })
      await mkdir(path.join(record.to, '.git'), { recursive: true })
      await writeFile(path.join(record.to, 'SKILL.md'), 'UNCOMMITTED USER WORK', 'utf-8')

      const result = await removeLinks('gitreplaced')

      expect(result.removed).toBe(0)
      expect(result.refused).toHaveLength(1)
      expect(result.refused[0]?.to).toBe(record.to)
      expect(result.refused[0]?.reason).toMatch(/\.git directory/)

      // The clone survives completely untouched.
      await expect(stat(path.join(record.to, '.git'))).resolves.toBeDefined()
      expect(await readFile(path.join(record.to, 'SKILL.md'), 'utf-8')).toBe(
        'UNCOMMITTED USER WORK'
      )

      // The manifest entry is KEPT (not silently dropped) so a future
      // uninstall retry is still possible once the user clears the path.
      const remaining = await listLinks('gitreplaced')
      expect(remaining).toHaveLength(1)
    })

    // SMI-6529 N6 (round 4): a RECORDED symlink is still just unlinked
    // outright — the git-at-root refusal is specific to a recorded COPY.
    it('N6: still unlinks a recorded SYMLINK outright, even if its target now contains .git', async () => {
      const { addLink, removeLinks } = await loadModule()
      await seedSkill('symlinkstillremoved')
      const { record } = await addLink({
        skillId: 'symlinkstillremoved',
        fromClient: 'claude-code',
        toClient: 'windsurf',
        preferSymlink: true,
      })
      expect(record.kind).toBe('symlink')
      // A `.git` dir at the SYMLINK TARGET (the canonical source) must not
      // matter — only the recorded destination's OWN type (symlink vs
      // real directory) governs whether it's disposable.
      await mkdir(path.join(homeDir, '.claude', 'skills', 'symlinkstillremoved', '.git'), {
        recursive: true,
      })

      const result = await removeLinks('symlinkstillremoved')

      expect(result.removed).toBe(1)
      expect(result.refused).toEqual([])
      await expect(lstat(record.to)).rejects.toThrow(/ENOENT/)
    })
  })

  // SMI-6529 review round 5: the force-refresh backup must never delete an
  // existing path (R2), a backup stranded by a crash must be restored (R3),
  // and a dangling `.git` symlink must still count as a git working tree (R4).
  describe('SMI-6529 round 5: fan-out overwrite backups', () => {
    it('R2: a force refresh never removes an existing path at a backup-like name', async () => {
      const { addLink } = await loadModule()
      await seedSkill('bkclash')
      const { record } = await addLink({
        skillId: 'bkclash',
        fromClient: 'claude-code',
        toClient: 'cursor',
      })
      // The pre-round-5 fixed backup name, and a dot-prefixed look-alike,
      // both holding user data.
      const legacyName = `${record.to}.smi6529-backup.${process.pid}.tmp`
      await mkdir(path.join(legacyName, '.git'), { recursive: true })
      await writeFile(path.join(legacyName, 'KEEP.md'), 'keep me', 'utf-8')
      const lookAlike = path.join(path.dirname(record.to), '.bkclash.skillsmith-backup-userdata')
      await mkdir(lookAlike, { recursive: true })
      await writeFile(path.join(lookAlike, 'KEEP.md'), 'keep me too', 'utf-8')

      await addLink({
        skillId: 'bkclash',
        fromClient: 'claude-code',
        toClient: 'cursor',
        force: true,
      })

      expect(await readFile(path.join(legacyName, 'KEEP.md'), 'utf-8')).toBe('keep me')
      await expect(stat(path.join(legacyName, '.git'))).resolves.toBeDefined()
      expect(await readFile(path.join(lookAlike, 'KEEP.md'), 'utf-8')).toBe('keep me too')
      // The refresh left no backup container of its own behind.
      const leftovers = (await readdir(path.dirname(record.to))).filter(
        (name) =>
          name.startsWith('.bkclash.skillsmith-backup-') && name !== path.basename(lookAlike)
      )
      expect(leftovers).toEqual([])
    })

    it('R3: restores a destination stranded in a backup by a crash before rewriting', async () => {
      const { addLink } = await loadModule()
      await seedSkill('stranded')
      const { record } = await addLink({
        skillId: 'stranded',
        fromClient: 'claude-code',
        toClient: 'cursor',
      })
      await writeFile(path.join(record.to, 'LOCAL.md'), 'recorded copy content', 'utf-8')
      // A crash after the rename-aside: the destination is gone and the
      // original sits inside a backup container.
      const container = path.join(path.dirname(record.to), '.stranded.skillsmith-backup-crash1')
      await mkdir(container, { recursive: true })
      await rename(record.to, path.join(container, 'original'))

      // A plain addLink restores the original first, then reports that the
      // destination exists.
      await expect(
        addLink({ skillId: 'stranded', fromClient: 'claude-code', toClient: 'cursor' })
      ).rejects.toThrow(/already exists/)
      expect(await readFile(path.join(record.to, 'LOCAL.md'), 'utf-8')).toBe(
        'recorded copy content'
      )
      await expect(stat(container)).rejects.toThrow(/ENOENT/)
    })

    it('R4: a dangling .git symlink in a recorded copy still blocks overwrite and uninstall', async () => {
      const { addLink, removeLinks } = await loadModule()
      await seedSkill('danglinggit')
      const { record } = await addLink({
        skillId: 'danglinggit',
        fromClient: 'claude-code',
        toClient: 'cursor',
      })
      await writeFile(path.join(record.to, 'LOCAL-EDIT.md'), 'mine', 'utf-8')
      await symlink(path.join(homeDir, 'does-not-exist'), path.join(record.to, '.git'))

      await expect(
        addLink({
          skillId: 'danglinggit',
          fromClient: 'claude-code',
          toClient: 'cursor',
          force: true,
        })
      ).rejects.toThrow(/\.git directory/)
      expect(await readFile(path.join(record.to, 'LOCAL-EDIT.md'), 'utf-8')).toBe('mine')

      const result = await removeLinks('danglinggit')
      expect(result.removed).toBe(0)
      expect(result.refused).toHaveLength(1)
      expect(await readFile(path.join(record.to, 'LOCAL-EDIT.md'), 'utf-8')).toBe('mine')
    })
  })

  // SMI-6529 review round 6: refreshes run under a per-destination lock and
  // write to a staging folder that is swapped into place, so concurrent calls
  // never lose content, a failed write never touches the destination, stale
  // folders are cleaned or ignored safely, and names match exactly.
  describe('SMI-6529 round 6: locked, staged refresh', () => {
    it('concurrent force refreshes of one destination all succeed and never lose content', async () => {
      const { addLink, listLinks } = await loadModule()
      const files: Record<string, string> = { 'SKILL.md': '# race\n' }
      for (let i = 0; i < 40; i++) files[`f${i}.md`] = `file ${i}\n`
      await seedSkill('race', files)
      await addLink({ skillId: 'race', fromClient: 'claude-code', toClient: 'cursor' })

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          addLink({ skillId: 'race', fromClient: 'claude-code', toClient: 'cursor', force: true })
        )
      )

      expect(results.filter((r) => r.status === 'rejected')).toEqual([])
      const dest = path.join(homeDir, '.cursor', 'skills', 'race')
      expect((await readdir(dest)).length).toBe(41)
      expect(await listLinks('race')).toHaveLength(1)
      const leftovers = (await readdir(path.dirname(dest))).filter(
        (name) => name.includes('skillsmith-backup-') || name.includes('skillsmith-staging-')
      )
      expect(leftovers).toEqual([])
    })

    it('removes a stale staging folder and never restores a backup whose original is not a directory', async () => {
      const { addLink } = await loadModule()
      await seedSkill('leftovers')
      const { record } = await addLink({
        skillId: 'leftovers',
        fromClient: 'claude-code',
        toClient: 'cursor',
      })
      const parent = path.dirname(record.to)
      const staleStaging = path.join(parent, '.leftovers.skillsmith-staging-abc123')
      await mkdir(path.join(staleStaging, 'content'), { recursive: true })
      // A backup whose `original` is a symlink, with the destination missing.
      const oddBackup = path.join(parent, '.leftovers.skillsmith-backup-sym001')
      await mkdir(oddBackup, { recursive: true })
      await symlink(homeDir, path.join(oddBackup, 'original'))
      await rm(record.to, { recursive: true, force: true })

      await addLink({ skillId: 'leftovers', fromClient: 'claude-code', toClient: 'cursor' })

      await expect(stat(staleStaging)).rejects.toThrow(/ENOENT/)
      expect((await lstat(record.to)).isDirectory()).toBe(true)
      expect((await lstat(path.join(oddBackup, 'original'))).isSymbolicLink()).toBe(true)
    })

    it("never touches another skill's folders that share a name prefix", async () => {
      const { addLink } = await loadModule()
      await seedSkill('foo')
      const { record } = await addLink({
        skillId: 'foo',
        fromClient: 'claude-code',
        toClient: 'cursor',
      })
      const parent = path.dirname(record.to)
      // Folders of a different skill literally named `foo.skillsmith-backup-x`,
      // and a look-alike staging name with a 7-character suffix.
      const siblingBackup = path.join(parent, '.foo.skillsmith-backup-x.skillsmith-backup-abc123')
      await mkdir(path.join(siblingBackup, 'original'), { recursive: true })
      await writeFile(path.join(siblingBackup, 'original', 'KEEP.md'), 'sibling', 'utf-8')
      const siblingStaging = path.join(parent, '.foo.skillsmith-staging-toolong')
      await mkdir(siblingStaging, { recursive: true })
      await rm(record.to, { recursive: true, force: true })

      await addLink({ skillId: 'foo', fromClient: 'claude-code', toClient: 'cursor' })

      expect(await readFile(path.join(siblingBackup, 'original', 'KEEP.md'), 'utf-8')).toBe(
        'sibling'
      )
      await expect(stat(siblingStaging)).resolves.toBeDefined()
      await expect(stat(path.join(record.to, 'KEEP.md'))).rejects.toThrow(/ENOENT/)
    })

    it('reports a failed .git check as unverifiable, not as a git working tree', async () => {
      const { addLink: setupAddLink } = await loadModule()
      await seedSkill('noaccess')
      const first = await setupAddLink({
        skillId: 'noaccess',
        fromClient: 'claude-code',
        toClient: 'cursor',
      })

      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
        return {
          ...actual,
          default: actual,
          lstat: vi.fn(async (...args: Parameters<typeof actual.lstat>) => {
            if (String(args[0]).endsWith(`${path.sep}.git`)) {
              const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException
              err.code = 'EACCES'
              throw err
            }
            return actual.lstat(...args)
          }),
        }
      })
      try {
        vi.resetModules()
        const { addLink } = await import('../../src/install/fan-out.js')
        await expect(
          addLink({
            skillId: 'noaccess',
            fromClient: 'claude-code',
            toClient: 'cursor',
            force: true,
          })
        ).rejects.toThrow(/could not check .* for a \.git directory \(EACCES\)/)
      } finally {
        vi.doUnmock('node:fs/promises')
        vi.resetModules()
      }
      expect(await readFile(path.join(first.record.to, 'SKILL.md'), 'utf-8')).toBe('# test\n')
    })
  })

  // SMI-6529 review round 7: waiting for the destination lock never blocks
  // the event loop, a symlinked spelling shares the in-process queue, and a
  // leftover backup from an interrupted refresh is reported, not hidden.
  describe('SMI-6529 round 7: non-blocking lock and leftover warnings', () => {
    it('two spellings of one destination serialize without blocking the event loop', async () => {
      const { withDestinationLock } = await import('../../src/install/fan-out.overwrite.js')
      const realParent = path.join(homeDir, 'real-parent')
      await mkdir(realParent, { recursive: true })
      const aliasParent = path.join(homeDir, 'alias-parent')
      await symlink(realParent, aliasParent)

      let releaseFirst: () => void = () => {}
      const firstHeld = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      const order: string[] = []
      const first = withDestinationLock(path.join(realParent, 'dest'), async () => {
        order.push('first-start')
        await firstHeld
        order.push('first-end')
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      const second = withDestinationLock(path.join(aliasParent, 'dest'), async () => {
        order.push('second')
      })

      let ticks = 0
      const timer = setInterval(() => {
        ticks++
      }, 10)
      await new Promise((resolve) => setTimeout(resolve, 200))
      clearInterval(timer)
      expect(ticks).toBeGreaterThan(5)
      expect(order).toEqual(['first-start'])

      releaseFirst()
      await Promise.all([first, second])
      expect(order).toEqual(['first-start', 'first-end', 'second'])
    })

    it('waits for a lock held elsewhere without blocking the event loop', async () => {
      const { withDestinationLock } = await import('../../src/install/fan-out.overwrite.js')
      const { acquireOwnedLock } = await import('../../src/config/owned-lock.js')
      const parent = path.join(homeDir, 'held-parent')
      await mkdir(parent, { recursive: true })
      const releaseOther = acquireOwnedLock(path.join(parent, '.dest.skillsmith-fanout'))

      let ran = false
      const waiting = withDestinationLock(path.join(parent, 'dest'), async () => {
        ran = true
      })
      let ticks = 0
      const timer = setInterval(() => {
        ticks++
      }, 10)
      await new Promise((resolve) => setTimeout(resolve, 200))
      clearInterval(timer)
      expect(ticks).toBeGreaterThan(5)
      expect(ran).toBe(false)

      releaseOther()
      await waiting
      expect(ran).toBe(true)
    })

    it('reports a leftover backup from an interrupted refresh as a warning, and keeps it', async () => {
      const { addLink, removeLinks } = await loadModule()
      await seedSkill('leftwarn')
      const { record } = await addLink({
        skillId: 'leftwarn',
        fromClient: 'claude-code',
        toClient: 'cursor',
      })
      const backupFolder = path.join(path.dirname(record.to), '.leftwarn.skillsmith-backup-old001')
      await mkdir(path.join(backupFolder, 'original'), { recursive: true })
      await writeFile(path.join(backupFolder, 'original', 'OLD.md'), 'old copy', 'utf-8')

      const refreshed = await addLink({
        skillId: 'leftwarn',
        fromClient: 'claude-code',
        toClient: 'cursor',
        force: true,
      })
      expect(refreshed.warnings).toEqual([expect.stringContaining(backupFolder)])
      expect(await readFile(path.join(backupFolder, 'original', 'OLD.md'), 'utf-8')).toBe(
        'old copy'
      )

      const removed = await removeLinks('leftwarn')
      expect(removed.warnings).toEqual([expect.stringContaining(backupFolder)])
      expect(await readFile(path.join(backupFolder, 'original', 'OLD.md'), 'utf-8')).toBe(
        'old copy'
      )
    })
  })

  // SMI-6529 review round 8: a stale backup is never restored over a skill
  // that was uninstalled since, an empty backup folder is removed, and the
  // lock wait never blocks on an orphaned reclaim lock or gives up while a
  // live holder has the lock with auto-reclaim turned off.
  describe('SMI-6529 round 8: backup recovery and lock waits', () => {
    function claimFor(pid: number): string {
      return (
        JSON.stringify({
          v: 1,
          pid,
          token: 'a'.repeat(16),
          host: hostname(),
          acquiredAt: Date.now(),
        }) + '\n'
      )
    }

    it('a reinstall after an uninstall never restores a superseded backup', async () => {
      const { addLink, removeLinks, listLinks } = await loadModule()
      await seedSkill('stale')
      const { record } = await addLink({
        skillId: 'stale',
        fromClient: 'claude-code',
        toClient: 'cursor',
      })
      // A superseded copy left behind by a crash after an earlier swap.
      const backupFolder = path.join(path.dirname(record.to), '.stale.skillsmith-backup-old001')
      await mkdir(path.join(backupFolder, 'original'), { recursive: true })
      await writeFile(path.join(backupFolder, 'original', 'SKILL.md'), '# stale\n', 'utf-8')

      const removed = await removeLinks('stale')
      expect(removed.removed).toBe(1)
      await expect(stat(record.to)).rejects.toThrow(/ENOENT/)

      const reinstalled = await addLink({
        skillId: 'stale',
        fromClient: 'claude-code',
        toClient: 'cursor',
      })
      expect(await readFile(path.join(record.to, 'SKILL.md'), 'utf-8')).toBe('# test\n')
      expect(await listLinks('stale')).toHaveLength(1)
      expect(reinstalled.warnings).toEqual([expect.stringContaining(backupFolder)])
      expect(await readFile(path.join(backupFolder, 'original', 'SKILL.md'), 'utf-8')).toBe(
        '# stale\n'
      )
    })

    it('removes an empty backup folder left by a crash instead of reporting it', async () => {
      const { addLink, removeLinks } = await loadModule()
      await seedSkill('emptybk')
      const { record } = await addLink({
        skillId: 'emptybk',
        fromClient: 'claude-code',
        toClient: 'cursor',
      })
      const parent = path.dirname(record.to)

      const first = path.join(parent, '.emptybk.skillsmith-backup-empty1')
      await mkdir(first)
      const refreshed = await addLink({
        skillId: 'emptybk',
        fromClient: 'claude-code',
        toClient: 'cursor',
        force: true,
      })
      expect(refreshed.warnings).toBeUndefined()
      await expect(stat(first)).rejects.toThrow(/ENOENT/)

      const second = path.join(parent, '.emptybk.skillsmith-backup-empty2')
      await mkdir(second)
      const removed = await removeLinks('emptybk')
      expect(removed.warnings).toBeUndefined()
      await expect(stat(second)).rejects.toThrow(/ENOENT/)
    })

    it('waits on an orphaned reclaim lock without blocking the event loop', async () => {
      const { withDestinationLock } = await import('../../src/install/fan-out.overwrite.js')
      const parent = path.join(homeDir, 'orphan-parent')
      await mkdir(parent, { recursive: true })
      const lockPath = path.join(parent, '.dest.skillsmith-fanout.lock')
      // A crashed holder, plus a reclaim lock orphaned by a crash mid-reclaim.
      await writeFile(lockPath, claimFor(mintDeadPid()))
      await writeFile(`${lockPath}.reclaim`, claimFor(process.pid))

      let ran = false
      const waiting = withDestinationLock(path.join(parent, 'dest'), async () => {
        ran = true
      })
      let last = performance.now()
      let maxGap = 0
      const timer = setInterval(() => {
        const now = performance.now()
        maxGap = Math.max(maxGap, now - last)
        last = now
      }, 10)
      let ranBeforeUnstick = false
      try {
        await new Promise((resolve) => setTimeout(resolve, 700))
      } finally {
        // Unstick before any assertion, so a failure never leaves the wait
        // polling into a deleted temp HOME.
        clearInterval(timer)
        ranBeforeUnstick = ran
        await rm(`${lockPath}.reclaim`) // the documented manual unstick
      }
      await waiting
      expect(ranBeforeUnstick).toBe(false)
      // Each attempt used to sleep 500 ms synchronously on the reclaim lock.
      expect(maxGap).toBeLessThan(200)
      expect(ran).toBe(true)
    })

    it('waits for a live holder when auto-reclaim is turned off', async () => {
      const previous = process.env['SKILLSMITH_LOCK_NO_AUTO_RECLAIM']
      process.env['SKILLSMITH_LOCK_NO_AUTO_RECLAIM'] = '1'
      try {
        const { withDestinationLock } = await import('../../src/install/fan-out.overwrite.js')
        const { acquireOwnedLock } = await import('../../src/config/owned-lock.js')
        const parent = path.join(homeDir, 'noreclaim-parent')
        await mkdir(parent, { recursive: true })
        const releaseOther = acquireOwnedLock(path.join(parent, '.dest.skillsmith-fanout'))

        let ran = false
        const outcome = withDestinationLock(path.join(parent, 'dest'), async () => {
          ran = true
        }).then(
          () => 'ok',
          (err: unknown) => err
        )
        let ranBeforeRelease = false
        try {
          await new Promise((resolve) => setTimeout(resolve, 150))
          ranBeforeRelease = ran
        } finally {
          releaseOther()
        }
        expect(ranBeforeRelease).toBe(false)
        expect(await outcome).toBe('ok')
        expect(ran).toBe(true)
      } finally {
        if (previous === undefined) delete process.env['SKILLSMITH_LOCK_NO_AUTO_RECLAIM']
        else process.env['SKILLSMITH_LOCK_NO_AUTO_RECLAIM'] = previous
      }
    })
  })

  // SMI-6529 review round 9: only an unambiguous stranded backup is restored,
  // the link manifest is changed under its own lock and never silently
  // replaced, and a case-variant backup is reported where the volume ignores
  // case.
  describe('SMI-6529 round 9: manifest lock and ambiguous backups', () => {
    it('restores nothing when two backups could be the stranded copy, in either name order', async () => {
      const { addLink } = await loadModule()
      const orders = [
        ['twoa', 'AAAAAA', 'zzzzzz'],
        ['twob', 'zzzzzz', 'AAAAAA'],
      ] as const
      for (const [skillId, olderSuffix, newerSuffix] of orders) {
        await seedSkill(skillId)
        const { record } = await addLink({ skillId, fromClient: 'claude-code', toClient: 'cursor' })
        // Stranded: the destination is gone, the record is still there.
        await rm(record.to, { recursive: true, force: true })
        const parent = path.dirname(record.to)
        const older = path.join(parent, `.${skillId}.skillsmith-backup-${olderSuffix}`)
        const newer = path.join(parent, `.${skillId}.skillsmith-backup-${newerSuffix}`)
        for (const [folder, content] of [
          [older, '# older\n'],
          [newer, '# newer\n'],
        ] as const) {
          await mkdir(path.join(folder, 'original'), { recursive: true })
          await writeFile(path.join(folder, 'original', 'SKILL.md'), content, 'utf-8')
        }

        const result = await addLink({ skillId, fromClient: 'claude-code', toClient: 'cursor' })

        expect(await readFile(path.join(record.to, 'SKILL.md'), 'utf-8')).toBe('# test\n')
        expect(result.warnings).toHaveLength(2)
        expect(await readFile(path.join(older, 'original', 'SKILL.md'), 'utf-8')).toBe('# older\n')
        expect(await readFile(path.join(newer, 'original', 'SKILL.md'), 'utf-8')).toBe('# newer\n')
      }
    })

    it('keeps every record when different skills fan out at the same time', async () => {
      const { addLink, listLinks } = await loadModule()
      const ids = Array.from({ length: 12 }, (_, i) => `par${i}`)
      for (const id of ids) await seedSkill(id)

      const results = await Promise.allSettled(
        ids.map((skillId) => addLink({ skillId, fromClient: 'claude-code', toClient: 'cursor' }))
      )

      expect(results.filter((r) => r.status === 'rejected')).toEqual([])
      expect((await listLinks()).map((l) => l.skillId).sort()).toEqual([...ids].sort())
    })

    it('moves a corrupt manifest aside with a warning instead of wiping it', async () => {
      const { addLink, removeLinks, listLinks, getLinkManifestPath } = await loadModule()
      await seedSkill('fresh')
      const manifestPath = getLinkManifestPath()
      const corrupt = '{"version":1,"links":[{"skillId":"other"'
      await mkdir(path.dirname(manifestPath), { recursive: true })
      await writeFile(manifestPath, corrupt, 'utf-8')

      // An uninstall writes nothing, and says it couldn't use the manifest.
      expect(await removeLinks('other')).toEqual({
        removed: 0,
        refused: [],
        warnings: [expect.stringContaining('could not be parsed')],
      })
      expect(await readFile(manifestPath, 'utf-8')).toBe(corrupt)

      const result = await addLink({
        skillId: 'fresh',
        fromClient: 'claude-code',
        toClient: 'cursor',
      })

      const aside = (await readdir(path.dirname(manifestPath))).filter((n) =>
        n.startsWith('manifest.json.corrupt-')
      )
      expect(aside).toHaveLength(1)
      expect(await readFile(path.join(path.dirname(manifestPath), String(aside[0])), 'utf-8')).toBe(
        corrupt
      )
      expect(result.warnings).toEqual([expect.stringContaining('could not be parsed')])
      expect((await listLinks()).map((l) => l.skillId)).toEqual(['fresh'])
    })

    it('refuses to overwrite a manifest it cannot read, before writing any copy', async () => {
      const { addLink, getLinkManifestPath } = await loadModule()
      await seedSkill('blocked')
      const manifestPath = getLinkManifestPath()
      await mkdir(manifestPath, { recursive: true }) // a directory: EISDIR on read

      await expect(
        addLink({ skillId: 'blocked', fromClient: 'claude-code', toClient: 'cursor' })
      ).rejects.toThrow(/could not read the fan-out link manifest/)
      expect((await stat(manifestPath)).isDirectory()).toBe(true)
      // No unrecorded copy was left behind.
      await expect(stat(path.join(homeDir, '.cursor', 'skills', 'blocked'))).rejects.toThrow(
        /ENOENT/
      )
    })

    it('reports a case-variant backup only where the volume ignores case, and never removes it', async () => {
      const { listLeftoverBackups } = await import('../../src/install/fan-out.overwrite.js')
      const parent = path.join(homeDir, 'case-parent')
      await mkdir(parent, { recursive: true })
      await writeFile(path.join(parent, 'probe'), '')
      const ignoresCase = await stat(path.join(parent, 'PROBE')).then(
        () => true,
        () => false
      )
      const variant = path.join(parent, '.CV.skillsmith-backup-AbC123')
      await mkdir(path.join(variant, 'original'), { recursive: true })
      await writeFile(path.join(variant, 'original', 'SKILL.md'), '# variant\n', 'utf-8')
      const emptyVariant = path.join(parent, '.CV.skillsmith-backup-Emp123')
      await mkdir(emptyVariant)

      const leftovers = await listLeftoverBackups(path.join(parent, 'cv'))

      expect(leftovers).toEqual(ignoresCase ? [variant] : [])
      await expect(stat(variant)).resolves.toBeDefined()
      await expect(stat(emptyVariant)).resolves.toBeDefined()
    })
  })

  // SMI-6529 review round 10: an uninstall never drops a concurrent re-link's
  // record, a newer manifest version is never moved aside, a corrupt manifest
  // is named in a force-refresh refusal, and a fresh copy whose record can't
  // be saved is taken back out.
  describe('SMI-6529 round 10: record integrity under races and bad manifests', () => {
    it('an uninstall never drops the record of a copy a concurrent re-link just made', async () => {
      const { addLink, removeLinks, listLinks } = await loadModule()
      const { acquireOwnedLock } = await import('../../src/config/owned-lock.js')
      await seedSkill('rmadd')
      const cursor = await addLink({
        skillId: 'rmadd',
        fromClient: 'claude-code',
        toClient: 'cursor',
      })
      const windsurf = await addLink({
        skillId: 'rmadd',
        fromClient: 'claude-code',
        toClient: 'windsurf',
      })
      // Hold windsurf's destination lock so the uninstall pauses after cursor.
      const releaseWindsurf = acquireOwnedLock(
        path.join(path.dirname(windsurf.record.to), '.rmadd.skillsmith-fanout')
      )
      let removal: Promise<unknown> = Promise.resolve()
      try {
        removal = removeLinks('rmadd')
        for (let i = 0; i < 150; i++) {
          const present = await stat(cursor.record.to).then(
            () => true,
            () => false
          )
          if (!present) break
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        await expect(stat(cursor.record.to)).rejects.toThrow(/ENOENT/)
        // A re-link of the same skill to cursor lands mid-uninstall.
        await addLink({ skillId: 'rmadd', fromClient: 'claude-code', toClient: 'cursor' })
      } finally {
        releaseWindsurf()
      }
      await removal

      expect((await listLinks('rmadd')).map((l) => l.to)).toEqual([cursor.record.to])
      await expect(stat(cursor.record.to)).resolves.toBeDefined()
    })

    it('refuses to overwrite a manifest written by a newer version', async () => {
      const { addLink, getLinkManifestPath } = await loadModule()
      await seedSkill('newer')
      const manifestPath = getLinkManifestPath()
      const newer = '{"version":2,"links":[{"skillId":"future"}]}'
      await mkdir(path.dirname(manifestPath), { recursive: true })
      await writeFile(manifestPath, newer, 'utf-8')

      await expect(
        addLink({ skillId: 'newer', fromClient: 'claude-code', toClient: 'cursor' })
      ).rejects.toThrow(/newer Skillsmith/)
      expect(await readFile(manifestPath, 'utf-8')).toBe(newer)
      const aside = (await readdir(path.dirname(manifestPath))).filter((n) =>
        n.includes('.corrupt-')
      )
      expect(aside).toEqual([])
    })

    it('names the corrupt manifest when refusing a force refresh over an existing copy', async () => {
      const { addLink, getLinkManifestPath } = await loadModule()
      await seedSkill('corruptforce')
      await addLink({ skillId: 'corruptforce', fromClient: 'claude-code', toClient: 'cursor' })
      await writeFile(getLinkManifestPath(), 'not json', 'utf-8')

      await expect(
        addLink({
          skillId: 'corruptforce',
          fromClient: 'claude-code',
          toClient: 'cursor',
          force: true,
        })
      ).rejects.toThrow(/could not be parsed/)
    })

    it('takes a fresh copy back out when its record cannot be saved', async () => {
      mockManifestLockFailure()
      try {
        vi.resetModules()
        const { addLink } = await import('../../src/install/fan-out.js')
        await seedSkill('norecord')
        await expect(
          addLink({ skillId: 'norecord', fromClient: 'claude-code', toClient: 'cursor' })
        ).rejects.toThrow(/manifest lock unavailable/)
        await expect(stat(path.join(homeDir, '.cursor', 'skills', 'norecord'))).rejects.toThrow(
          /ENOENT/
        )
      } finally {
        vi.doUnmock('../../src/install/fan-out.overwrite.js')
        vi.resetModules()
      }
    })
  })

  // SMI-6529 review round 11: an uninstall drops every current record for a
  // destination it removes, a refreshed symlink is put back when its record
  // can't be saved, a byte-order mark isn't corruption, and an uninstall says
  // when it couldn't use the manifest.
  describe('SMI-6529 round 11: record integrity, second pass', () => {
    it('an uninstall that runs after a force refresh leaves no record for the folder it removed', async () => {
      const { addLink, removeLinks, listLinks } = await loadModule()
      const { acquireOwnedLock } = await import('../../src/config/owned-lock.js')
      await seedSkill('addrm')
      const { record } = await addLink({
        skillId: 'addrm',
        fromClient: 'claude-code',
        toClient: 'cursor',
      })
      // Hold the destination's lock so both calls queue on it: the refresh
      // first, then the uninstall, which has already read the old record.
      const release = acquireOwnedLock(
        path.join(path.dirname(record.to), '.addrm.skillsmith-fanout')
      )
      let refresh: Promise<unknown> = Promise.resolve()
      let removal: Promise<unknown> = Promise.resolve()
      try {
        refresh = addLink({
          skillId: 'addrm',
          fromClient: 'claude-code',
          toClient: 'cursor',
          force: true,
        })
        await new Promise((resolve) => setTimeout(resolve, 50))
        removal = removeLinks('addrm')
        await new Promise((resolve) => setTimeout(resolve, 100))
      } finally {
        release()
      }
      await refresh
      await removal

      expect(await listLinks('addrm')).toEqual([])
      await expect(stat(record.to)).rejects.toThrow(/ENOENT/)
    })

    it('puts a refreshed symlink back when its record cannot be saved', async () => {
      const { addLink } = await loadModule()
      await seedSkill('linkundo')
      const first = await addLink({
        skillId: 'linkundo',
        fromClient: 'claude-code',
        toClient: 'windsurf',
        preferSymlink: true,
      })
      expect(first.record.kind).toBe('symlink')
      const target = await readlink(first.record.to)

      mockManifestLockFailure()
      try {
        vi.resetModules()
        const { addLink: failingAddLink } = await import('../../src/install/fan-out.js')
        await expect(
          failingAddLink({
            skillId: 'linkundo',
            fromClient: 'claude-code',
            toClient: 'windsurf',
            force: true,
          })
        ).rejects.toThrow(/manifest lock unavailable/)
      } finally {
        vi.doUnmock('../../src/install/fan-out.overwrite.js')
        vi.resetModules()
      }

      expect((await lstat(first.record.to)).isSymbolicLink()).toBe(true)
      expect(await readlink(first.record.to)).toBe(target)
    })

    it('reads a manifest that starts with a byte-order mark', async () => {
      const { addLink, listLinks, getLinkManifestPath } = await loadModule()
      await seedSkill('bomkeep')
      await seedSkill('bomnew')
      const { record } = await addLink({
        skillId: 'bomkeep',
        fromClient: 'claude-code',
        toClient: 'cursor',
      })
      const manifestPath = getLinkManifestPath()
      await writeFile(manifestPath, '\uFEFF' + (await readFile(manifestPath, 'utf-8')), 'utf-8')

      expect((await listLinks()).map((l) => l.to)).toEqual([record.to])
      const result = await addLink({
        skillId: 'bomnew',
        fromClient: 'claude-code',
        toClient: 'cursor',
      })
      expect(result.warnings).toBeUndefined()
      expect((await listLinks()).map((l) => l.skillId).sort()).toEqual(['bomkeep', 'bomnew'])
    })

    it('tells the user when an uninstall could not use the manifest', async () => {
      const { removeLinks, getLinkManifestPath } = await loadModule()
      const manifestPath = getLinkManifestPath()
      const newer = '{"version":2,"links":[{"skillId":"future"}]}'
      await mkdir(path.dirname(manifestPath), { recursive: true })
      await writeFile(manifestPath, newer, 'utf-8')

      const result = await removeLinks('future')

      expect(result.removed).toBe(0)
      expect(result.warnings).toEqual([expect.stringContaining('newer Skillsmith')])
      expect(await readFile(manifestPath, 'utf-8')).toBe(newer)
    })
  })

  // SMI-6529 N7 (round 4): `--force --also-link` must be able to refresh a
  // COPY Skillsmith itself recorded (the default fan-out kind) — round-2's
  // H3 fix incorrectly refused this too, treating every non-symlink `toDir`
  // as unrecorded. A recorded copy with no `.git` is now replaceable: since
  // round 6 the new copy is written to a staging folder and swapped into
  // place, never written over the destination or recursively deleted.
  describe('N7: force-overwrite of a RECORDED copy', () => {
    it('replaces a recorded copy (no .git) with fresh content, replacing (not duplicating) its manifest record', async () => {
      const { addLink, listLinks } = await loadModule()
      await seedSkill('refreshme', { 'SKILL.md': '# v1\n' })
      const first = await addLink({
        skillId: 'refreshme',
        fromClient: 'claude-code',
        toClient: 'cursor',
      })
      expect(first.record.kind).toBe('copy')

      // The canonical source moves on to a new version.
      await writeFile(
        path.join(homeDir, '.claude', 'skills', 'refreshme', 'SKILL.md'),
        '# v2\n',
        'utf-8'
      )

      const second = await addLink({
        skillId: 'refreshme',
        fromClient: 'claude-code',
        toClient: 'cursor',
        force: true,
      })
      expect(second.record.kind).toBe('copy')

      const dest = path.join(homeDir, '.cursor', 'skills', 'refreshme')
      expect(await readFile(path.join(dest, 'SKILL.md'), 'utf-8')).toBe('# v2\n')

      // Manifest carries exactly ONE record for this destination — the
      // force-overwrite REPLACED it, never appended a duplicate.
      const listed = await listLinks('refreshme')
      expect(listed).toHaveLength(1)
      expect(listed[0]?.to).toBe(dest)
    })

    it('refuses to overwrite a recorded copy that has since grown a .git directory (does not delete it)', async () => {
      const { addLink } = await loadModule()
      await seedSkill('recordedthengit')
      const { record } = await addLink({
        skillId: 'recordedthengit',
        fromClient: 'claude-code',
        toClient: 'cursor',
      })
      // The recorded copy later becomes a real git working tree.
      await mkdir(path.join(record.to, '.git'), { recursive: true })
      await writeFile(path.join(record.to, 'my-work.md'), 'do not delete me\n', 'utf-8')

      await expect(
        addLink({
          skillId: 'recordedthengit',
          fromClient: 'claude-code',
          toClient: 'cursor',
          force: true,
        })
      ).rejects.toThrow(/recorded Skillsmith fan-out copy but now contains a \.git directory/)

      // Untouched.
      await expect(stat(path.join(record.to, '.git'))).resolves.toBeDefined()
      expect(await readFile(path.join(record.to, 'my-work.md'), 'utf-8')).toBe('do not delete me\n')
    })

    // SMI-6529 N7: a failure during the write phase (AFTER the recorded
    // copy was renamed aside) must restore the original content — never a
    // delete-then-write that could strand the user with neither the old NOR
    // the new copy. Mocks `node:fs/promises`' `copyFile` (module-scoped to
    // just this test, mirroring the existing "falls back to copy on EPERM"
    // test's own `vi.doMock('node:fs/promises', ...)` precedent above) to
    // fail partway through the replacement copy.
    it('restores the original recorded copy if the replacement write itself fails', async () => {
      const { addLink: addLinkForSetup } = await loadModule()
      await seedSkill('restoreonfail', { 'SKILL.md': '# original\n' })
      const first = await addLinkForSetup({
        skillId: 'restoreonfail',
        fromClient: 'claude-code',
        toClient: 'cursor',
      })
      expect(first.record.kind).toBe('copy')
      const dest = first.record.to

      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
        return {
          ...actual,
          default: actual,
          copyFile: vi.fn(async (src: string, destPath: string) => {
            if (destPath.toString().endsWith('SKILL.md')) {
              throw new Error('Simulated ENOSPC during replacement copy')
            }
            return actual.copyFile(src, destPath)
          }),
        }
      })
      try {
        // `fan-out.js` was already imported (and cached) above via
        // `loadModule()` for the setup call — without an explicit
        // `vi.resetModules()` here, this second `import()` would return
        // that SAME cached instance, bound to the real (unmocked)
        // `node:fs/promises`, and the doMock above would never take
        // effect. Mirrors the established EPERM-fallback test's precedent,
        // extended for the two-phase (real setup, then mocked) shape this
        // test needs.
        vi.resetModules()
        const { addLink } = await import('../../src/install/fan-out.js')
        await expect(
          addLink({
            skillId: 'restoreonfail',
            fromClient: 'claude-code',
            toClient: 'cursor',
            force: true,
          })
        ).rejects.toThrow(/Simulated ENOSPC/)

        // The ORIGINAL recorded copy is still in place at the original path —
        // never left gone, never left as a half-written new copy.
        expect(await readFile(path.join(dest, 'SKILL.md'), 'utf-8')).toBe('# original\n')
        // Round 6: the failed write left no staging or backup folder behind.
        const leftovers = (await readdir(path.dirname(dest))).filter(
          (name) => name.includes('skillsmith-backup-') || name.includes('skillsmith-staging-')
        )
        expect(leftovers).toEqual([])
      } finally {
        vi.doUnmock('node:fs/promises')
        vi.resetModules()
      }
    })
  })

  // SMI-6343 Wave 1 follow-up (adversarial review): saveManifest() here
  // writes `~/.skillsmith/links/manifest.json` — homedir-derived with no
  // path-override parameter, the same shape as the other three sibling
  // manifest writers. This file's own per-test $HOME override (beforeEach
  // above) already isolates every other test in this suite from the real
  // home; this test instead proves the NEW assertNotRealUserHome() guard
  // itself fires, by pointing SKILLSMITH_TEST_REAL_HOME at this test's own
  // (already-isolated) homeDir, tricking the guard into treating it as "the
  // real home" for one assertion.
  describe('SMI-6343: real-home write guard', () => {
    it('refuses to write when the link manifest resolves under the (simulated) real home', async () => {
      const { saveManifest } = await loadModule()

      const previous = process.env.SKILLSMITH_TEST_REAL_HOME
      process.env.SKILLSMITH_TEST_REAL_HOME = homeDir
      try {
        await expect(saveManifest({ version: 1, links: [] })).rejects.toThrow(/SMI-6343/)
      } finally {
        if (previous === undefined) delete process.env.SKILLSMITH_TEST_REAL_HOME
        else process.env.SKILLSMITH_TEST_REAL_HOME = previous
      }

      // The guard fired before any fs call — nothing was written.
      await expect(
        stat(path.join(homeDir, '.skillsmith', 'links', 'manifest.json'))
      ).rejects.toThrow(/ENOENT/)
    })
  })
})
