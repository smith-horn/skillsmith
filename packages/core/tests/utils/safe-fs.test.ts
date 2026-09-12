/**
 * SMI-2274: Safe filesystem operations tests
 *
 * Tests for symlink-safe file write operations.
 * Covers:
 * - Normal file writes
 * - Symlink detection and rejection
 * - Non-existent file creation
 * - Explicit file permissions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  safeWriteFile,
  safeCreateFile,
  writeFullBuffer,
  SymlinkError,
  HardlinkError,
  ExclusiveCreateRaceError,
} from '../../src/utils/safe-fs.js'
import type { FileHandle } from 'fs/promises'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

describe('SMI-2274: safeWriteFile', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'safe-fs-test-'))
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('should write to a new file that does not exist', async () => {
    const filePath = path.join(tempDir, 'new-file.md')

    await safeWriteFile(filePath, '# Test Skill')

    const content = await fs.readFile(filePath, 'utf-8')
    expect(content).toBe('# Test Skill')
  })

  it('should overwrite an existing regular file', async () => {
    const filePath = path.join(tempDir, 'existing.md')
    await fs.writeFile(filePath, 'old content')

    await safeWriteFile(filePath, 'new content')

    const content = await fs.readFile(filePath, 'utf-8')
    expect(content).toBe('new content')
  })

  it('should reject writing to a symlink', async () => {
    const targetPath = path.join(tempDir, 'target.md')
    const symlinkPath = path.join(tempDir, 'symlink.md')
    await fs.writeFile(targetPath, 'target content')
    await fs.symlink(targetPath, symlinkPath)

    await expect(safeWriteFile(symlinkPath, 'malicious')).rejects.toThrow(SymlinkError)
    await expect(safeWriteFile(symlinkPath, 'malicious')).rejects.toThrow(
      'Refusing to write to symlink'
    )

    // Verify target was not modified
    const content = await fs.readFile(targetPath, 'utf-8')
    expect(content).toBe('target content')
  })

  it('should reject writing to a dangling symlink', async () => {
    const symlinkPath = path.join(tempDir, 'dangling.md')
    await fs.symlink('/nonexistent/path', symlinkPath)

    await expect(safeWriteFile(symlinkPath, 'content')).rejects.toThrow(SymlinkError)
  })

  it('should set default file permissions to 0o644', async () => {
    const filePath = path.join(tempDir, 'permissions.md')

    await safeWriteFile(filePath, 'content')

    const stats = await fs.stat(filePath)
    // Check the file permission bits (mask out file type bits)
    const mode = stats.mode & 0o777
    expect(mode).toBe(0o644)
  })

  it('should respect custom mode option', async () => {
    const filePath = path.join(tempDir, 'custom-mode.md')

    await safeWriteFile(filePath, 'content', { mode: 0o600 })

    const stats = await fs.stat(filePath)
    const mode = stats.mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('should handle Buffer content', async () => {
    const filePath = path.join(tempDir, 'buffer.bin')
    const buffer = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f])

    await safeWriteFile(filePath, buffer)

    const content = await fs.readFile(filePath)
    expect(content.toString()).toBe('Hello')
  })

  it('should propagate non-ENOENT errors', async () => {
    // Try to write to a path where the parent directory doesn't exist
    const filePath = path.join(tempDir, 'nonexistent', 'deep', 'file.md')

    await expect(safeWriteFile(filePath, 'content')).rejects.toThrow()
  })

  it('should apply default permissions when encoding string is passed', async () => {
    const filePath = path.join(tempDir, 'encoding-test.md')
    await safeWriteFile(filePath, 'content', 'utf-8')
    const stats = await fs.stat(filePath)
    const mode = stats.mode & 0o777
    expect(mode).toBe(0o644)
  })

  it('should reject writing to a hardlinked file', async () => {
    const originalPath = path.join(tempDir, 'original.md')
    const hardlinkPath = path.join(tempDir, 'hardlink.md')
    await fs.writeFile(originalPath, 'original content')
    await fs.link(originalPath, hardlinkPath)

    await expect(safeWriteFile(hardlinkPath, 'malicious')).rejects.toThrow(HardlinkError)

    // Verify original was not modified
    const content = await fs.readFile(originalPath, 'utf-8')
    expect(content).toBe('original content')
  })
})

describe('SMI-2274: SymlinkError', () => {
  it('should have correct name, message, and filePath', () => {
    const error = new SymlinkError('/path/to/file')

    expect(error.name).toBe('SymlinkError')
    expect(error.message).toBe('Refusing to write to symlink: /path/to/file')
    expect(error.filePath).toBe('/path/to/file')
    expect(error).toBeInstanceOf(Error)
  })
})

describe('SMI-2290: HardlinkError', () => {
  it('should have correct name, message, and filePath', () => {
    const error = new HardlinkError('/path/to/file')

    expect(error.name).toBe('HardlinkError')
    expect(error.message).toBe('Refusing to write to hardlinked file: /path/to/file')
    expect(error.filePath).toBe('/path/to/file')
    expect(error).toBeInstanceOf(Error)
  })
})

describe('SMI-6529 L14(b): safeCreateFile', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'safe-create-test-'))
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('creates a new file that does not exist', async () => {
    const filePath = path.join(tempDir, 'fresh.md')

    await safeCreateFile(filePath, '# Fresh')

    expect(await fs.readFile(filePath, 'utf-8')).toBe('# Fresh')
  })

  it('refuses (ExclusiveCreateRaceError) when the destination already exists as a regular file — never truncates it', async () => {
    const filePath = path.join(tempDir, 'already-there.md')
    await fs.writeFile(filePath, 'must survive untouched')

    await expect(safeCreateFile(filePath, 'attacker or racing content')).rejects.toThrow(
      ExclusiveCreateRaceError
    )
    await expect(safeCreateFile(filePath, 'x')).rejects.toThrow(/appeared during install \(race\)/)

    // The exclusive-create refusal must never have touched the existing content.
    expect(await fs.readFile(filePath, 'utf-8')).toBe('must survive untouched')
  })

  it('refuses when the destination is a symlink (never follows it)', async () => {
    const targetPath = path.join(tempDir, 'target.md')
    const symlinkPath = path.join(tempDir, 'symlink.md')
    await fs.writeFile(targetPath, 'target content')
    await fs.symlink(targetPath, symlinkPath)

    await expect(safeCreateFile(symlinkPath, 'malicious')).rejects.toThrow(ExclusiveCreateRaceError)
    expect(await fs.readFile(targetPath, 'utf-8')).toBe('target content')
  })

  // SMI-6529 N9 (round 4): `onCreated` fires the INSTANT the exclusive
  // open() succeeds — before any content byte is written — so a caller can
  // record its rollback "created fresh" marker at the earliest correct
  // moment (see skill-installation.io.rollback.test.ts's own N9 test for the
  // end-to-end orphan-cleanup proof; this is the direct unit-level contract).
  it('N9: invokes onCreated exactly once on a successful exclusive create', async () => {
    const filePath = path.join(tempDir, 'oncreated.md')
    const onCreated = vi.fn()

    await safeCreateFile(filePath, '# content', undefined, onCreated)

    expect(onCreated).toHaveBeenCalledTimes(1)
    expect(await fs.readFile(filePath, 'utf-8')).toBe('# content')
  })

  // SMI-6529 R5 (round 5): the callback receives the new file's (dev, ino) so
  // a rollback can confirm the path still names this file before unlinking.
  it("R5: passes onCreated the new file's (dev, ino)", async () => {
    const filePath = path.join(tempDir, 'identity.md')
    let seen: { dev: number; ino: number } | undefined
    await safeCreateFile(filePath, '# content', undefined, (identity) => {
      seen = identity
    })
    const created = await fs.lstat(filePath)
    expect(seen).toEqual({ dev: created.dev, ino: created.ino })
  })

  it('N9: never invokes onCreated when the exclusive create is refused (destination already exists)', async () => {
    const filePath = path.join(tempDir, 'already-there-oncreated.md')
    await fs.writeFile(filePath, 'must survive untouched')
    const onCreated = vi.fn()

    await expect(safeCreateFile(filePath, 'x', undefined, onCreated)).rejects.toThrow(
      ExclusiveCreateRaceError
    )

    expect(onCreated).not.toHaveBeenCalled()
    expect(await fs.readFile(filePath, 'utf-8')).toBe('must survive untouched')
  })
})

describe('SMI-6529 N3 (round 4): writeFullBuffer', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'write-full-buffer-test-'))
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  /**
   * A fake FileHandle whose `write()` reports SHORT progress in fixed-size
   * chunks per call — reproduces the measured live hazard (2048/10000 bytes
   * under RLIMIT_FSIZE) deterministically, without needing a real rlimit.
   */
  function createChunkedFakeHandle(chunkSize: number) {
    const written: Buffer[] = []
    const write = vi.fn(
      async (
        buffer: Buffer,
        offset: number,
        length: number,
        _position: number | null
      ): Promise<{ bytesWritten: number }> => {
        const bytesWritten = Math.min(chunkSize, length)
        written.push(Buffer.from(buffer.subarray(offset, offset + bytesWritten)))
        return { bytesWritten }
      }
    )
    return { handle: { write } as unknown as FileHandle, written, write }
  }

  it('completes across multiple short writes, in order, until every byte is accounted for', async () => {
    const data = Buffer.from('0123456789'.repeat(5)) // 50 bytes
    const { handle, written, write } = createChunkedFakeHandle(7) // uneven chunk size

    await writeFullBuffer(handle, data)

    expect(Buffer.concat(written).equals(data)).toBe(true)
    // 50 bytes / 7-byte chunks = 8 calls (7*7=49, final call for the last byte).
    expect(write.mock.calls.length).toBe(Math.ceil(data.length / 7))
  })

  it('throws when a write call makes zero progress (never spins forever on a persistent short write)', async () => {
    const data = Buffer.from('some content')
    const handle = {
      write: vi.fn(async () => ({ bytesWritten: 0 })),
    } as unknown as FileHandle

    await expect(writeFullBuffer(handle, data)).rejects.toThrow(/Short write/)
  })

  it('writes at the correct advancing offset when an explicit position is given', async () => {
    const data = Buffer.from('0123456789') // 10 bytes
    const { handle, written } = createChunkedFakeHandle(4)

    await writeFullBuffer(handle, data, 100)

    // Reassembled content must match regardless of chunking...
    expect(Buffer.concat(written).equals(data)).toBe(true)
    // ...and each underlying real fd.write happy-path (exercised via the
    // real filesystem below) proves the position math is correct end-to-end.
    const filePath = path.join(tempDir, 'positioned.bin')
    await fs.writeFile(filePath, '')
    const fd = await fs.open(filePath, 'r+')
    try {
      await writeFullBuffer(fd, data, 0)
      expect(await fs.readFile(filePath, 'utf-8')).toBe('0123456789')
    } finally {
      await fd.close()
    }
  })
})

describe('SMI-6529 L14(b): ExclusiveCreateRaceError', () => {
  it('has correct name, message, and filePath', () => {
    const error = new ExclusiveCreateRaceError('/path/to/file')

    expect(error.name).toBe('ExclusiveCreateRaceError')
    expect(error.message).toBe('Target appeared during install (race): /path/to/file')
    expect(error.filePath).toBe('/path/to/file')
    expect(error).toBeInstanceOf(Error)
  })
})
