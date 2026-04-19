/**
 * LocalFilesystemAdapter scan loop (SMI-4287, SMI-4319)
 *
 * Extracted from `LocalFilesystemAdapter.ts` to keep the main adapter file
 * under the 500-line governance ceiling. Pure function of its inputs — no
 * shared instance state other than the `warnings` sink.
 *
 * SMI-4319: tracks visited directory realpaths in a per-scan `Set<string>`
 * so mutually-recursive symlinks (A→B, B→A) are detected and skipped with a
 * `loop` warning. Each `scanDirectoryRecursive` invocation checks the set
 * BEFORE recursing; the set is keyed on the raw realpath (no
 * `normaliseForFs`) so legitimate case-sensitive distinctions are preserved.
 * Loop detection runs regardless of `allowSymlinksOutsideRoot` — loops are a
 * correctness issue (infinite work), not a security issue.
 */

import { join, relative, dirname } from 'path'
import { safeFs, resolveSafeRealpath } from './LocalFilesystemAdapter.helpers.js'
import type { AdapterError } from './types.js'
import type { createLogger } from '../utils/logger.js'

/**
 * File names that identify a skill definition.
 */
export const SKILL_FILE_NAMES = ['SKILL.md', 'skill.md']

/**
 * Shape shared with `LocalFilesystemAdapter.DiscoveredSkill`.
 */
export interface DiscoveredSkillRecord {
  path: string
  relativePath: string
  directory: string
  stats: {
    size: number
    mtime: Date
    ctime: Date
  }
}

/**
 * Configuration consumed by the scan loop.
 */
export interface ScanDirectoryOptions {
  /** Root directory (used for relative path calculations). */
  rootDir: string
  /** Maximum recursion depth. */
  maxDepth: number
  /** If false, symlinks are skipped entirely. */
  followSymlinks: boolean
  /** If true, skip the symlink-containment check. */
  allowSymlinksOutsideRoot: boolean
  /** Predicate for name-based exclusion. */
  isExcluded: (name: string) => boolean
  /** Destination array for discovered skills (mutated in place). */
  discovered: DiscoveredSkillRecord[]
  /** Destination array for non-fatal errors (mutated in place). */
  warnings: AdapterError[]
  /**
   * Visited directory realpaths for this scan (SMI-4319). Mutated in place.
   * Keyed on the raw realpath string (no platform lowercasing). Must be a
   * fresh `Set` per `runScan` invocation so back-to-back scans don't share
   * state.
   */
  visitedRealpaths: Set<string>
  /** Logger instance from the parent adapter. */
  log: ReturnType<typeof createLogger>
}

/**
 * Recursively scan `dirPath` for `SKILL.md` files, populating
 * `options.discovered` and `options.warnings` in place.
 *
 * SMI-4287: all filesystem access routes through `safeFs`. Per-entry errors
 * are recorded on `warnings` and the scan continues for siblings.
 *
 * SMI-4319: before descending, realpath `dirPath` and check
 * `options.visitedRealpaths` for a prior visit. On hit, push a `loop` warning
 * and return — prevents A↔B / self-loop directory symlinks from wasting
 * `maxDepth` traversals and surfacing the same SKILL.md under multiple
 * lexical paths. Realpath errors (permission, ENOENT, ELOOP on the dir
 * itself) are recorded and the subtree is skipped.
 */
export async function scanDirectoryRecursive(
  dirPath: string,
  depth: number,
  options: ScanDirectoryOptions
): Promise<void> {
  if (depth > options.maxDepth) return

  // SMI-4319: loop detection runs before readdir so we short-circuit on a
  // repeat directory even if the prior visit populated `discovered`.
  const realDirResult = await safeFs.realpath(dirPath)
  if (!realDirResult.ok) {
    options.warnings.push(realDirResult.error)
    return
  }
  const realDir = realDirResult.value
  if (options.visitedRealpaths.has(realDir)) {
    options.warnings.push({
      code: 'loop',
      path: dirPath,
      message: `Symlink loop detected: ${dirPath} resolves to already-visited ${realDir}`,
    })
    return
  }
  options.visitedRealpaths.add(realDir)

  const dirResult = await safeFs.readdir(dirPath)
  if (!dirResult.ok) {
    if (dirResult.error.code === 'permission') {
      options.log.debug(`Skipping ${dirPath}: ${dirResult.error.message}`)
    } else {
      options.log.warn(`Error scanning directory ${dirPath}: ${dirResult.error.message}`)
    }
    options.warnings.push(dirResult.error)
    return
  }

  for (const entry of dirResult.value) {
    const fullPath = join(dirPath, entry.name)

    if (options.isExcluded(entry.name)) continue

    let isDirectory = entry.isDirectory()
    let isFile = entry.isFile()

    if (entry.isSymbolicLink()) {
      if (!options.followSymlinks) continue

      const resolvedResult = await resolveSafeRealpath(fullPath, options.rootDir, {
        allowSymlinksOutsideRoot: options.allowSymlinksOutsideRoot,
      })
      if (!resolvedResult.ok) {
        options.warnings.push(resolvedResult.error)
        continue
      }

      const statResult = await safeFs.stat(fullPath)
      if (!statResult.ok) {
        // ENOENT on a symlink = broken link; quietly skip (pre-existing
        // behaviour). Other errors (loop, permission) are recorded.
        if (statResult.error.code !== 'not-found') {
          options.warnings.push(statResult.error)
        }
        continue
      }
      isDirectory = statResult.value.isDirectory()
      isFile = statResult.value.isFile()
    }

    if (isFile && SKILL_FILE_NAMES.includes(entry.name)) {
      const statResult = await safeFs.stat(fullPath)
      if (!statResult.ok) {
        options.warnings.push(statResult.error)
        continue
      }
      const stats = statResult.value
      options.discovered.push({
        path: fullPath,
        relativePath: relative(options.rootDir, fullPath),
        directory: dirname(fullPath),
        stats: {
          size: stats.size,
          mtime: stats.mtime,
          ctime: stats.ctime,
        },
      })
    }

    if (isDirectory) {
      await scanDirectoryRecursive(fullPath, depth + 1, options)
    }
  }
}
