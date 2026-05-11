/**
 * YAML frontmatter parser for SKILL.md files
 * @module scripts/indexer/frontmatter-parser
 *
 * SMI-4852: Node-flavored sibling of
 * `supabase/functions/indexer/frontmatter-parser.ts`. Body is byte-identical —
 * pure string parsing with no Deno-only APIs. Parity guarded by
 * `scripts/indexer/tests/parity.test.ts`.
 *
 * Extracted from skill-processor.ts to comply with 500-line CI gate.
 * Supports single-line values, multi-line plain scalars, folded block (>-/>),
 * literal block (|/|-), YAML lists, and inline arrays.
 *
 * Parity: packages/mcp-server/src/indexer/FrontmatterParser.ts
 */

/** Parsing mode for the current value being accumulated */
type ParseMode = 'none' | 'list' | 'block-fold' | 'block-literal' | 'scalar'

/**
 * Parse YAML frontmatter from markdown content.
 * Returns null if no frontmatter is present.
 */
export function parseFrontmatter(content: string): Record<string, unknown> | null {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!frontmatterMatch) {
    return null
  }

  const yamlContent = frontmatterMatch[1]
  const result: Record<string, unknown> = {}
  const lines = yamlContent.split(/\r?\n/)

  let currentKey: string | null = null
  let currentMode: ParseMode = 'none'
  let blockLines: string[] = []

  function flushBlock(): void {
    if (!currentKey || blockLines.length === 0) return
    if (currentMode === 'block-fold' || currentMode === 'scalar') {
      result[currentKey] = blockLines.join(' ')
    } else if (currentMode === 'block-literal') {
      result[currentKey] = blockLines.join('\n')
    }
    blockLines = []
  }

  for (const line of lines) {
    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) {
      continue
    }

    // Check for array items (triggers, tags, etc.)
    // Matches in list mode, or when first item after empty-value key (scalar mode)
    if (
      line.match(/^\s+-\s+/) &&
      currentKey &&
      (currentMode === 'list' || currentMode === 'scalar')
    ) {
      if (currentMode === 'scalar') {
        currentMode = 'list'
      }
      const value = line
        .replace(/^\s+-\s+/, '')
        .trim()
        .replace(/^["']|["']$/g, '')
      if (!Array.isArray(result[currentKey])) {
        result[currentKey] = []
      }
      ;(result[currentKey] as string[]).push(value)
      continue
    }

    // In block/scalar accumulation: check if this is a continuation line
    if (
      (currentMode === 'block-fold' ||
        currentMode === 'block-literal' ||
        currentMode === 'scalar') &&
      currentKey
    ) {
      // Continuation lines are indented and don't look like a key-value pair
      if (line.match(/^\s/) && !line.match(/^[\w-]+:\s*/)) {
        blockLines.push(line.trim())
        continue
      }
      // Not a continuation — flush and fall through to key-value parsing
      flushBlock()
      currentMode = 'none'
      currentKey = null
    }

    // Check for key: value pairs
    // SMI-2414: Support hyphenated YAML keys (e.g., min-version, skill-type)
    const kvMatch = line.match(/^([\w-]+):\s*(.*)$/)
    if (kvMatch) {
      const [, key, rawValue] = kvMatch
      currentKey = key

      // Handle empty value — defer decision until first continuation line
      if (!rawValue.trim()) {
        currentMode = 'scalar'
        blockLines = []
        continue
      }

      // Handle block scalar indicators: >-, >, |, |-
      const blockMatch = rawValue.trim().match(/^([>|])(-?)$/)
      if (blockMatch) {
        currentMode = blockMatch[1] === '>' ? 'block-fold' : 'block-literal'
        blockLines = []
        continue
      }

      // Handle inline arrays [value1, value2]
      const inlineArrayMatch = rawValue.match(/^\[(.*)\]$/)
      if (inlineArrayMatch) {
        result[key] = inlineArrayMatch[1]
          .split(',')
          .map((v) => v.trim().replace(/^["']|["']$/g, ''))
        currentKey = null
        currentMode = 'none'
        continue
      }

      // Handle quoted or unquoted string values
      const value = rawValue.trim().replace(/^["']|["']$/g, '')
      result[key] = value
      currentKey = null
      currentMode = 'none'
    }
  }

  // Flush any remaining block content
  flushBlock()

  return result
}
