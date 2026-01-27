/**
 * @fileoverview Three-Way Merge Algorithm for Skill Update Conflict Resolution
 * @module @skillsmith/mcp-server/tools/merge
 * @see SMI-1866
 *
 * Uses LCS-based diff3 algorithm for accurate conflict detection.
 * Handles insertions and deletions properly without false positives.
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

/**
 * A hunk represents a contiguous region of changes
 */
interface Hunk {
  /** Starting line in base (0-indexed) */
  baseStart: number
  /** Number of lines from base */
  baseCount: number
  /** Lines from the modified version for this hunk */
  lines: string[]
}

// ============================================================================
// LCS Algorithm
// ============================================================================

/**
 * Compute Longest Common Subsequence of two line arrays
 * Returns indices of matching lines in both arrays
 */
function computeLCS(a: string[], b: string[]): Array<[number, number]> {
  const m = a.length
  const n = b.length

  // Build LCS length table
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0))

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  // Backtrack to find the actual LCS
  const lcs: Array<[number, number]> = []
  let i = m
  let j = n

  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      lcs.unshift([i - 1, j - 1])
      i--
      j--
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--
    } else {
      j--
    }
  }

  return lcs
}

/**
 * Convert LCS matches to hunks of changes
 */
function getHunks(base: string[], modified: string[], lcs: Array<[number, number]>): Hunk[] {
  const hunks: Hunk[] = []
  let baseIdx = 0
  let modIdx = 0
  let lcsIdx = 0

  while (baseIdx < base.length || modIdx < modified.length) {
    if (lcsIdx < lcs.length) {
      const [baseMatch, modMatch] = lcs[lcsIdx]

      // Collect lines before the next match
      if (baseIdx < baseMatch || modIdx < modMatch) {
        const hunk: Hunk = {
          baseStart: baseIdx,
          baseCount: baseMatch - baseIdx,
          lines: modified.slice(modIdx, modMatch),
        }
        hunks.push(hunk)
      }

      // Skip past the matching line (it's unchanged)
      baseIdx = baseMatch + 1
      modIdx = modMatch + 1
      lcsIdx++
    } else {
      // No more matches - everything remaining is a change
      const hunk: Hunk = {
        baseStart: baseIdx,
        baseCount: base.length - baseIdx,
        lines: modified.slice(modIdx),
      }
      if (hunk.baseCount > 0 || hunk.lines.length > 0) {
        hunks.push(hunk)
      }
      break
    }
  }

  return hunks
}

// ============================================================================
// Diff Algorithm
// ============================================================================

/**
 * Compute a line-by-line diff between base and target content
 * Uses LCS for accurate change detection
 *
 * @param base - The original/base content
 * @param target - The modified content to compare against
 * @returns DiffResult with line numbers for additions, deletions, and unchanged
 */
