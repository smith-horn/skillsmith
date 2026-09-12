/**
 * @fileoverview writeInstallFiles() rollback-on-failure safety.
 * @see SMI-6529 Wave A0
 *
 * On a real user machine, a rollback in `writeInstallFiles` unconditionally
 * unlinked every file it had written on failure — including files that
 * ALREADY EXISTED before the install started (a real user's git-cloned
 * skill directory, `.git` included) — and, when the whole install path
 * pre-existed, could recursively force-delete that directory outright.
 * These tests prove the fix: a pre-existing file is restored to its
 * original bytes, and a pre-existing directory is never removed.
 */
import { describe, it, expect, vi } from 'vitest'
import * as fs from 'fs/promises'
import type { FileHandle } from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

// F1 (review round 1): `safeWriteFile` opens with O_TRUNC and writes in place —
// NOT atomic. A write that fails mid-way (ENOSPC/EIO after truncation) must
// leave a snapshot the rollback can restore from. `truncateThenThrowTarget` lets
// one specific test target ONE specific file path with this exact failure mode.
//
// F3 (review round 1): `delayTarget` lets one specific test delay ONE specific
// file's write by N ms before delegating to the real implementation, so a
// sibling's immediate failure and this write's completion can be raced
// deterministically.
//
// Every other call (every other test in this file) passes through to the real
// implementation unchanged — neither hook fires unless a test explicitly sets it.
const truncateThenThrowTarget = vi.hoisted(() => ({ path: null as string | null }))
const delayTarget = vi.hoisted(() => ({ path: null as string | null, ms: 0 }))
// SMI-6529 N2 (round 4): fails EVERY call to safeWriteFile for this exact
// path once (`armed`), then behaves normally — lets a test force the FIRST
// queued write for a shared key to fail outright (simulating an
// ExclusiveCreateRaceError / snapshot EACCES) while a second queued write
// (chained after via `previous.catch(() => {})`) still runs for real.
const failOnceTarget = vi.hoisted(() => ({ path: null as string | null, armed: false }))
// SMI-6529 N3 (round 4): when active, simulates an fd wrapper that reports a
// successful write while only actually committing `data.length - 1` bytes to
// disk — proves restoreSnapshots()'s own post-write size verification (not
// just writeFullBuffer's retry loop) catches an incomplete restore.
const shortRestoreTarget = vi.hoisted(() => ({ active: false }))
// SMI-6529 N9 (round 4): one-shot — the NEXT call to safeCreateFile for this
// exact path genuinely exclusive-creates the file (real O_EXCL open, real
// onCreated() fire) then throws BEFORE writing any content byte, simulating
// a write that fails immediately after the create succeeds (e.g. ENOSPC on
// the first write() call).
const createFailAfterOpenTarget = vi.hoisted(() => ({ path: null as string | null }))
// SMI-6529 N8 (round 4): one-shot — the NEXT non-recursive `fs.mkdir(p)` call
// for this exact path (io.write.ts's own final-segment installPath mkdir)
// simulates a concurrent installer WINNING the race: it really creates the
// directory, then throws EEXIST, matching the exact race io.write.ts's own
// `preExisted = true` flip must survive without rollback ever touching it.
const mkdirRaceTarget = vi.hoisted(() => ({ path: null as string | null, armed: false }))
// SMI-6529 R5 (round 5): one-shot — the NEXT call to safeCreateFile for this
// exact path really creates the file and reports its (dev, ino), then
// "another process" renames its own file over it and the write throws. The
// rollback must leave that other process's file alone.
const replaceAfterCreateTarget = vi.hoisted(() => ({ path: null as string | null }))
// SMI-6529 round 13 (cross-model review): one-shot — the NEXT safeCreateFile
// for this path first has "another process" move the fresh install directory
// away and put its own directory there, then the write throws. Rollback must
// leave that directory alone.
const swapInstallDirTarget = vi.hoisted(() => ({
  path: null as string | null,
  installPath: null as string | null,
}))
// SMI-6529 round 13: one-shot — the NEXT fs.unlink of this path fails with
// EACCES, so rollback can't remove a file it created.
const unlinkFailTarget = vi.hoisted(() => ({ path: null as string | null }))
// SMI-6529 round 25 (cross-model review): one-shot — the NEXT fs.lstat of this
// path fails with EACCES, so rollback cannot tell whether the file it created
// is still the one at that path. It is armed by `armLstatFailOnWrite` rather
// than set directly, because `safeCreateFile` lstats a path before creating it
// and would otherwise consume the one-shot during the write, long before the
// rollback this exists to test.
const lstatFailTarget = vi.hoisted(() => ({ path: null as string | null }))
// Arms `lstatFailTarget` when `trigger`'s write begins — the write that then
// fails for real, so the only lstat left to fire on is rollback's own.
const armLstatFailOnWrite = vi.hoisted(() => ({
  trigger: null as string | null,
  target: null as string | null,
}))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    mkdir: async (
      p: Parameters<typeof actual.mkdir>[0],
      opts?: Parameters<typeof actual.mkdir>[1]
    ): ReturnType<typeof actual.mkdir> => {
      const isNonRecursive = !(
        opts &&
        typeof opts === 'object' &&
        (opts as { recursive?: boolean }).recursive
      )
      if (p === mkdirRaceTarget.path && mkdirRaceTarget.armed && isNonRecursive) {
        mkdirRaceTarget.armed = false
        // The "concurrent installer" really creates it, right now.
        await actual.mkdir(p, { recursive: true })
        const err = new Error(
          `EEXIST: file already exists, mkdir '${String(p)}'`
        ) as NodeJS.ErrnoException
        err.code = 'EEXIST'
        throw err
      }
      return actual.mkdir(p, opts)
    },
    unlink: async (p: Parameters<typeof actual.unlink>[0]): ReturnType<typeof actual.unlink> => {
      if (p === unlinkFailTarget.path) {
        unlinkFailTarget.path = null
        const err = new Error(
          `EACCES: permission denied, unlink '${String(p)}'`
        ) as NodeJS.ErrnoException
        err.code = 'EACCES'
        throw err
      }
      return actual.unlink(p)
    },
    lstat: async (p: Parameters<typeof actual.lstat>[0]) => {
      if (p === lstatFailTarget.path) {
        lstatFailTarget.path = null
        const err = new Error(
          `EACCES: permission denied, lstat '${String(p)}'`
        ) as NodeJS.ErrnoException
        err.code = 'EACCES'
        throw err
      }
      return actual.lstat(p)
    },
  }
})

