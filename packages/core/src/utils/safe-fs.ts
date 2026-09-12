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
import type { FileHandle } from 'fs/promises'
import type { WriteFileOptions } from 'fs'

/**
 * O_NOFOLLOW: refuse to open symlinks
 * Prefer runtime constant from fs.constants, fall back to platform-specific values
 * if unavailable (e.g., Windows where O_NOFOLLOW is not defined).
 *
 * Exported (SMI-6529 F2) so other symlink-safe fd-based writers — e.g.
 * writeInstallFiles' own rollback restore — share this exact platform
 * -fallback resolution instead of a second, driftable copy.
 */
export const O_NOFOLLOW =
  (constants as Record<string, number>).O_NOFOLLOW ??
  (process.platform === 'darwin' ? 0x100 : 0x20000)

/**
 * SMI-6529 N3 (round 4): `FileHandle.write()` is permitted by POSIX (and
 * measured live — 2048/10000 bytes under `RLIMIT_FSIZE`) to write FEWER
 * bytes than requested WITHOUT throwing. Every fd-based writer in this
 * module family used a single unchecked `await fd.write(data)` call, so a
 * short write silently truncated content with no error — for
 * `restoreSnapshots()` specifically, that meant a "successful" restore that
 * left the file smaller than the true original with no `InstallRestoreError`
 * ever raised. Loops until every byte is accounted for, or throws if a call
 * makes zero progress (a short write that returns 0 can otherwise spin
 * forever).
 *
 * @param position - Explicit starting file offset, or `null` to write
 *   sequentially from the handle's own current position (which auto-advances
 *   after each underlying `write()` call, short or not).
 */
export async function writeFullBuffer(
  fd: FileHandle,
  data: Buffer,
  position: number | null = null
): Promise<void> {
  let written = 0
  while (written < data.length) {
    const pos = position === null ? null : position + written
    const { bytesWritten } = await fd.write(data, written, data.length - written, pos)
    if (bytesWritten <= 0) {
      throw new Error(`Short write: made no progress after ${written}/${data.length} bytes written`)
    }
    written += bytesWritten
  }
}

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
  const mode = typeof options === 'string' ? 0o644 : ((options as { mode?: number })?.mode ?? 0o644)
  const encoding =
    typeof options === 'string'
      ? options
      : ((options as { encoding?: BufferEncoding })?.encoding ?? undefined)

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
    await writeFullBuffer(fd, data)
  } finally {
    await fd?.close()
  }
}

/**
 * Error thrown when `safeCreateFile`'s exclusive create finds the destination
 * already occupied — created by something else between the caller's own
 * pre-write classification and this call (a race, not a symlink/hardlink).
 * SMI-6529 L14(b).
 */
export class ExclusiveCreateRaceError extends Error {
  public readonly filePath: string
  constructor(filePath: string) {
    super(`Target appeared during install (race): ${filePath}`)
    this.name = 'ExclusiveCreateRaceError'
    this.filePath = filePath
  }
}

/**
 * SMI-6529 L14(b): create a NEW file exclusively — refuses (throws
 * {@link ExclusiveCreateRaceError}) if anything already exists at `filePath`,
 * symlink or otherwise, instead of silently truncating/overwriting it. Only
 * appropriate for a write target the caller has just classified as `absent`
 * (`classifyPreWrite` in skill-installation.io.rollback.ts) — the atomicity
 * of `O_CREAT|O_EXCL` means "did this call create the file" is knowable
 * without needing `safeWriteFile`'s "record BEFORE writing" hedge (F1, round
 * 1), which exists specifically to survive `O_TRUNC`'s non-atomicity on an
 * OVERWRITE — a case this function is never used for.
 *
 * @param filePath - Absolute path to create (must not already exist)
 * @param content - File content (string or Buffer)
 * @param options - Optional fs.writeFile options (encoding, mode) or encoding string
 * @param onCreated - SMI-6529 N9 (round 4): fired the MOMENT the exclusive
 *   `open()` succeeds — i.e. the instant the file is KNOWN to exist on disk —
 *   BEFORE any content byte is written. Lets a caller (`writeInstallFiles`)
 *   record its rollback "created fresh, safe to unlink" candidate at the
 *   earliest correct moment: without this, a write that later fails (e.g.
 *   ENOSPC) after `open()` already created the file left a 0-byte/partial
 *   orphan that rollback never knew to remove, since the caller previously
 *   only recorded it AFTER this whole function resolved.
 * @throws {ExclusiveCreateRaceError} if the destination already exists
 * @throws {SymlinkError} technically unreachable (O_EXCL fails before O_NOFOLLOW
 *   would matter) but kept out of the public contract intentionally — this
 *   function never follows anything, by construction.
 */
export async function safeCreateFile(
  filePath: string,
  content: string | Buffer,
  options?: WriteFileOptions | string,
  onCreated?: (identity?: { dev: number; ino: number }) => void
): Promise<void> {
  const mode = typeof options === 'string' ? 0o644 : ((options as { mode?: number })?.mode ?? 0o644)
  const encoding =
    typeof options === 'string'
      ? options
      : ((options as { encoding?: BufferEncoding })?.encoding ?? undefined)

  let fd
  try {
    fd = await open(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
      mode
    )
    // SMI-6529 R5 (round 5): pass the new file's (dev, ino) so a rollback can
    // confirm the path still names THIS file before unlinking it, and never
    // removes a file another process renamed over ours in between. If the
    // stat fails, the identity is omitted and the caller falls back to
    // unlinking by path.
    let identity: { dev: number; ino: number } | undefined
    try {
      const created = await fd.stat()
      identity = { dev: created.dev, ino: created.ino }
    } catch {
      identity = undefined
    }
    onCreated?.(identity)
    const data =
      typeof content === 'string' && encoding
        ? Buffer.from(content, encoding as BufferEncoding)
        : typeof content === 'string'
          ? Buffer.from(content, 'utf-8')
          : content
    await writeFullBuffer(fd, data)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ExclusiveCreateRaceError(filePath)
    }
    throw error
  } finally {
    await fd?.close()
  }
}