export function computeDiff(base: string, target: string): DiffResult {
  const baseLines = base.split('\n')
  const targetLines = target.split('\n')

  const lcs = computeLCS(baseLines, targetLines)

  const additions: number[] = []
  const deletions: number[] = []
  const unchanged: number[] = []

  // Mark unchanged lines from LCS
  const baseMatched = new Set(lcs.map(([b]) => b))
  const targetMatched = new Set(lcs.map(([, t]) => t))

  for (let i = 0; i < baseLines.length; i++) {
    if (baseMatched.has(i)) {
      unchanged.push(i + 1)
    } else {
      deletions.push(i + 1)
    }
  }

  for (let i = 0; i < targetLines.length; i++) {
    if (!targetMatched.has(i)) {
      additions.push(i + 1)
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
 * Uses LCS-based diff3 algorithm:
 * 1. Find common lines between base and each version
 * 2. Identify hunks (regions of change) for each version
 * 3. Merge hunks, detecting conflicts only when both sides modify the same region
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
export function threeWayMerge(base: string, local: string, upstream: string): MergeResult {
  // Handle edge case: empty base (treat as fresh file)
  if (base === '') {
    if (local === '' && upstream === '') {
      return { success: true, merged: '' }
    }
    if (local === '') {
      return { success: true, merged: upstream }
    }
    if (upstream === '') {
      return { success: true, merged: local }
    }
    // Both have content but no common base - full conflict
    const conflicts: MergeConflict[] = [
      {
        lineNumber: 1,
        local: local,
        upstream: upstream,
        base: '',
      },
    ]
    const merged = ['<<<<<<< LOCAL', local, '=======', upstream, '>>>>>>> UPSTREAM'].join('\n')
    return { success: false, merged, conflicts }
  }

  // Handle edge case: local or upstream unchanged
  if (local === base) {
    return { success: true, merged: upstream }
  }
  if (upstream === base) {
    return { success: true, merged: local }
  }
  if (local === upstream) {
    return { success: true, merged: local }
  }

  const baseLines = base.split('\n')
  const localLines = local.split('\n')
  const upstreamLines = upstream.split('\n')

  // Compute LCS between base and each version
  const lcsLocal = computeLCS(baseLines, localLines)
  const lcsUpstream = computeLCS(baseLines, upstreamLines)

  // Get hunks for each version
  const localHunks = getHunks(baseLines, localLines, lcsLocal)
  const upstreamHunks = getHunks(baseLines, upstreamLines, lcsUpstream)

  // Build a map of base line regions modified by each side
  const localModified = new Map<number, Hunk>()
  const upstreamModified = new Map<number, Hunk>()

  for (const hunk of localHunks) {
    for (let i = hunk.baseStart; i < hunk.baseStart + Math.max(hunk.baseCount, 1); i++) {
      localModified.set(i, hunk)
    }
  }

  for (const hunk of upstreamHunks) {
    for (let i = hunk.baseStart; i < hunk.baseStart + Math.max(hunk.baseCount, 1); i++) {
      upstreamModified.set(i, hunk)
    }
  }

  // Merge by walking through base lines and applying changes
  const mergedLines: string[] = []
  const conflicts: MergeConflict[] = []
  const processedLocalHunks = new Set<Hunk>()
  const processedUpstreamHunks = new Set<Hunk>()

  let baseIdx = 0

  while (baseIdx <= baseLines.length) {
    const localHunk = localModified.get(baseIdx)
    const upstreamHunk = upstreamModified.get(baseIdx)

    if (localHunk && !processedLocalHunks.has(localHunk)) {
      processedLocalHunks.add(localHunk)

      if (upstreamHunk && !processedUpstreamHunks.has(upstreamHunk)) {
        processedUpstreamHunks.add(upstreamHunk)

        // Both modified this region - check for conflict
        const localContent = localHunk.lines.join('\n')
        const upstreamContent = upstreamHunk.lines.join('\n')

        if (localContent === upstreamContent) {
          // Same change - no conflict
          mergedLines.push(...localHunk.lines)
        } else {
          // Different changes - conflict
          const baseContent = baseLines
            .slice(localHunk.baseStart, localHunk.baseStart + localHunk.baseCount)
            .join('\n')

          conflicts.push({
            lineNumber: localHunk.baseStart + 1,
            local: localContent,
            upstream: upstreamContent,
            base: baseContent,
          })

          mergedLines.push('<<<<<<< LOCAL')
          mergedLines.push(...localHunk.lines)
          mergedLines.push('=======')
          mergedLines.push(...upstreamHunk.lines)
          mergedLines.push('>>>>>>> UPSTREAM')
        }

        // Skip past the larger of the two hunk regions
        baseIdx = Math.max(
          localHunk.baseStart + localHunk.baseCount,
          upstreamHunk.baseStart + upstreamHunk.baseCount
        )
        continue
      } else {
        // Only local modified - use local
        mergedLines.push(...localHunk.lines)
        baseIdx = localHunk.baseStart + localHunk.baseCount
        continue
      }
    } else if (upstreamHunk && !processedUpstreamHunks.has(upstreamHunk)) {
      processedUpstreamHunks.add(upstreamHunk)
      // Only upstream modified - use upstream
      mergedLines.push(...upstreamHunk.lines)
      baseIdx = upstreamHunk.baseStart + upstreamHunk.baseCount
      continue
    }

    // No modifications at this position - use base line
    if (baseIdx < baseLines.length) {
      mergedLines.push(baseLines[baseIdx])
    }
    baseIdx++
  }

  return {
    success: conflicts.length === 0,
    merged: mergedLines.join('\n'),
    conflicts: conflicts.length > 0 ? conflicts : undefined,
  }
}