vi.mock('../../../src/utils/safe-fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/safe-fs.js')>()
  return {
    ...actual,
    safeCreateFile: async (
      filePath: string,
      content: string | Buffer,
      options?: Parameters<typeof actual.safeCreateFile>[2],
      onCreated?: (identity?: { dev: number; ino: number }) => void
    ): Promise<void> => {
      if (filePath === swapInstallDirTarget.path && swapInstallDirTarget.installPath) {
        const installPath = swapInstallDirTarget.installPath
        swapInstallDirTarget.path = null
        swapInstallDirTarget.installPath = null
        const real = await vi.importActual<typeof import('fs/promises')>('fs/promises')
        await real.rename(installPath, `${installPath}.moved`)
        await real.mkdir(installPath)
        await real.writeFile(`${installPath}/KEEP.md`, 'not the install')
        throw new Error('Simulated failure after another process replaced the install directory')
      }
      if (filePath === replaceAfterCreateTarget.path) {
        replaceAfterCreateTarget.path = null
        const real = await vi.importActual<typeof import('fs/promises')>('fs/promises')
        const fd = await real.open(
          filePath,
          real.constants.O_WRONLY | real.constants.O_CREAT | real.constants.O_EXCL,
          0o644
        )
        const created = await fd.stat()
        onCreated?.({ dev: created.dev, ino: created.ino })
        await fd.close()
        const theirs = filePath + '.theirs'
        await real.writeFile(theirs, 'ANOTHER PROCESS FILE')
        await real.rename(theirs, filePath)
        throw new Error('Simulated failure after another process replaced the file (R5)')
      }
      if (filePath === createFailAfterOpenTarget.path) {
        createFailAfterOpenTarget.path = null
        const { open, constants } =
          await vi.importActual<typeof import('fs/promises')>('fs/promises')
        const fd = await open(
          filePath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o644
        )
        onCreated?.()
        await fd.close()
        throw new Error('Simulated failure after exclusive create (N9)')
      }
      return actual.safeCreateFile(filePath, content, options, onCreated)
    },
    safeWriteFile: async (
      filePath: string,
      content: string | Buffer,
      options?: Parameters<typeof actual.safeWriteFile>[2]
    ): Promise<void> => {
      if (filePath === armLstatFailOnWrite.trigger) {
        armLstatFailOnWrite.trigger = null
        lstatFailTarget.path = armLstatFailOnWrite.target
      }
      if (filePath === truncateThenThrowTarget.path) {
        // Simulate safeWriteFile's own O_TRUNC truncating the file to empty,
        // then the write itself failing (e.g. ENOSPC/EIO) before any new
        // bytes land — the exact non-atomic failure mode F1 exists to survive.
        await fs.writeFile(filePath, '')
        throw new Error('Simulated ENOSPC after truncation')
      }
      if (filePath === failOnceTarget.path && failOnceTarget.armed) {
        failOnceTarget.armed = false
        throw new Error('Simulated write failure (N2: first write for this key fails)')
      }
      if (filePath === delayTarget.path) {
        await new Promise((resolve) => setTimeout(resolve, delayTarget.ms))
      }
      return actual.safeWriteFile(filePath, content, options)
    },
    // SMI-6529 N3 (round 4): only `skill-installation.io.rollback.ts`'s
    // `restoreSnapshots()` imports `writeFullBuffer` directly — `io.write.ts`
    // (this file's `writeInstallFiles` under test) only ever imports
    // `safeWriteFile`/`safeCreateFile`, so this override is isolated to the
    // restore path and never affects the writes above.
    writeFullBuffer: async (
      fd: FileHandle,
      data: Buffer,
      position: number | null = null
    ): Promise<void> => {
      if (shortRestoreTarget.active) {
        const truncated = data.subarray(0, Math.max(0, data.length - 1))
        await actual.writeFullBuffer(fd, truncated, position)
        return
      }
      return actual.writeFullBuffer(fd, data, position)
    },
  }
})

import { writeInstallFiles } from '../../../src/services/skill-installation.io.js'
import { InstallRestoreError } from '../../../src/services/skill-installation.io.rollback.js'

