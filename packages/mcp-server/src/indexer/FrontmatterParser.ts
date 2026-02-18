/**
 * @fileoverview FrontmatterParser - YAML frontmatter parsing for SKILL.md files
 * @module @skillsmith/mcp-server/indexer/FrontmatterParser
 * @see SMI-1829: Split LocalIndexer.ts to comply with 500-line governance limit
 *
 * Provides YAML frontmatter parsing functionality extracted from LocalIndexer
 * for better modularity and governance compliance.
 *
 * Parity: supabase/functions/indexer/frontmatter-parser.ts
 */

/**
 * Parsed SKILL.md frontmatter fields
 */
export interface SkillFrontmatter {
  name: string | null
  description: string | null
  author: string | null
  tags: string[]
  version: string | null
  triggers: string[]
}

/** Parsing mode for the current value being accumulated */
type ParseMode = 'none' | 'list' | 'block-fold' | 'block-literal' | 'scalar'

/**
 * Parse SKILL.md frontmatter to extract metadata.
 *
 * Supports YAML frontmatter delimited by `---` lines.
 * Extracts name, description, author, tags, version, and triggers.
 * Handles multi-line values: folded block (>-/>), literal block (|/|-),
 * and plain multi-line scalars.
 *
 * @param content - Content of the SKILL.md file
 * @returns Parsed frontmatter fields
 */
export function parseFrontmatter(content: string): SkillFrontmatter {
  const result: SkillFrontmatter = {
    name: null,
    description: null,
    author: null,
    tags: [],
    version: null,
    triggers: [],
  }

  // Check for frontmatter (starts with ---)
  if (!content.startsWith('---')) {
    return result
  }

  // Find the closing --- delimiter using regex to match line boundary
  const closingMatch = content.match(/\n---(\r?\n|$)/)
  if (!closingMatch || closingMatch.index === undefined) {
    return result
  }

  // Extract frontmatter content between delimiters
  const frontmatter = content.substring(3, closingMatch.index).trim()

  const lines = frontmatter.split('\n')
  let currentKey: string | null = null
  let currentMode: ParseMode = 'none'
  let blockLines: string[] = []

  function flushBlock(): void {
    if (!currentKey || blockLines.length === 0) return
    const joined = currentMode === 'block-literal' ? blockLines.join('\n') : blockLines.join(' ')
    assignValue(currentKey, joined)
    blockLines = []
  }

  function assignValue(key: string, value: string): void {
    switch (key) {
      case 'name':
        result.name = value
        break
      case 'description':
        result.description = value
        break
      case 'author':
        result.author = value
        break
      case 'version':
        result.version = value
        break
    }
  }

  for (const line of lines) {
    const trimmedLine = line.trim()

    // Skip empty lines
    if (!trimmedLine) continue

    // Check for array item (starts with -)
    // Matches in list mode, or when first item after empty-value key (scalar mode)
    if (
      trimmedLine.startsWith('- ') &&
      currentKey &&
      (currentMode === 'list' || currentMode === 'scalar')
    ) {
      if (currentMode === 'scalar') {
        currentMode = 'list'
      }
      const value = trimmedLine
        .substring(2)
        .trim()
        .replace(/^["']|["']$/g, '')
      if (currentKey === 'tags' && value) {
        result.tags.push(value)
      } else if (currentKey === 'triggers' && value) {
        result.triggers.push(value)
      }
      continue
    }

    // In block/scalar accumulation: check for continuation lines
    if (
      (currentMode === 'block-fold' ||
        currentMode === 'block-literal' ||
        currentMode === 'scalar') &&
      currentKey
    ) {
      // Continuation lines start with whitespace and don't look like a key
      if (line.match(/^\s/) && !line.match(/^[\w-]+:\s*/)) {
        blockLines.push(trimmedLine)
        continue
      }
      // Not a continuation — flush and fall through
      flushBlock()
      currentMode = 'none'
      currentKey = null
    }

    // Check for key: value pair
    const colonIndex = trimmedLine.indexOf(':')
    if (colonIndex === -1) continue

    const key = trimmedLine.substring(0, colonIndex).trim().toLowerCase()
    const value = trimmedLine.substring(colonIndex + 1).trim()

    currentKey = key

    // Handle empty value — defer decision until first continuation line
    if (!value) {
      currentMode = 'scalar'
      blockLines = []
      continue
    }

    // Handle block scalar indicators: >-, >, |, |-
    const blockMatch = value.match(/^([>|])(-?)$/)
    if (blockMatch) {
      currentMode = blockMatch[1] === '>' ? 'block-fold' : 'block-literal'
      blockLines = []
      continue
    }

    // Parse inline arrays: tags: [testing, development]
    if (value.startsWith('[') && value.endsWith(']')) {
      const arrayContent = value.slice(1, -1)
      const items = arrayContent.split(',').map((item) => item.trim().replace(/^["']|["']$/g, ''))

      if (key === 'tags') {
        result.tags = items.filter(Boolean)
      } else if (key === 'triggers') {
        result.triggers = items.filter(Boolean)
      }
      currentKey = null
      currentMode = 'none'
      continue
    }

    // Clean quoted values and assign
    const cleanValue = value.replace(/^["']|["']$/g, '')
    assignValue(key, cleanValue)

    currentMode = 'none'
  }

  // Flush any remaining block content
  flushBlock()

  return result
}
