/**
 * @fileoverview Three-Way Merge Algorithm for Skill Update Conflict Resolution
 * @module @skillsmith/mcp-server/tools/merge
 * @see SMI-1866
 */

import type { MergeResult, MergeConflict } from './install.types.js'

// ============================================================================
// Diff Types
// ============================================================================

/**
 * Result of computing a diff between two text contents
 */
export interface DiffResult {
  /** Line numbers that were added (1-indexed) */
  additions: number[]
  /** Line numbers that were deleted (1-indexed) */
  deletions: number[]
  /** Line numbers that remained unchanged (1-indexed) */
  unchanged: number[]
}

// ============================================================================
// Diff Algorithm
// ============================================================================

/**
 * Compute a line-by-line diff between base and target content
 *
 * @param base - The original/base content
 * @param target - The modified content to compare against
 * @returns DiffResult with line numbers for additions, deletions, and unchanged
 */
export function computeDiff(base: string, target: string): DiffResult {
  const baseLines = base.split('\n')
  const targetLines = target.split('\n')

  const additions: number[] = []
  const deletions: number[] = []
  const unchanged: number[] = []

  const maxLen = Math.max(baseLines.length, targetLines.length)

  for (let i = 0; i < maxLen; i++) {
    const lineNumber = i + 1 // 1-indexed
    const baseLine = baseLines[i]
    const targetLine = targetLines[i]

    if (baseLine === undefined && targetLine !== undefined) {
      // Line added in target (doesn't exist in base)
      additions.push(lineNumber)
    } else if (baseLine !== undefined && targetLine === undefined) {
      // Line deleted in target (exists in base but not in target)
      deletions.push(lineNumber)
    } else if (baseLine === targetLine) {
      // Line unchanged
      unchanged.push(lineNumber)
    } else {
      // Line modified (treat as deletion + addition)
      deletions.push(lineNumber)
      additions.push(lineNumber)
    }
  }

  return { additions, deletions, unchanged }
}

// ============================================================================
// Three-Way Merge Algorithm
// ============================================================================

/**
 * Perform a three-way merge between base, local, and upstream versions
 *
 * The algorithm compares each line position across all three versions:
 * - If only local changed from base -> use local
 * - If only upstream changed from base -> use upstream
 * - If both changed to the same value -> use either (no conflict)
 * - If both changed to different values -> CONFLICT
 * - If neither changed -> use base
 *
 * For conflicts, inserts standard Git-style conflict markers:
 * ```
 * <<<<<<< LOCAL
 * {local content}
 * =======
 * {upstream content}
 * >>>>>>> UPSTREAM
 * ```
 *
 * @param base - The common ancestor (original content at install time)
 * @param local - The user's modified version
 * @param upstream - The new version from the skill author
 * @returns MergeResult with merged content and any conflicts
 */
export function threeWayMerge(
  base: string,
  local: string,
  upstream: string
): MergeResult {
  // Handle edge case: empty base (treat as fresh file)
  if (base === '') {
    // If both local and upstream are empty, success
    if (local === '' && upstream === '') {
      return { success: true, merged: '' }
    }
    // If only one has content, use that
    if (local === '') {
      return { success: true, merged: upstream }
    }
    if (upstream === '') {
      return { success: true, merged: local }
    }
    // Both have content but no common base - treat as conflict on first line
    const conflicts: MergeConflict[] = [
      {
        lineNumber: 1,
        local: local,
        upstream: upstream,
        base: '',
      },
    ]
    const merged = [
      '<<<<<<< LOCAL',
      local,
      '=======',
      upstream,
      '>>>>>>> UPSTREAM',
    ].join('\n')
    return { success: false, merged, conflicts }
  }

  const baseLines = base.split('\n')
  const localLines = local.split('\n')
  const upstreamLines = upstream.split('\n')

  const maxLen = Math.max(baseLines.length, localLines.length, upstreamLines.length)
  const mergedLines: string[] = []
  const conflicts: MergeConflict[] = []

  for (let i = 0; i < maxLen; i++) {
    const baseLine = baseLines[i] ?? ''
    const localLine = localLines[i] ?? ''
    const upstreamLine = upstreamLines[i] ?? ''

    // Check if this line exists in each version
    const inBase = i < baseLines.length
    const inLocal = i < localLines.length
    const inUpstream = i < upstreamLines.length

    // Determine what changed
    const localChanged = localLine !== baseLine || (inLocal !== inBase)
    const upstreamChanged = upstreamLine !== baseLine || (inUpstream !== inBase)

    if (!localChanged && !upstreamChanged) {
      // Neither changed - use base
      if (inBase) {
        mergedLines.push(baseLine)
      }
    } else if (localChanged && !upstreamChanged) {
      // Only local changed - use local
      if (inLocal) {
        mergedLines.push(localLine)
      }
      // If local deleted this line (inLocal is false), don't add anything
    } else if (!localChanged && upstreamChanged) {
      // Only upstream changed - use upstream
      if (inUpstream) {
        mergedLines.push(upstreamLine)
      }
      // If upstream deleted this line (inUpstream is false), don't add anything
    } else if (localLine === upstreamLine) {
      // Both changed to the same value - use either
      if (inLocal) {
        mergedLines.push(localLine)
      }
    } else {
      // Conflict - both changed differently
      conflicts.push({
        lineNumber: i + 1,
        local: localLine,
        upstream: upstreamLine,
        base: baseLine,
      })
      mergedLines.push('<<<<<<< LOCAL')
      if (inLocal) {
        mergedLines.push(localLine)
      }
      mergedLines.push('=======')
      if (inUpstream) {
        mergedLines.push(upstreamLine)
      }
      mergedLines.push('>>>>>>> UPSTREAM')
    }
  }

  return {
    success: conflicts.length === 0,
    merged: mergedLines.join('\n'),
    conflicts: conflicts.length > 0 ? conflicts : undefined,
  }
}
