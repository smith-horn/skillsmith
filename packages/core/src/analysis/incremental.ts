/**
 * SMI-1309: Incremental Parsing Support
 *
 * Edit tracking utilities for multi-language AST analysis.
 * Enables efficient incremental parsing by detecting minimal
 * edit regions between old and new content.
 *
 * @see docs/architecture/multi-language-analysis.md
 * @module analysis/incremental
 */

/**
 * Position in source code (row/column)
 *
 * Matches tree-sitter Point interface for compatibility.
 */
export interface Point {
  /** Zero-based line number */
  row: number
  /** Zero-based column offset (byte offset within line) */
  column: number
}

/**
 * File edit information for incremental parsing
 *
 * Contains all information needed by tree-sitter's
 * incremental parsing API to update an existing tree.
 */
export interface FileEdit {
  /** Byte offset where the edit starts */
  startIndex: number
  /** Byte offset where the old content ends */
  oldEndIndex: number
  /** Byte offset where the new content ends */
  newEndIndex: number
  /** Position (row/column) where edit starts */
  startPosition: Point
  /** Position where old content ended */
  oldEndPosition: Point
  /** Position where new content ends */
  newEndPosition: Point
}

/**
 * Simple edit diff result
 *
 * Represents the minimal change between two strings.
 */
export interface EditDiff {
  /** Index where the change starts */
  changeStart: number
  /** Index where old content ends (exclusive) */
  changeEnd: number
  /** New text that replaces [changeStart, changeEnd) */
  newText: string
}

/**
 * Calculate file edit from content diff
 *
 * Converts a simple diff into the format required by
 * tree-sitter's incremental parsing API.
 *
 * @param oldContent - Original file content
 * @param newContent - Updated file content
 * @param changeStart - Start index of the change
 * @param changeEnd - End index in old content
 * @param newText - Replacement text
 * @returns FileEdit structure for tree-sitter
 *
 * @example
 * ```typescript
 * const edit = calculateEdit(
 *   'hello world',
 *   'hello there world',
 *   6, // after 'hello '
 *   6, // no text removed
 *   'there ' // inserted text
 * )
 * tree.edit(edit)
 * ```
 */
export function calculateEdit(
  oldContent: string,
  newContent: string,
  changeStart: number,
  changeEnd: number,
  newText: string
): FileEdit {
  const startPosition = indexToPosition(oldContent, changeStart)
  const oldEndPosition = indexToPosition(oldContent, changeEnd)
  const newEndPosition = indexToPosition(newContent, changeStart + newText.length)

  return {
    startIndex: changeStart,
    oldEndIndex: changeEnd,
    newEndIndex: changeStart + newText.length,
    startPosition,
    oldEndPosition,
    newEndPosition,
  }
}

/**
 * Convert byte index to row/column position
 *
 * Scans through content counting newlines to determine
 * the row and column for a given byte offset.
 *
 * @param content - File content to scan
 * @param index - Byte offset to convert
 * @returns Position with row and column (both zero-based)
 *
 * @example
 * ```typescript
 * const pos = indexToPosition('hello\nworld', 8)
 * // pos = { row: 1, column: 2 } (the 'r' in 'world')
 * ```
 */
export function indexToPosition(content: string, index: number): Point {
  let row = 0
  let column = 0

  const limit = Math.min(index, content.length)
  for (let i = 0; i < limit; i++) {
    if (content[i] === '\n') {
      row++
      column = 0
    } else {
      column++
    }
  }

  return { row, column }
}

/**
 * Convert row/column position to byte index
 *
 * Scans through content to find the byte offset for
 * a given row and column position.
 *
 * @param content - File content to scan
 * @param position - Position to convert
 * @returns Byte offset, or content length if position is past end
 *
 * @example
 * ```typescript
 * const index = positionToIndex('hello\nworld', { row: 1, column: 2 })
 * // index = 8 (the 'r' in 'world')
 * ```
 */
export function positionToIndex(content: string, position: Point): number {
  let currentRow = 0
  let currentColumn = 0

  for (let i = 0; i < content.length; i++) {
    if (currentRow === position.row && currentColumn === position.column) {
      return i
    }

    if (content[i] === '\n') {
      currentRow++
      currentColumn = 0
    } else {
      currentColumn++
    }
  }

  return content.length
}

