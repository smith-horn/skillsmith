/**
 * SMI-2274: Safe filesystem operations
 * @module @skillsmith/core/utils/safe-fs
 *
 * Provides symlink-safe file write operations to prevent
 * path traversal attacks via symlink substitution.
 *
 * Attack scenario:
 * 1. Attacker creates a symlink at ~/.claude/skills/evil -> /etc/passwd
 * 2. Install tool writes SKILL.md content to that path
 * 3. Content overwrites /etc/passwd instead of skill file
 *
 * Defense:
 * - SMI-2285: Uses O_NOFOLLOW to atomically refuse symlinks (eliminates TOCTOU race)
 * - SMI-2290: Checks nlink count to detect hardlinks
 * - SMI-2288: Properly handles string encoding options for permissions
 */

import { open, lstat, constants } from 'fs/promises'
import type { WriteFileOptions } from 'fs'

/**
 * O_NOFOLLOW: refuse to open symlinks (platform-specific constant)
 * macOS: 0x100, Linux: 0x20000
 */
const O_NOFOLLOW = process.platform === 'darwin' ? 0x100 : 0x20000

/**
 * Error thrown when a symlink is detected at a write destination.
 */
export class SymlinkError extends Error {
  public readonly filePath: string
  constructor(filePath: string) {
    super(`Refusing to write to symlink: ${filePath}`)
    this.name = 'SymlinkError'
    this.filePath = filePath
  }
}

/**
 * Error thrown when a hardlinked file is detected at a write destination.
 * SMI-2290: Hardlinks can alias files, allowing writes to bypass symlink checks.
 */
export class HardlinkError extends Error {
  public readonly filePath: string
  constructor(filePath: string) {
    super(`Refusing to write to hardlinked file: ${filePath}`)
    this.name = 'HardlinkError'
    this.filePath = filePath
  }
}

/**
 * Write a file safely, refusing to write if the destination is a symlink or hardlink.
 *
 * SMI-2285: Uses O_NOFOLLOW to atomically refuse symlinks, eliminating the
 * TOCTOU race condition in the previous lstat-then-write approach.
 * SMI-2290: Checks nlink count to detect hardlinks before writing.
 * SMI-2288: Properly extracts mode from string options (encoding strings).
 *
 * @param filePath - Absolute path to write to
 * @param content - File content (string or Buffer)
 * @param options - Optional fs.writeFile options (encoding, mode, flag) or encoding string
 * @throws {SymlinkError} if the destination is a symlink
 * @throws {HardlinkError} if the destination has multiple hardlinks
 *
 * @example
 * ```typescript
 * import { safeWriteFile } from '@skillsmith/core'
 *
 * // Safe write - rejects symlinks and hardlinks
 * await safeWriteFile('/path/to/file.md', content)
 *
 * // With explicit permissions
 * await safeWriteFile('/path/to/file.md', content, { mode: 0o644 })
 *
 * // With encoding string (uses default 0o644 permissions)
 * await safeWriteFile('/path/to/file.md', content, 'utf-8')
 * ```
 */
export async function safeWriteFile(
  filePath: string,
  content: string | Buffer,
  options?: WriteFileOptions | string
): Promise<void> {
  // SMI-2288: Extract mode and encoding from options (handles string encoding case)
  const mode =
    typeof options === 'string'
      ? 0o644
      : (options as { mode?: number })?.mode ?? 0o644
  const encoding =
    typeof options === 'string'
      ? options
      : (options as { encoding?: BufferEncoding })?.encoding ?? undefined

  // SMI-2290: Check for hardlinks on existing files
  try {
    const stats = await lstat(filePath)
    if (stats.isSymbolicLink()) {
      throw new SymlinkError(filePath)
    }
    if (stats.nlink > 1) {
      throw new HardlinkError(filePath)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist — safe to create
    } else if (error instanceof SymlinkError || error instanceof HardlinkError) {
      throw error
    } else {
      throw error
    }
  }

  // SMI-2285: Open with O_NOFOLLOW to prevent TOCTOU race
  let fd
  try {
    fd = await open(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | O_NOFOLLOW,
      mode
    )
    const data =
      typeof content === 'string' && encoding
        ? Buffer.from(content, encoding as BufferEncoding)
        : typeof content === 'string'
          ? Buffer.from(content, 'utf-8')
          : content
    await fd.write(data)
  } finally {
    await fd?.close()
  }
}
