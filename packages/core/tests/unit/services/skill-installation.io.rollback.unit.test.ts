/**
 * @fileoverview Direct unit tests for classifyPreWrite()/restoreSnapshots().
 * @see SMI-6529 Wave A0 (F1, F2, review round 1)
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  classifyPreWrite,
  restoreSnapshots,
} from '../../../src/services/skill-installation.io.rollback.js'

describe('classifyPreWrite', () => {
  it('classifies an absent path', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'classify-absent-'))
    try {
      const result = await classifyPreWrite(path.join(root, 'does-not-exist.txt'))
      expect(result).toEqual({ kind: 'absent' })
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('classifies a pre-existing regular file, snapshotting its bytes + mode', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'classify-regular-'))
    try {
      const filePath = path.join(root, 'existing.txt')
      await fs.writeFile(filePath, 'original content', { mode: 0o640 })

      const result = await classifyPreWrite(filePath)

      expect(result.kind).toBe('regular')
      if (result.kind === 'regular') {
        expect(result.snapshot.content.toString('utf8')).toBe('original content')
        expect(result.snapshot.mode & 0o777).toBe(0o640)
        expect(result.snapshot.path).toBe(filePath)
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('classifies a symlink as "other" — never as regular or absent', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'classify-symlink-'))
    try {
      const linkPath = path.join(root, 'a-symlink.txt')
      await fs.symlink('/nonexistent-target', linkPath)

      const result = await classifyPreWrite(linkPath)

      expect(result).toEqual({ kind: 'other' })
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('classifies a directory as "other"', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'classify-dir-'))
    try {
      const dirPath = path.join(root, 'a-directory')
      await fs.mkdir(dirPath)

      const result = await classifyPreWrite(dirPath)

      expect(result).toEqual({ kind: 'other' })
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })
})

describe('restoreSnapshots', () => {
  it('F2: skips a no-op restore when current bytes already equal the snapshot (never touches the file)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-noop-'))
    try {
      const filePath = path.join(root, 'untouched.txt')
      await fs.writeFile(filePath, 'same content throughout')
      const before = await fs.stat(filePath)
      // Small delay so a real write (which this must NOT be) would visibly
      // bump mtime — proves the skip is a genuine no-op, not just
      // content-identical-after-a-write.
      await new Promise((resolve) => setTimeout(resolve, 20))

      const failures = await restoreSnapshots([
        { path: filePath, content: Buffer.from('same content throughout'), mode: before.mode },
      ])

      expect(failures).toEqual([])
      const after = await fs.stat(filePath)
      expect(after.mtimeMs).toBe(before.mtimeMs)
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('restores bytes and mode when content actually differs', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-real-'))
    try {
      const filePath = path.join(root, 'overwritten.txt')
      await fs.writeFile(filePath, 'ORIGINAL', { mode: 0o600 })
      // Simulate a real overwrite having happened.
      await fs.writeFile(filePath, 'clobbered by a failed install')

      const failures = await restoreSnapshots([
        { path: filePath, content: Buffer.from('ORIGINAL'), mode: 0o600 },
      ])

      expect(failures).toEqual([])
      expect(await fs.readFile(filePath, 'utf8')).toBe('ORIGINAL')
      const stat = await fs.stat(filePath)
      expect(stat.mode & 0o777).toBe(0o600)
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('F2: restores WITHOUT following a symlink planted at the snapshot path — refuses and reports a failure, never touching the symlink target', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-nofollow-'))
    try {
      const victimPath = path.join(root, 'victim.txt')
      const victimContent = 'must NEVER be touched by a restore meant for a different file'
      await fs.writeFile(victimPath, victimContent)

      // The snapshot's own path used to be a regular file, but between
      // snapshot-time and restore-time it was replaced by a symlink pointing
      // at victim.txt (a race, or a planted attack).
      const snapshotPath = path.join(root, 'was-a-file-now-a-symlink.txt')
      await fs.symlink(victimPath, snapshotPath)

      const failures = await restoreSnapshots([
        { path: snapshotPath, content: Buffer.from('original snapshot content'), mode: 0o644 },
      ])

      expect(failures).toEqual([snapshotPath])
      // The symlink target must be completely untouched.
      expect(await fs.readFile(victimPath, 'utf8')).toBe(victimContent)
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('collects every unrestorable path rather than stopping at the first failure', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-multi-fail-'))
    try {
      const goodPath = path.join(root, 'good.txt')
      await fs.writeFile(goodPath, 'will be restored')

      const badPath1 = path.join(root, 'bad1.txt')
      await fs.symlink('/nonexistent-1', badPath1)
      const badPath2 = path.join(root, 'bad2.txt')
      await fs.symlink('/nonexistent-2', badPath2)

      const failures = await restoreSnapshots([
        { path: badPath1, content: Buffer.from('x'), mode: 0o644 },
        { path: goodPath, content: Buffer.from('RESTORED'), mode: 0o644 },
        { path: badPath2, content: Buffer.from('y'), mode: 0o644 },
      ])

      expect(failures.sort()).toEqual([badPath1, badPath2].sort())
      expect(await fs.readFile(goodPath, 'utf8')).toBe('RESTORED')
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    }
  })
})
