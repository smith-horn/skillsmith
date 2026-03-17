/**
 * SMI-3416: Three-Way Merge Algorithm Tests
 *
 * Tests for LCS-based diff3 merge in merge.ts:
 * - computeDiff: line-level diff between two texts
 * - threeWayMerge: three-way merge with conflict detection
 */

import { describe, it, expect } from 'vitest'
import { computeDiff, threeWayMerge } from './merge.js'

// ============================================================================
// computeDiff
// ============================================================================

describe('computeDiff', () => {
  it('should return empty diff for identical content', () => {
    const result = computeDiff('a\nb\nc', 'a\nb\nc')
    expect(result.additions).toEqual([])
    expect(result.deletions).toEqual([])
    expect(result.unchanged).toEqual([1, 2, 3])
  })

  it('should detect additions', () => {
    const result = computeDiff('a\nc', 'a\nb\nc')
    expect(result.additions.length).toBeGreaterThan(0)
    expect(result.deletions).toEqual([])
  })

  it('should detect deletions', () => {
    const result = computeDiff('a\nb\nc', 'a\nc')
    expect(result.deletions.length).toBeGreaterThan(0)
    expect(result.additions).toEqual([])
  })

  it('should detect modifications', () => {
    const result = computeDiff('a\nb\nc', 'a\nB\nc')
    expect(result.additions.length).toBeGreaterThan(0)
    expect(result.deletions.length).toBeGreaterThan(0)
    expect(result.unchanged).toContain(1) // 'a' unchanged
    expect(result.unchanged).toContain(3) // 'c' unchanged
  })

  it('should handle empty base', () => {
    const result = computeDiff('', 'a\nb')
    expect(result.additions.length).toBeGreaterThan(0)
    // Empty string splits to [''], so there's 1 base "line" that may count as deleted
    expect(result.deletions.length).toBeLessThanOrEqual(1)
  })

  it('should handle empty target', () => {
    const result = computeDiff('a\nb', '')
    expect(result.deletions.length).toBeGreaterThan(0)
    // Empty string splits to [''], so there's 1 "line" in the target
    // which counts as an addition if it doesn't match any base line
    expect(result.additions.length).toBeLessThanOrEqual(1)
  })

  it('should handle single-line content', () => {
    const result = computeDiff('hello', 'world')
    expect(result.deletions).toEqual([1])
    expect(result.additions).toEqual([1])
  })
})

// ============================================================================
// threeWayMerge — edge cases
// ============================================================================

describe('threeWayMerge', () => {
  describe('edge cases', () => {
    it('should return empty for three empty inputs', () => {
      const result = threeWayMerge('', '', '')
      expect(result.success).toBe(true)
      expect(result.merged).toBe('')
    })

    it('should return upstream when local is empty and base is empty', () => {
      const result = threeWayMerge('', '', 'new content')
      expect(result.success).toBe(true)
      expect(result.merged).toBe('new content')
    })

    it('should return local when upstream is empty and base is empty', () => {
      const result = threeWayMerge('', 'local content', '')
      expect(result.success).toBe(true)
      expect(result.merged).toBe('local content')
    })

    it('should conflict when both have content but base is empty', () => {
      const result = threeWayMerge('', 'local', 'upstream')
      expect(result.success).toBe(false)
      expect(result.conflicts).toHaveLength(1)
      expect(result.merged).toContain('<<<<<<< LOCAL')
      expect(result.merged).toContain('>>>>>>> UPSTREAM')
    })
  })

  describe('no-conflict cases', () => {
    it('should return upstream when local is unchanged from base', () => {
      const result = threeWayMerge('base', 'base', 'upstream')
      expect(result.success).toBe(true)
      expect(result.merged).toBe('upstream')
    })

    it('should return local when upstream is unchanged from base', () => {
      const result = threeWayMerge('base', 'local', 'base')
      expect(result.success).toBe(true)
      expect(result.merged).toBe('local')
    })

    it('should return local when both made same change', () => {
      const result = threeWayMerge('base', 'same', 'same')
      expect(result.success).toBe(true)
      expect(result.merged).toBe('same')
    })

    it('should merge non-overlapping changes', () => {
      const base = 'line1\nline2\nline3\nline4\nline5'
      const local = 'LINE1\nline2\nline3\nline4\nline5' // changed line 1
      const upstream = 'line1\nline2\nline3\nline4\nLINE5' // changed line 5

      const result = threeWayMerge(base, local, upstream)
      expect(result.success).toBe(true)
      expect(result.merged).toContain('LINE1')
      expect(result.merged).toContain('LINE5')
    })
  })

  describe('conflict cases', () => {
    it('should detect conflict when both modify same region', () => {
      const base = 'line1\nline2\nline3'
      const local = 'line1\nLOCAL\nline3'
      const upstream = 'line1\nUPSTREAM\nline3'

      const result = threeWayMerge(base, local, upstream)
      expect(result.success).toBe(false)
      expect(result.conflicts).toBeDefined()
      expect(result.conflicts!.length).toBeGreaterThan(0)
      expect(result.merged).toContain('<<<<<<< LOCAL')
      expect(result.merged).toContain('=======')
      expect(result.merged).toContain('>>>>>>> UPSTREAM')
    })

    it('should preserve unchanged lines around conflicts', () => {
      const base = 'a\nb\nc'
      const local = 'a\nB-local\nc'
      const upstream = 'a\nB-upstream\nc'

      const result = threeWayMerge(base, local, upstream)
      expect(result.merged).toContain('a')
      expect(result.merged).toContain('c')
    })

    it('conflict should include line number', () => {
      const base = 'a\nb\nc'
      const local = 'a\nX\nc'
      const upstream = 'a\nY\nc'

      const result = threeWayMerge(base, local, upstream)
      expect(result.conflicts).toBeDefined()
      expect(result.conflicts![0].lineNumber).toBeGreaterThan(0)
      expect(result.conflicts![0].local).toBe('X')
      expect(result.conflicts![0].upstream).toBe('Y')
    })
  })

  describe('multiline changes', () => {
    it('should handle additions by one side', () => {
      const base = 'a\nc'
      const local = 'a\nb\nc' // inserted 'b'
      const upstream = 'a\nc' // unchanged

      const result = threeWayMerge(base, local, upstream)
      expect(result.success).toBe(true)
      expect(result.merged).toContain('b')
    })

    it('should handle deletions by one side', () => {
      const base = 'a\nb\nc'
      const local = 'a\nc' // deleted 'b'
      const upstream = 'a\nb\nc' // unchanged

      const result = threeWayMerge(base, local, upstream)
      expect(result.success).toBe(true)
      expect(result.merged).not.toContain('\nb\n')
    })
  })
})
