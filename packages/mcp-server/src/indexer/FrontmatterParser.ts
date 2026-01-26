/**
 * @fileoverview FrontmatterParser - YAML frontmatter parsing for SKILL.md files
 * @module @skillsmith/mcp-server/indexer/FrontmatterParser
 * @see SMI-1829: Split LocalIndexer.ts to comply with 500-line governance limit
 *
 * Provides YAML frontmatter parsing functionality extracted from LocalIndexer
 * for better modularity and governance compliance.
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

/**
 * Parse SKILL.md frontmatter to extract metadata.
 *
 * Supports YAML frontmatter delimited by `---` lines.
 * Extracts name, description, author, tags, version, and triggers.
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

  // Find the closing --- delimiter
  const secondDelimiterIndex = content.indexOf('---', 3)
  if (secondDelimiterIndex === -1) {
    return result
  }

  // Extract frontmatter content
  const frontmatter = content.substring(3, secondDelimiterIndex).trim()

  // Parse YAML-like frontmatter (simple key: value parsing)
  const lines = frontmatter.split('\n')
  let currentKey: string | null = null
  let inArray = false

  for (const line of lines) {
    const trimmedLine = line.trim()

    // Skip empty lines
    if (!trimmedLine) continue

    // Check for array item (starts with -)
    if (trimmedLine.startsWith('- ') && currentKey && inArray) {
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

    // Check for key: value pair
    const colonIndex = trimmedLine.indexOf(':')
    if (colonIndex === -1) continue

    const key = trimmedLine.substring(0, colonIndex).trim().toLowerCase()
    const value = trimmedLine.substring(colonIndex + 1).trim()

    // Handle empty value (might be start of array)
    if (!value) {
      currentKey = key
      inArray = true
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
      inArray = false
      continue
    }

    // Clean quoted values
    const cleanValue = value.replace(/^["']|["']$/g, '')

    // Assign to appropriate field
    switch (key) {
      case 'name':
        result.name = cleanValue
        break
      case 'description':
        result.description = cleanValue
        break
      case 'author':
        result.author = cleanValue
        break
      case 'version':
        result.version = cleanValue
        break
    }

    currentKey = key
    inArray = false
  }

  return result
}