/**
 * Find the minimal edit between two strings
 *
 * Uses a simple prefix/suffix matching algorithm to find
 * the smallest region that changed between old and new content.
 * Returns null if contents are identical.
 *
 * @param oldContent - Original string
 * @param newContent - Modified string
 * @returns EditDiff describing the change, or null if identical
 *
 * @example
 * ```typescript
 * const diff = findMinimalEdit('hello world', 'hello there world')
 * // diff = { changeStart: 6, changeEnd: 6, newText: 'there ' }
 *
 * const same = findMinimalEdit('hello', 'hello')
 * // same = null
 * ```
 */
export function findMinimalEdit(oldContent: string, newContent: string): EditDiff | null {
  if (oldContent === newContent) {
    return null
  }

  // Find common prefix length
  let prefixLength = 0
  const minLength = Math.min(oldContent.length, newContent.length)
  while (prefixLength < minLength && oldContent[prefixLength] === newContent[prefixLength]) {
    prefixLength++
  }

  // Find common suffix length (after prefix)
  let oldSuffixStart = oldContent.length
  let newSuffixStart = newContent.length
  while (
    oldSuffixStart > prefixLength &&
    newSuffixStart > prefixLength &&
    oldContent[oldSuffixStart - 1] === newContent[newSuffixStart - 1]
  ) {
    oldSuffixStart--
    newSuffixStart--
  }

  return {
    changeStart: prefixLength,
    changeEnd: oldSuffixStart,
    newText: newContent.slice(prefixLength, newSuffixStart),
  }
}

/**
 * Merge multiple edits into a single encompassing edit
 *
 * Useful when multiple small edits occur and need to be
 * applied as a single incremental update.
 *
 * Note: This is a simplistic merge that finds the bounding
 * region. It may over-invalidate if edits are far apart.
 *
 * @param edits - Array of edits to merge
 * @returns Single merged edit, or null if array is empty
 *
 * @example
 * ```typescript
 * const merged = batchEdits([
 *   { changeStart: 0, changeEnd: 5, newText: 'HELLO' },
 *   { changeStart: 10, changeEnd: 15, newText: 'WORLD' }
 * ])
 * // merged encompasses both edit regions
 * ```
 */
export function batchEdits(edits: EditDiff[]): EditDiff | null {
  if (edits.length === 0) {
    return null
  }

  if (edits.length === 1) {
    return edits[0]
  }

  // Sort by start position
  const sorted = [...edits].sort((a, b) => a.changeStart - b.changeStart)

  // Find the bounding box of all edits
  let minStart = sorted[0].changeStart
  let maxEnd = sorted[0].changeEnd
  let combinedNewText = ''
  let lastEnd = sorted[0].changeStart

  for (const edit of sorted) {
    // Check for gaps between edits
    if (edit.changeStart > lastEnd) {
      // Gap exists - this is a complex case
      // For simplicity, we merge anyway and note it may over-invalidate
    }

    minStart = Math.min(minStart, edit.changeStart)
    maxEnd = Math.max(maxEnd, edit.changeEnd)
    combinedNewText += edit.newText
    lastEnd = edit.changeEnd
  }

  return {
    changeStart: minStart,
    changeEnd: maxEnd,
    newText: combinedNewText,
  }
}

/**
 * Check if an edit is a simple insertion (no deletion)
 *
 * @param edit - Edit to check
 * @returns True if edit only inserts text
 */
export function isInsertion(edit: EditDiff): boolean {
  return edit.changeStart === edit.changeEnd && edit.newText.length > 0
}

/**
 * Check if an edit is a simple deletion (no insertion)
 *
 * @param edit - Edit to check
 * @returns True if edit only deletes text
 */
export function isDeletion(edit: EditDiff): boolean {
  return edit.changeStart < edit.changeEnd && edit.newText.length === 0
}

/**
 * Check if an edit is a replacement (both deletion and insertion)
 *
 * @param edit - Edit to check
 * @returns True if edit replaces text
 */
export function isReplacement(edit: EditDiff): boolean {
  return edit.changeStart < edit.changeEnd && edit.newText.length > 0
}

/**
 * Calculate the size delta of an edit
 *
 * @param edit - Edit to analyze
 * @returns Positive for growth, negative for shrinkage, zero for same size
 */
export function editSizeDelta(edit: EditDiff): number {
  const deletedLength = edit.changeEnd - edit.changeStart
  return edit.newText.length - deletedLength
}
