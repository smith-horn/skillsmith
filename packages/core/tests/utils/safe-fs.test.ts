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

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { safeWriteFile, SymlinkError, HardlinkError } from '../../src/utils/safe-fs.js'
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
