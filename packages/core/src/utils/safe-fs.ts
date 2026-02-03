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
 * Defense: Check for symlinks via lstat() before every write.
 */

import { lstat, writeFile } from 'fs/promises'
import type { WriteFileOptions } from 'fs'

/**
 * Error thrown when a symlink is detected at a write destination.
 */
export class SymlinkError extends Error {
  constructor(filePath: string) {
    super(`Refusing to write to symlink: ${filePath}`)
    this.name = 'SymlinkError'
  }
}

/**
 * Write a file safely, refusing to write if the destination is a symlink.
 *
 * Uses lstat() (not stat()) to detect symlinks without following them.
 * If the file does not exist (ENOENT), it is safe to create.
 *
 * @param filePath - Absolute path to write to
 * @param content - File content (string or Buffer)
 * @param options - Optional fs.writeFile options (encoding, mode, flag)
 * @throws {SymlinkError} if the destination is a symlink
 *
 * @example
 * ```typescript
 * import { safeWriteFile } from '@skillsmith/core'
 *
 * // Safe write - rejects symlinks
 * await safeWriteFile('/path/to/file.md', content)
 *
 * // With explicit permissions
 * await safeWriteFile('/path/to/file.md', content, { mode: 0o644 })
 * ```
 */
export async function safeWriteFile(
  filePath: string,
  content: string | Buffer,
  options?: WriteFileOptions
): Promise<void> {
  // Check if destination is a symlink BEFORE writing
  try {
    const stats = await lstat(filePath)
    if (stats.isSymbolicLink()) {
      throw new SymlinkError(filePath)
    }
  } catch (error) {
    // ENOENT = file doesn't exist, safe to create
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist - safe to proceed
    } else if (error instanceof SymlinkError) {
      throw error
    } else {
      throw error
    }
  }

  // Write with explicit permissions (default: 0o644 = rw-r--r--)
  const writeOptions: WriteFileOptions =
    typeof options === 'object' && options !== null
      ? { mode: 0o644, ...options }
      : options ?? { mode: 0o644 }

  await writeFile(filePath, content, writeOptions)
}
