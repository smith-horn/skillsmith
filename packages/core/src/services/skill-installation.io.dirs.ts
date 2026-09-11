/**
 * @fileoverview Symlink-safe intermediate-directory creation for writeInstallFiles.
 * @module @skillsmith/core/services/skill-installation.io.dirs
 * @see SMI-6529 Wave A0 (F4): split out of skill-installation.io.ts to stay
 *   under the 500-line CI gate once the F1-F4 rollback fixes landed — pure
 *   move, no behavior change.
 */

import * as fs from 'fs/promises'
import * as path from 'path'

/**
 * Ensure `dirPath` exists as a real directory, never following (or silently accepting) an
 * existing symlink there.
 *
 * Sol final-code-review finding #2 (confirmed): `safeWriteFile()` only `lstat`s the FINAL
 * path component before writing — a symlinked INTERMEDIATE directory (e.g. `<installPath>/
 * scripts` already existing as a symlink from a prior force-reinstall or a planted attack)
 * is never checked, so a nested sub-skill filename like `"scripts/run.sh"` could write
 * through it to an arbitrary target outside `installPath`. `fs.mkdir(dir, {recursive:true})`
 * alone does not close this either — it silently no-ops on an existing path whether or not
 * that path is a symlink.
 *
 * SMI-6529 F4: `freshDirs` records every segment that did NOT exist when this call started
 * checking it — regardless of which concurrent sibling sub-skill write's own `fs.mkdir`
 * ultimately wins the create below (the benign EEXIST race) — so a failed install can roll
 * a nested directory back instead of leaving it orphaned inside a pre-existing `installPath`.
 */
async function ensureDirNoFollow(dirPath: string, freshDirs: Set<string>): Promise<void> {
  const check = async (): Promise<'ok' | 'missing'> => {
    let stats
    try {
      stats = await fs.lstat(dirPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
      throw err
    }
    if (stats.isSymbolicLink()) {
      throw new Error('Refusing to write through existing symlink: ' + dirPath)
    }
    if (!stats.isDirectory()) {
      throw new Error('Expected a directory, found a file: ' + dirPath)
    }
    return 'ok'
  }

  if ((await check()) === 'ok') return

  // This segment did not exist at the point we checked it — record it as a rollback
  // candidate BEFORE attempting to create it (mirrors F1's write-side ordering).
  freshDirs.add(dirPath)

  try {
    await fs.mkdir(dirPath)
  } catch (err) {
    // EEXIST here is a benign race between our own concurrent sub-skill writes under the
    // same new subdirectory (writeInstallFiles writes them in parallel) — re-check below
    // rather than trust that; it ALSO re-confirms nothing hostile won the race.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }

  // Re-check post-create: closes both the benign concurrent-mkdir race above and the TOCTOU
  // window between the first check and this mkdir.
  if ((await check()) !== 'ok') {
    throw new Error('Failed to create directory: ' + dirPath)
  }
}

/**
 * Create every path segment of `dir` (relative to `baseDir`) via `ensureDirNoFollow()`,
 * so no intermediate segment can be a pre-existing symlink. `dir` must already be lexically
 * inside `baseDir` — callers are expected to have proven that (as `writeInstallFiles()`'s
 * `installPath` already is, via its own lexical + realpath checks) before calling this.
 */
export async function mkdirNoFollow(
  baseDir: string,
  dir: string,
  freshDirs: Set<string>
): Promise<void> {
  const relative = path.relative(baseDir, dir)
  if (relative === '' || relative.startsWith('..')) return
  const segments = relative.split(path.sep)
  let current = baseDir
  for (const segment of segments) {
    current = path.join(current, segment)
    await ensureDirNoFollow(current, freshDirs)
  }
}