describe('writeInstallFiles rollback-on-failure (SMI-6529)', () => {
  it('restores a pre-existing SKILL.md to its ORIGINAL bytes and leaves .git/an unrelated file/the directory itself intact, when a later sub-skill write fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wif-rollback-preexist-'))
    try {
      const skillsDir = path.join(root, 'skills')
      await fs.mkdir(skillsDir, { recursive: true })
      const installPath = path.join(skillsDir, 'my-skill')
      await fs.mkdir(installPath, { recursive: true })

      const originalSkillMd = '# Original skill content — must survive'
      const skillMdPath = path.join(installPath, 'SKILL.md')
      await fs.writeFile(skillMdPath, originalSkillMd)

      const unrelatedPath = path.join(installPath, 'notes.txt')
      const unrelatedContent = "the user's own notes — must survive untouched"
      await fs.writeFile(unrelatedPath, unrelatedContent)

      await fs.mkdir(path.join(installPath, '.git'), { recursive: true })
      await fs.writeFile(path.join(installPath, '.git', 'HEAD'), 'ref: refs/heads/main\n')

      // Force a write failure on a LATER file: plant the sub-skill's target
      // filename as a pre-existing symlink — safeWriteFile's own O_NOFOLLOW
      // open() refuses it (SymlinkError) before touching a byte, exactly the
      // reachable, non-mocked failure mode skill-installation.io.symlink
      // .test.ts already exercises for a different call site.
      const examplesPath = path.join(installPath, 'examples.md')
      await fs.symlink('/nonexistent-target', examplesPath)

      await expect(
        writeInstallFiles(
          installPath,
          skillsDir,
          'my-skill',
          '# NEW content that must NOT survive',
          [{ filename: 'examples.md', content: 'malicious or just unlucky new content' }],
          undefined
        )
      ).rejects.toThrow(/symlink/i)

      // The directory itself was never removed — it pre-existed this call.
      const stats = await fs.lstat(installPath)
      expect(stats.isDirectory()).toBe(true)

      // SKILL.md restored to its ORIGINAL bytes, not the new content.
      expect(await fs.readFile(skillMdPath, 'utf8')).toBe(originalSkillMd)

      // .git and the unrelated user file were never touched.
      expect(await fs.readFile(path.join(installPath, '.git', 'HEAD'), 'utf8')).toBe(
        'ref: refs/heads/main\n'
      )
      expect(await fs.readFile(unrelatedPath, 'utf8')).toBe(unrelatedContent)
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('restores the ORIGINAL file mode along with its bytes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wif-rollback-mode-'))
    try {
      const skillsDir = path.join(root, 'skills')
      await fs.mkdir(skillsDir, { recursive: true })
      const installPath = path.join(skillsDir, 'my-skill')
      await fs.mkdir(installPath, { recursive: true })

      const skillMdPath = path.join(installPath, 'SKILL.md')
      await fs.writeFile(skillMdPath, '# original', { mode: 0o600 })

      const examplesPath = path.join(installPath, 'examples.md')
      await fs.symlink('/nonexistent-target', examplesPath)

      await expect(
        writeInstallFiles(
          installPath,
          skillsDir,
          'my-skill',
          '# new content',
          [{ filename: 'examples.md', content: 'x' }],
          undefined
        )
      ).rejects.toThrow(/symlink/i)

      const stat = await fs.stat(skillMdPath)
      // 0o600 -> only owner read/write; mask off the file-type bits.
      expect(stat.mode & 0o777).toBe(0o600)
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('removes a FRESHLY CREATED (did not pre-exist) install directory on failure — old behavior preserved', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wif-rollback-fresh-'))
    try {
      const skillsDir = path.join(root, 'skills')
      await fs.mkdir(skillsDir, { recursive: true })
      // installPath is deliberately NEVER pre-created — writeInstallFiles
      // itself creates it fresh via fs.mkdir(installPath, {recursive:true}).
      const installPath = path.join(skillsDir, 'my-skill')

      // Force a LATE failure (after installPath is freshly created, before
      // any content lands) via `createFailAfterOpenTarget` (defined above
      // for N9): SMI-6529 N11 (round 4) made a symlinked COMPANION-agent
      // path — this test's original failure trigger — no longer throw on a
      // fresh install (it's now correctly SKIPPED, `companionSkipped`), so
      // this test (whose actual point is installPath removal on ANY
      // failure, not the companion agent specifically) now forces the
      // SKILL.md write itself to fail right after its own exclusive create.
      const mainSkillPath = path.join(installPath, 'SKILL.md')
      createFailAfterOpenTarget.path = mainSkillPath

      try {
        await expect(
          writeInstallFiles(installPath, skillsDir, 'my-skill', '# hello', [], undefined)
        ).rejects.toThrow(/Simulated failure after exclusive create/)
      } finally {
        createFailAfterOpenTarget.path = null
      }

      // installPath pre-existed NOTHING before this call — the old
      // (pre-SMI-6529) AND new behavior agree it must be fully removed.
      await expect(fs.access(installPath)).rejects.toThrow()
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  // F1 (review round 1): the snapshot must be taken BEFORE safeWriteFile is
  // ever called, never after it "succeeds" — a write that truncates the file
  // then throws mid-write must still be recoverable.
  it('F1: restores original bytes when a write truncates the file then throws mid-write (non-atomic O_TRUNC failure)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wif-f1-truncate-'))
    try {
      const skillsDir = path.join(root, 'skills')
      await fs.mkdir(skillsDir, { recursive: true })
      const installPath = path.join(skillsDir, 'my-skill')
      await fs.mkdir(installPath, { recursive: true })

      const skillMdPath = path.join(installPath, 'SKILL.md')
      const originalContent = '# Original — must survive a truncate-then-throw write'
      await fs.writeFile(skillMdPath, originalContent)
      truncateThenThrowTarget.path = skillMdPath

      await expect(
        writeInstallFiles(installPath, skillsDir, 'my-skill', '# new content', [], undefined)
      ).rejects.toThrow('Simulated ENOSPC')

      // Confirm the mock actually truncated it first (proving the failure mode
      // is the one F1 targets, not a no-op mock).
      expect(await fs.readFile(skillMdPath, 'utf8')).toBe(originalContent)
    } finally {
      truncateThenThrowTarget.path = null
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  // F3 (review round 1): Promise.all rejects on the FIRST failure while
  // sibling writes are still in flight — a slow sibling that finishes AFTER
  // rollback ran would never get its own overwrite restored. Promise
  // .allSettled must wait for every write to finish before rollback runs.
  it('F3: a delayed sibling sub-skill write that overwrites an existing file is still restored after a sibling fails immediately', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wif-f3-race-'))
    try {
      const skillsDir = path.join(root, 'skills')
      await fs.mkdir(skillsDir, { recursive: true })
      const installPath = path.join(skillsDir, 'my-skill')
      await fs.mkdir(installPath, { recursive: true })

      const delayedPath = path.join(installPath, 'delayed.md')
      const originalDelayedContent = '# Original delayed content — must survive'
      await fs.writeFile(delayedPath, originalDelayedContent)

      const failFastPath = path.join(installPath, 'fail-fast.md')
      await fs.symlink('/nonexistent-target', failFastPath) // fails immediately, no delay

      // Delay ONLY the write to delayedPath so it lands strictly after
      // fail-fast.md's write has already rejected.
      delayTarget.path = delayedPath
      delayTarget.ms = 50

      try {
        await expect(
          writeInstallFiles(
            installPath,
            skillsDir,
            'my-skill',
            '# hello',
            [
              { filename: 'fail-fast.md', content: 'irrelevant — write refused as a symlink' },
              { filename: 'delayed.md', content: 'new delayed content that must NOT survive' },
            ],
            undefined
          )
        ).rejects.toThrow(/symlink/i)

        // Under the OLD Promise.all-based bug, writeInstallFiles' own promise
        // rejects (and rollback runs) as soon as fail-fast.md rejects — LONG
        // before the delayed write's background completion at +50ms, which
        // then clobbers the just-restored file with no second rollback pass
        // to catch it. Wait well past that window before asserting, so this
        // test can actually tell the two implementations apart (asserting
        // immediately after the rejection would pass even under the bug,
        // since the clobbering write hasn't happened yet at that instant).
        await new Promise((resolve) => setTimeout(resolve, 150))

        expect(await fs.readFile(delayedPath, 'utf8')).toBe(originalDelayedContent)
      } finally {
        delayTarget.path = null
        delayTarget.ms = 0
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  // F4 (review round 1): a nested sub-skill directory created FRESH inside a
  // PRE-EXISTING installPath must be removed on rollback (non-recursively,
  // deepest first) — it must not be left behind just because installPath
  // itself is never removed.
  it('F4: removes freshly-created nested sub-skill directories on rollback, deepest first, while the pre-existing installPath survives', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wif-f4-nested-'))
    try {
      const skillsDir = path.join(root, 'skills')
      await fs.mkdir(skillsDir, { recursive: true })
      const installPath = path.join(skillsDir, 'my-skill')
      // installPath PRE-EXISTS — the case that matters: a fresh install's
      // whole directory gets recursively removed regardless (already covered
      // above), so this test isolates the pre-existing-directory path.
      await fs.mkdir(installPath, { recursive: true })
      const unrelatedPath = path.join(installPath, 'unrelated.txt')
      await fs.writeFile(unrelatedPath, 'must survive')

      // A pre-existing symlink forces a failure on a LATER sub-skill write,
      // after the nested "scripts/nested/" directories have already been
      // created fresh for an EARLIER one.
      const failPath = path.join(installPath, 'fail.md')
      await fs.symlink('/nonexistent-target', failPath)

      await expect(
        writeInstallFiles(
          installPath,
          skillsDir,
          'my-skill',
          '# hello',
          [
            { filename: 'scripts/nested/foo.sh', content: 'echo hi' },
            { filename: 'fail.md', content: 'never written — symlink refused' },
          ],
          undefined
        )
      ).rejects.toThrow(/symlink/i)

      // The freshly-created nested directories are gone...
      await expect(fs.access(path.join(installPath, 'scripts', 'nested'))).rejects.toThrow()
      await expect(fs.access(path.join(installPath, 'scripts'))).rejects.toThrow()
      // ...and so is the file created fresh inside them...
      await expect(
        fs.access(path.join(installPath, 'scripts', 'nested', 'foo.sh'))
      ).rejects.toThrow()
      // ...but installPath itself (pre-existing) and its unrelated content survive.
      const stats = await fs.lstat(installPath)
      expect(stats.isDirectory()).toBe(true)
      expect(await fs.readFile(unrelatedPath, 'utf8')).toBe('must survive')
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  // SMI-6529 M4 (round 2, reviewer probe-write.mjs W2): a literal-string
  // duplicate ("examples.md" and "./examples.md" both resolve to the same
  // path) must never let the SECOND write's classification race ahead of
  // the FIRST's and capture an intermediate (already-overwritten) state as
  // if it were the true original.
  it('M4: two sub-skill keys normalizing to the same path restore to the TRUE original, not an intermediate state', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wif-m4-dup-path-'))
    try {
      const skillsDir = path.join(root, 'skills')
      await fs.mkdir(skillsDir, { recursive: true })
      const installPath = path.join(skillsDir, 'my-skill')
      await fs.mkdir(installPath, { recursive: true })
      const examplesPath = path.join(installPath, 'examples.md')
      await fs.writeFile(examplesPath, 'ORIGINAL')

      const failPath = path.join(installPath, 'zfail.md')
      await fs.symlink('/nonexistent-target', failPath)

      await expect(
        writeInstallFiles(
          installPath,
          skillsDir,
          'my-skill',
          '# hello',
          [
            { filename: 'examples.md', content: 'NEW-A' },
            { filename: './examples.md', content: 'NEW-B' },
            { filename: 'zfail.md', content: 'never written' },
          ],
          undefined
        )
      ).rejects.toThrow(/symlink/i)

      expect(await fs.readFile(examplesPath, 'utf8')).toBe('ORIGINAL')
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  // SMI-6529 N1 (round 4, reviewer probe-linux-case.mjs): the round-2 "only
  // the FIRST occurrence for a queue key classifies" optimization was itself
  // broken on a case-SENSITIVE filesystem (Linux/CI) — `README.md` and
  // `readme.md` share the same lowercased queue key there too, even though
  // they are genuinely TWO DIFFERENT files; the second was silently
  // overwritten with NO snapshot at all. This test — unlike its round-2
  // predecessor above (kept for the M4 exact-duplicate/./-prefixed-duplicate
  // scenario, which is unaffected by N1) — NEVER early-returns: it detects
  // aliasing at runtime and asserts the correct outcome either way. On a
  // case-sensitive filesystem (the container/CI) it proves the exact
  // "two differently-cased files, both restored" scenario N1 requires; on a
  // case-insensitive filesystem it proves the aliased pair still converges
  // to the single TRUE original (reviewer measured NFC/NFD and σ/ς aliasing
  // 450/450 with the fixed approach, probe-unicode.mjs).
  it('N1: two differently-cased sub-skill filenames each restore to their OWN true original on a case-sensitive filesystem, or converge to the true original on a case-insensitive alias', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wif-n1-case-'))
    try {
      const skillsDir = path.join(root, 'skills')
      await fs.mkdir(skillsDir, { recursive: true })
      const installPath = path.join(skillsDir, 'my-skill')
      await fs.mkdir(installPath, { recursive: true })

      const upperPath = path.join(installPath, 'README.md')
      await fs.writeFile(upperPath, 'ORIGINAL-UPPER')

      const lowerPath = path.join(installPath, 'readme.md')
      const isAliased = await fs
        .lstat(lowerPath)
        .then(() => true)
        .catch(() => false)
      if (!isAliased) {
        // Genuinely two distinct files on this (case-sensitive) filesystem —
        // give the second one its OWN distinct original content.
        await fs.writeFile(lowerPath, 'ORIGINAL-LOWER')
      }

      const failPath = path.join(installPath, 'zfail.md')
      await fs.symlink('/nonexistent-target', failPath)

      await expect(
        writeInstallFiles(
          installPath,
          skillsDir,
          'my-skill',
          '# hello',
          [
            { filename: 'README.md', content: 'NEW-UPPER' },
            { filename: 'readme.md', content: 'NEW-LOWER' },
            { filename: 'zfail.md', content: 'never written' },
          ],
          undefined
        )
      ).rejects.toThrow(/symlink/i)

      if (isAliased) {
        // Single real file — must converge to the TRUE original regardless
        // of how many aliasing writes hit it along the way.
        expect(await fs.readFile(upperPath, 'utf8')).toBe('ORIGINAL-UPPER')
      } else {
        // Two genuinely distinct real files — EACH must independently
        // restore to its OWN original, not be lost or swapped.
        expect(await fs.readFile(upperPath, 'utf8')).toBe('ORIGINAL-UPPER')
        expect(await fs.readFile(lowerPath, 'utf8')).toBe('ORIGINAL-LOWER')
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  // SMI-6529 N2 (round 4, reviewer probe-queue.mjs): a queued write whose
  // PREDECESSOR (same lowercased key) already failed must still be
  // independently classified and snapshotted — the queue chain's
  // `previous.catch(() => {})` only swallows the earlier failure so the
  // CHAIN doesn't break, it must never skip the later write's own
  // classification. Forces the FIRST queued write (`README.md`, processed
  // first in array order) to fail outright, then proves the SECOND
  // (`readme.md`, a genuinely different real file on a case-sensitive
  // filesystem sharing the same lowercased queue key) still restores to its
  // own true original.
  it('N2: a queued write whose predecessor (same queue key) failed is still independently snapshotted and restored', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wif-n2-firstfails-'))
    try {
      const skillsDir = path.join(root, 'skills')
      await fs.mkdir(skillsDir, { recursive: true })
      const installPath = path.join(skillsDir, 'my-skill')
      await fs.mkdir(installPath, { recursive: true })

      const upperPath = path.join(installPath, 'README.md')
      await fs.writeFile(upperPath, 'ORIGINAL-UPPER')

      const lowerPath = path.join(installPath, 'readme.md')
      const isAliased = await fs
        .lstat(lowerPath)
        .then(() => true)
        .catch(() => false)
      if (!isAliased) {
        await fs.writeFile(lowerPath, 'ORIGINAL-LOWER')
      }

      // Force the FIRST write (README.md) to fail outright — simulating an
      // ExclusiveCreateRaceError / snapshot EACCES on the predecessor.
      failOnceTarget.path = upperPath
      failOnceTarget.armed = true

      try {
        await expect(
          writeInstallFiles(
            installPath,
            skillsDir,
            'my-skill',
            '# hello',
            [
              { filename: 'README.md', content: 'NEW-UPPER' },
              { filename: 'readme.md', content: 'NEW-LOWER' },
            ],
            undefined
          )
        ).rejects.toThrow(/Simulated write failure/)

        if (isAliased) {
          expect(await fs.readFile(upperPath, 'utf8')).toBe('ORIGINAL-UPPER')
        } else {
          // The SECOND write must have been independently classified and
          // snapshotted DESPITE the first write's failure — restoring
          // correctly to its OWN true original, not left as the
          // unsnapshotted 'NEW-LOWER'.
          expect(await fs.readFile(upperPath, 'utf8')).toBe('ORIGINAL-UPPER')
          expect(await fs.readFile(lowerPath, 'utf8')).toBe('ORIGINAL-LOWER')
        }
      } finally {
        failOnceTarget.path = null
        failOnceTarget.armed = false
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  // SMI-6529 N3 (round 4, reviewer probe-short-write.mjs): restoreSnapshots()
  // must verify the FINAL on-disk size against the snapshot length, not just
  // trust that writeFullBuffer's own retry loop "resolved without throwing."
  // Simulates an fd wrapper that silently commits ONE BYTE FEWER than
  // requested while still resolving normally (the measured live hazard:
  // `FileHandle.write()` can short-write without throwing) and asserts the
  // restore is reported as a FAILURE, never as a clean restore.
  it('N3: restoreSnapshots reports a failure when the final on-disk size does not match the snapshot (short-write defense-in-depth)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wif-n3-shortrestore-'))
    try {
      const skillsDir = path.join(root, 'skills')
      await fs.mkdir(skillsDir, { recursive: true })
      const installPath = path.join(skillsDir, 'my-skill')
      await fs.mkdir(installPath, { recursive: true })
      const skillMdPath = path.join(installPath, 'SKILL.md')
      const originalContent = '# ORIGINAL CONTENT THAT MUST BE FULLY RESTORED'
      await fs.writeFile(skillMdPath, originalContent)

      const result = await writeInstallFiles(
        installPath,
        skillsDir,
        'my-skill',
        '# NEW CONTENT',
        [],
        undefined
      )
      expect(await fs.readFile(skillMdPath, 'utf8')).toBe('# NEW CONTENT')

      shortRestoreTarget.active = true
      try {
        const causeError = new Error('simulated later-step failure')
        await expect(result.rollback(causeError)).rejects.toThrow(InstallRestoreError)
        await expect(result.rollback(causeError)).rejects.toThrow(
          /could not restore 1 pre-existing/
        )
      } finally {
        shortRestoreTarget.active = false
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  // SMI-6529 M7 (round 2): writeInstallFiles() returns a `rollback()` closure
  // so a caller whose LATER step fails (after the write itself succeeded)
  // can undo it via the SAME logic the internal catch block uses.
  describe('M7: rollback() closure', () => {
    it('removes a FRESH install directory when rollback() is invoked after success', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wif-m7-fresh-'))
      try {
        const skillsDir = path.join(root, 'skills')
        await fs.mkdir(skillsDir, { recursive: true })
        const installPath = path.join(skillsDir, 'my-skill') // never pre-created

        const result = await writeInstallFiles(
          installPath,
          skillsDir,
          'my-skill',
          '# hello',
          [],
          undefined
        )
        expect(await fs.readFile(path.join(installPath, 'SKILL.md'), 'utf8')).toBe('# hello')

        // Simulate a LATER step failing (e.g. the manifest update) after the
        // write itself already succeeded.
        await result.rollback(new Error('simulated manifest-update failure'))

        await expect(fs.access(installPath)).rejects.toThrow()
      } finally {
        await fs.rm(root, { recursive: true, force: true }).catch(() => {})
      }
    })

    it("restores a FORCED REINSTALL's pre-existing files when rollback() is invoked after success", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wif-m7-forced-'))
      try {
        const skillsDir = path.join(root, 'skills')
        await fs.mkdir(skillsDir, { recursive: true })
        const installPath = path.join(skillsDir, 'my-skill')
        await fs.mkdir(installPath, { recursive: true })
        const skillMdPath = path.join(installPath, 'SKILL.md')
        await fs.writeFile(skillMdPath, '# ORIGINAL', { mode: 0o600 })
        const unrelatedPath = path.join(installPath, 'notes.txt')
        await fs.writeFile(unrelatedPath, 'user notes')

        const result = await writeInstallFiles(
          installPath,
          skillsDir,
          'my-skill',
          '# NEW CONTENT',
          [],
          undefined
        )
        expect(await fs.readFile(skillMdPath, 'utf8')).toBe('# NEW CONTENT')

        await result.rollback(new Error('simulated manifest-update failure'))

        // Restored to the ORIGINAL content/mode; the directory itself and
        // unrelated content survive (it pre-existed this call).
        expect(await fs.readFile(skillMdPath, 'utf8')).toBe('# ORIGINAL')
        const stat = await fs.stat(skillMdPath)
        expect(stat.mode & 0o777).toBe(0o600)
        expect(await fs.readFile(unrelatedPath, 'utf8')).toBe('user notes')
        await expect(fs.access(installPath)).resolves.toBeUndefined()
      } finally {
        await fs.rm(root, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('throws InstallRestoreError (naming the cause) when the restore itself also fails', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wif-m7-restore-fail-'))
      try {
        const skillsDir = path.join(root, 'skills')
        await fs.mkdir(skillsDir, { recursive: true })
        const installPath = path.join(skillsDir, 'my-skill')
        await fs.mkdir(installPath, { recursive: true })
        const skillMdPath = path.join(installPath, 'SKILL.md')
        await fs.writeFile(skillMdPath, '# ORIGINAL')

        const result = await writeInstallFiles(
          installPath,
          skillsDir,
          'my-skill',
          '# NEW CONTENT',
          [],
          undefined
        )

        // Sabotage the restore: replace SKILL.md with a symlink between the
        // successful write and the rollback call — restoreSnapshots' own
        // O_NOFOLLOW refuses to write through it (F2, round 1), so this
        // specific restore fails.
        await fs.unlink(skillMdPath)
        await fs.symlink('/nonexistent-target', skillMdPath)

        const causeError = new Error('simulated manifest-update failure')
        await expect(result.rollback(causeError)).rejects.toThrow(InstallRestoreError)
        await expect(result.rollback(causeError)).rejects.toThrow(
          /simulated manifest-update failure/
        )
        await expect(result.rollback(causeError)).rejects.toThrow(
          /could not restore 1 pre-existing/
        )
      } finally {
        await fs.rm(root, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  // SMI-6529 M10 (round 2): a companion agent file already occupying the
  // target path must never be silently overwritten by a FRESH install, but
  // a forced reinstall of an already-tracked skill still overwrites it.
  describe('M10: companion-agent-file overwrite policy', () => {
    it('FRESH install: skips an existing companion file and reports companionSkipped', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wif-m10-fresh-'))
      try {
        const skillsDir = path.join(root, 'skills')
        await fs.mkdir(skillsDir, { recursive: true })
        const installPath = path.join(skillsDir, 'my-skill') // fresh — never pre-created
        const companionBaseDir = path.join(root, 'project')
        // Antigravity's directory-package mode fully redirects via
        // companionBaseDir (claude-code's own 'flat' mode is always
        // homedir()-anchored and can't be redirected — see paths.ts).
        const agentPath = path.join(companionBaseDir, '.agents', 'agents', 'my-skill', 'agent.md')
        await fs.mkdir(path.dirname(agentPath), { recursive: true })
        await fs.writeFile(agentPath, 'unrelated pre-existing agent content')

        const result = await writeInstallFiles(
          installPath,
          skillsDir,
          'my-skill',
          '# hello',
          [],
          '---\nname: my-skill-specialist\n---\nbody',
          'antigravity',
          companionBaseDir
        )

        expect(result.companionSkipped).toBe(true)
        expect(result.subagentPath).toBeUndefined()
        expect(await fs.readFile(agentPath, 'utf8')).toBe('unrelated pre-existing agent content')
      } finally {
        await fs.rm(root, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('FORCED REINSTALL (preExisted): still overwrites an existing companion file', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wif-m10-forced-'))
      try {
        const skillsDir = path.join(root, 'skills')
        await fs.mkdir(skillsDir, { recursive: true })
        const installPath = path.join(skillsDir, 'my-skill')
        await fs.mkdir(installPath, { recursive: true }) // preExisted = true
        const companionBaseDir = path.join(root, 'project')
        const agentPath = path.join(companionBaseDir, '.agents', 'agents', 'my-skill', 'agent.md')
        await fs.mkdir(path.dirname(agentPath), { recursive: true })
        await fs.writeFile(agentPath, 'previously-generated agent content')

        const result = await writeInstallFiles(
          installPath,
          skillsDir,
          'my-skill',
          '# hello',
          [],
          '---\nname: my-skill-specialist\n---\nregenerated body',
          'antigravity',
          companionBaseDir
        )

        expect(result.companionSkipped).toBeFalsy()
        expect(result.subagentPath).toBe(agentPath)
        expect(await fs.readFile(agentPath, 'utf8')).toBe(
          '---\nname: my-skill-specialist\n---\nregenerated body'
        )
      } finally {
        await fs.rm(root, { recursive: true, force: true }).catch(() => {})
      }
    })

    // SMI-6529 N11 (round 4, reviewer probe-companion.mjs): the round-2 check
    // above only skipped a 'regular' pre-existing file — a SYMLINKED
    // companion path (e.g. a stale/planted link) fell to the `else` branch,
    // whose `writeTracked()` -> `safeWriteFile()` throws SymlinkError,
    // rolling back the ENTIRE install (SKILL.md, every sub-skill) over an
    // unrelated pre-existing symlink at a completely different path. A fresh
    // install must skip ('other' or 'regular') exactly the same way.
    it('N11: FRESH install skips a SYMLINKED companion-agent path too — no SymlinkError, no whole-install rollback', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wif-n11-symlink-companion-'))
      try {
        const skillsDir = path.join(root, 'skills')
        await fs.mkdir(skillsDir, { recursive: true })
        const installPath = path.join(skillsDir, 'my-skill') // fresh — never pre-created
        const companionBaseDir = path.join(root, 'project')
        const agentPath = path.join(companionBaseDir, '.agents', 'agents', 'my-skill', 'agent.md')
        await fs.mkdir(path.dirname(agentPath), { recursive: true })
        await fs.symlink('/nonexistent-target', agentPath)

        const result = await writeInstallFiles(
          installPath,
          skillsDir,
          'my-skill',
          '# hello',
          [],
          '---\nname: my-skill-specialist\n---\nbody',
          'antigravity',
          companionBaseDir
        )

        // Install succeeds — the symlinked companion is skipped, never
        // triggers a SymlinkError, never rolls back the (successful) SKILL.md
        // write.
        expect(result.companionSkipped).toBe(true)
        expect(result.subagentPath).toBeUndefined()
        expect(await fs.readFile(path.join(installPath, 'SKILL.md'), 'utf8')).toBe('# hello')
        const linkStat = await fs.lstat(agentPath)
        expect(linkStat.isSymbolicLink()).toBe(true)
      } finally {
        await fs.rm(root, { recursive: true, force: true }).catch(() => {})
      }
    })
  })

  // SMI-6529 L15 (round 2): the directory-package per-skill agent directory
  // is only ever rmdir'd on rollback if THIS call created it — a
  // pre-existing one must survive even if this call's own cleanup leaves it
  // empty.
  it("L15: a PRE-EXISTING directory-package agent dir is never rmdir'd on rollback, even once emptied", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wif-l15-preexist-agentdir-'))
    try {
      const skillsDir = path.join(root, 'skills')
      await fs.mkdir(skillsDir, { recursive: true })
      const installPath = path.join(skillsDir, 'my-skill')
      await fs.mkdir(installPath, { recursive: true }) // preExisted = true

      const companionBaseDir = path.join(root, 'project')
      // Antigravity's directory-package mode: <agentsDir>/<skillName>/agent.md.
      // Pre-create the per-skill directory itself (empty) to prove it survives.
      const agentDir = path.join(companionBaseDir, '.agents', 'agents', 'my-skill')
      await fs.mkdir(agentDir, { recursive: true })

      // Force a LATE failure via a pre-existing symlink at a SIBLING sub-skill
      // path so the agent.md write (which succeeds, since the dir was
      // otherwise empty) still gets rolled back afterward.
      const failPath = path.join(installPath, 'fail.md')
      await fs.symlink('/nonexistent-target', failPath)

      await expect(
        writeInstallFiles(
          installPath,
          skillsDir,
          'my-skill',
          '# hello',
          [{ filename: 'fail.md', content: 'never written' }],
          '---\nname: my-skill-specialist\n---\nbody',
          'antigravity',
          companionBaseDir
        )
      ).rejects.toThrow(/symlink/i)

      // agent.md itself was created fresh by this call and IS rolled back
      // (unlinked)...
      await expect(fs.access(path.join(agentDir, 'agent.md'))).rejects.toThrow()
      // ...but the per-skill directory it lived in PRE-EXISTED this call, so
      // it must survive even though it's now empty.
      const stat = await fs.lstat(agentDir)
      expect(stat.isDirectory()).toBe(true)
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  // SMI-6529 N8 (round 4, reviewer probe-mkdir-race.mjs): on the final-
  // segment mkdir EEXIST race — something ELSE creates `installPath` between
  // this call's own ENOENT `preExisted` check and its own non-recursive
  // `fs.mkdir(installPath)` — rollback must never touch the directory the
  // OTHER process created. Reviewer measured 299/300 races without the
  // `preExisted = true` flip having rollback `rmdir` the WINNER's freshly
  // -created directory out from under it.
  it("N8: an EEXIST race on the final mkdir segment never lets rollback remove the WINNER's directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wif-n8-mkdirrace-'))
    try {
      const skillsDir = path.join(root, 'skills')
      await fs.mkdir(skillsDir, { recursive: true })
      const installPath = path.join(skillsDir, 'my-skill') // never pre-created

      mkdirRaceTarget.path = installPath
      mkdirRaceTarget.armed = true

      try {
        await expect(
          writeInstallFiles(installPath, skillsDir, 'my-skill', '# hello', [], undefined)
        ).rejects.toThrow(/appeared during install \(race\)/)

        // The WINNER's directory (created by the mock's own real mkdir call
        // right before throwing EEXIST) must SURVIVE — rollback never owns
        // it, since this call did not create it.
        const stat = await fs.lstat(installPath)
        expect(stat.isDirectory()).toBe(true)
      } finally {
        mkdirRaceTarget.path = null
        mkdirRaceTarget.armed = false
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  // SMI-6529 N9 (round 4, reviewer probe-create-orphan.mjs): a write that
  // fails right AFTER the exclusive `open()` already created the file (but
  // before any content byte lands) must still get its 0-byte orphan unlinked
  // by rollback — the fresh-creation marker is now recorded the INSTANT
  // `open()` succeeds (via `onCreated`), not after the whole write resolves.
  it('N9: a write that fails right after the exclusive create still gets its 0-byte orphan unlinked by rollback', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wif-n9-orphan-'))
    try {
      const skillsDir = path.join(root, 'skills')
      await fs.mkdir(skillsDir, { recursive: true })
      const installPath = path.join(skillsDir, 'my-skill')
      await fs.mkdir(installPath, { recursive: true })

      const examplesPath = path.join(installPath, 'examples.md')
      createFailAfterOpenTarget.path = examplesPath

      try {
        await expect(
          writeInstallFiles(
            installPath,
            skillsDir,
            'my-skill',
            '# hello',
            [{ filename: 'examples.md', content: 'never fully written' }],
            undefined
          )
        ).rejects.toThrow(/Simulated failure after exclusive create/)

        // The 0-byte orphan created by the exclusive open() must be gone —
        // never left behind as an untracked, empty file.
        await expect(fs.access(examplesPath)).rejects.toThrow()
      } finally {
        createFailAfterOpenTarget.path = null
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  // SMI-6529 R5 (round 5): rollback unlinks a fresh file only while its path
  // still names the file this call created.
  it('R5: rollback never unlinks a fresh file that another process has since replaced', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wif-r5-identity-'))
    try {
      const skillsDir = path.join(root, 'skills')
      await fs.mkdir(skillsDir, { recursive: true })
      const installPath = path.join(skillsDir, 'my-skill')
      await fs.mkdir(installPath, { recursive: true })

      const examplesPath = path.join(installPath, 'examples.md')
      replaceAfterCreateTarget.path = examplesPath

      try {
        await expect(
          writeInstallFiles(
            installPath,
            skillsDir,
            'my-skill',
            '# hello',
            [{ filename: 'examples.md', content: 'ours' }],
            undefined
          )
        ).rejects.toThrow(/another process replaced the file/)

        expect(await fs.readFile(examplesPath, 'utf-8')).toBe('ANOTHER PROCESS FILE')
        // This call's own fresh SKILL.md is still rolled back.
        await expect(fs.access(path.join(installPath, 'SKILL.md'))).rejects.toThrow()
      } finally {
        replaceAfterCreateTarget.path = null
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  // SMI-6529 N12 (round 4, reviewer probe-companion2.mjs): a sub-skill
  // filename like "x/../../../escape.md" normalizes (via `path.join`, which
  // collapses ".." segments) to a path OUTSIDE `installPath` entirely.
  // `mkdirNoFollow()` alone only guards a pre-existing SYMLINK at an
  // intermediate segment — it does nothing to stop a purely lexical escape.
  it('N12: a sub-skill filename that lexically escapes installPath is refused and never written outside it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wif-n12-escape-'))
    try {
      const skillsDir = path.join(root, 'skills')
      await fs.mkdir(skillsDir, { recursive: true })
      const installPath = path.join(skillsDir, 'my-skill')
      await fs.mkdir(installPath, { recursive: true })

      await expect(
        writeInstallFiles(
          installPath,
          skillsDir,
          'my-skill',
          '# hello',
          [{ filename: 'x/../../../escape.md', content: 'malicious content' }],
          undefined
        )
      ).rejects.toThrow(/escapes install directory/)

      // path.join(installPath, 'x/../../../escape.md') normalizes to
      // path.dirname(skillsDir) + '/escape.md' — three levels up from
      // installPath/x. Never written there.
      await expect(fs.access(path.join(root, 'escape.md'))).rejects.toThrow()
      // installPath itself (pre-existing) survives untouched.
      const stat = await fs.lstat(installPath)
      expect(stat.isDirectory()).toBe(true)
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })
})

// SMI-6529 round 13 (cross-model review): rollback's recursive delete of a
// fresh install directory checks it is still the directory the install
// created, and a cleanup step that fails is reported, not swallowed.
describe('writeInstallFiles rollback cleanup is identity-checked and reported (SMI-6529 round 13)', () => {
  it('never removes a directory that replaced the fresh install directory before rollback', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wif-rollback-swapdir-'))
    try {
      const skillsDir = path.join(root, 'skills')
      await fs.mkdir(skillsDir, { recursive: true })
      const installPath = path.join(skillsDir, 'fresh-skill')
      swapInstallDirTarget.path = path.join(installPath, 'SKILL.md')
      swapInstallDirTarget.installPath = installPath

      const err = await writeInstallFiles(
        installPath,
        skillsDir,
        'fresh-skill',
        '# new content',
        [],
        undefined
      ).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(InstallRestoreError)
      expect((err as InstallRestoreError).cleanupFailures).toEqual([
        expect.stringContaining('replaced by something else'),
      ])
      expect(await fs.readFile(path.join(installPath, 'KEEP.md'), 'utf8')).toBe('not the install')
    } finally {
      swapInstallDirTarget.path = null
      swapInstallDirTarget.installPath = null
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('reports a file it created but could not remove, instead of swallowing the error', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wif-rollback-unlinkfail-'))
    try {
      const skillsDir = path.join(root, 'skills')
      const installPath = path.join(skillsDir, 'my-skill')
      await fs.mkdir(installPath, { recursive: true })
      await fs.writeFile(path.join(installPath, 'notes.txt'), 'user notes')
      // SKILL.md is absent, so the install creates it fresh; the symlinked
      // examples.md then makes the install fail and roll back.
      const skillMdPath = path.join(installPath, 'SKILL.md')
      await fs.symlink('/nonexistent-target', path.join(installPath, 'examples.md'))
      unlinkFailTarget.path = skillMdPath

      const err = await writeInstallFiles(
        installPath,
        skillsDir,
        'my-skill',
        '# new content',
        [{ filename: 'examples.md', content: 'x' }],
        undefined
      ).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(InstallRestoreError)
      const cleanup = (err as InstallRestoreError).cleanupFailures
      expect(cleanup).toEqual([expect.stringContaining(skillMdPath)])
      expect(cleanup[0]).toContain('EACCES')
      expect((err as Error).message).toMatch(/could not remove 1 path\(s\) it created/)
      expect(await fs.readFile(path.join(installPath, 'notes.txt'), 'utf8')).toBe('user notes')
    } finally {
      unlinkFailTarget.path = null
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  // SMI-6529 round 25 (cross-model review): the identity check skipped a path
  // on ANY lstat failure, treating "I could not tell what is here" as "it is
  // already gone" — so a rollback that left a file behind reported success.
  it('reports a file it created but could not identify, instead of counting it cleaned up', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wif-rollback-lstatfail-'))
    try {
      const skillsDir = path.join(root, 'skills')
      const installPath = path.join(skillsDir, 'my-skill')
      await fs.mkdir(installPath, { recursive: true })
      await fs.writeFile(path.join(installPath, 'notes.txt'), 'user notes')
      const skillMdPath = path.join(installPath, 'SKILL.md')
      const examplesPath = path.join(installPath, 'examples.md')
      await fs.symlink('/nonexistent-target', examplesPath)
      // SKILL.md is created fresh first; examples.md then fails for real, and
      // arms the lstat failure so it lands on rollback's identity check.
      armLstatFailOnWrite.trigger = examplesPath
      armLstatFailOnWrite.target = skillMdPath

      const err = await writeInstallFiles(
        installPath,
        skillsDir,
        'my-skill',
        '# new content',
        [{ filename: 'examples.md', content: 'x' }],
        undefined
      ).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(InstallRestoreError)
      const cleanup = (err as InstallRestoreError).cleanupFailures
      expect(cleanup).toEqual([expect.stringContaining(skillMdPath)])
      expect(cleanup[0]).toContain('EACCES')
      expect(await fs.readFile(path.join(installPath, 'notes.txt'), 'utf8')).toBe('user notes')
    } finally {
      lstatFailTarget.path = null
      armLstatFailOnWrite.trigger = null
      armLstatFailOnWrite.target = null
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })
})
