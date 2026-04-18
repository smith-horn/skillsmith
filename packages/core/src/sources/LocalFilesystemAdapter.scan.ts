/**
 * LocalFilesystemAdapter scan loop (SMI-4287)
 *
 * Extracted from `LocalFilesystemAdapter.ts` to keep the main adapter file
 * under the 500-line governance ceiling. Pure function of its inputs — no
 * shared instance state other than the `warnings` sink.
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
  /** Logger instance from the parent adapter. */
  log: ReturnType<typeof createLogger>
}

/**
 * Recursively scan `dirPath` for `SKILL.md` files, populating
 * `options.discovered` and `options.warnings` in place.
 *
 * SMI-4287: all filesystem access routes through `safeFs`. Per-entry errors
 * are recorded on `warnings` and the scan continues for siblings.
 */
export async function scanDirectoryRecursive(
  dirPath: string,
  depth: number,
  options: ScanDirectoryOptions
): Promise<void> {
  if (depth > options.maxDepth) return

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

      if (!options.allowSymlinksOutsideRoot) {
        const resolvedResult = await resolveSafeRealpath(fullPath, options.rootDir)
        if (!resolvedResult.ok) {
          options.warnings.push(resolvedResult.error)
          continue
        }
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
