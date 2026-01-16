/**
 * SKILL.md validation utilities for the indexer
 * @module indexer/validation
 *
 * Provides validation functions for SKILL.md content:
 * - YAML frontmatter parsing
 * - Content validation (length, structure)
 * - Quality gate checks
 */

/**
 * Parsed YAML frontmatter from SKILL.md
 */
export interface SkillFrontmatter {
  name?: string
  description?: string
  author?: string
  triggers?: string[]
  version?: string
  category?: string
  [key: string]: unknown
}

/**
 * Result of SKILL.md content validation
 */
export interface SkillMdValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  metadata?: SkillFrontmatter
  contentLength: number
  hasTitle: boolean
  hasFrontmatter: boolean
}

/**
 * Validation options
 */
export interface ValidationOptions {
  /** Minimum content length (default: 100) */
  minContentLength?: number
  /** Require YAML frontmatter (default: false) */
  requireFrontmatter?: boolean
  /** Minimum description length in frontmatter (default: 10) */
  minDescriptionLength?: number
}

const DEFAULT_OPTIONS: Required<ValidationOptions> = {
  minContentLength: 100,
  requireFrontmatter: false,
  minDescriptionLength: 10,
}

/**
 * Parse YAML frontmatter from SKILL.md content.
 *
 * Frontmatter is delimited by `---` at the start of the file:
 * ```
 * ---
 * name: my-skill
 * description: A helpful skill
 * ---
 * # Content here
 * ```
 *
 * @param content - Raw SKILL.md file content
 * @returns Parsed frontmatter object and remaining content, or null if no frontmatter
 *
 * @example
 * const result = parseYamlFrontmatter('---\nname: test\n---\n# Title');
 * // { frontmatter: { name: 'test' }, content: '# Title' }
 */
export function parseYamlFrontmatter(
  content: string
): { frontmatter: SkillFrontmatter; content: string } | null {
  if (!content || typeof content !== 'string') {
    return null
  }

  const trimmed = content.trim()

  // Check if content starts with frontmatter delimiter
  if (!trimmed.startsWith('---')) {
    return null
  }

  // Find the closing delimiter
  const endIndex = trimmed.indexOf('---', 3)
  if (endIndex === -1) {
    return null
  }

  // Extract frontmatter YAML
  const yamlContent = trimmed.slice(3, endIndex).trim()
  const remainingContent = trimmed.slice(endIndex + 3).trim()

  // Handle empty frontmatter
  if (!yamlContent) {
    return {
      frontmatter: {},
      content: remainingContent,
    }
  }

  // Parse YAML manually (simple key: value pairs)
  // We use a simple parser to avoid external dependencies in Deno
  const frontmatter: SkillFrontmatter = {}
  const lines = yamlContent.split('\n')

  let currentKey: string | null = null
  let currentArrayValue: string[] | null = null

  for (const line of lines) {
    const trimmedLine = line.trim()

    // Skip empty lines and comments
    if (!trimmedLine || trimmedLine.startsWith('#')) {
      continue
    }

    // Check for array item (- value)
    if (trimmedLine.startsWith('- ') && currentKey && currentArrayValue !== null) {
      let arrayItem = trimmedLine.slice(2).trim()
      // Remove surrounding quotes from array items
      if (
        (arrayItem.startsWith('"') && arrayItem.endsWith('"')) ||
        (arrayItem.startsWith("'") && arrayItem.endsWith("'"))
      ) {
        arrayItem = arrayItem.slice(1, -1)
      }
      currentArrayValue.push(arrayItem)
      continue
    }

    // Save previous array if we're moving to a new key
    if (currentKey && currentArrayValue !== null) {
      frontmatter[currentKey] = currentArrayValue
      currentArrayValue = null
    }

    // Parse key: value
    const colonIndex = trimmedLine.indexOf(':')
    if (colonIndex === -1) {
      // Invalid YAML line - skip or could be a continuation
      continue
    }

    const key = trimmedLine.slice(0, colonIndex).trim()
    const value = trimmedLine.slice(colonIndex + 1).trim()

    if (!key) {
      continue
    }

    // Check if this is an array (empty value, next lines start with -)
    if (!value) {
      currentKey = key
      currentArrayValue = []
      continue
    }

    // Handle quoted strings
    let parsedValue: string = value
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      parsedValue = value.slice(1, -1)
    }

    // Handle inline arrays [item1, item2]
    if (parsedValue.startsWith('[') && parsedValue.endsWith(']')) {
      const arrayContent = parsedValue.slice(1, -1)
      frontmatter[key] = arrayContent
        .split(',')
        .map((item) => item.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
      continue
    }

    frontmatter[key] = parsedValue
    currentKey = key
    currentArrayValue = null
  }

  // Save any trailing array
  if (currentKey && currentArrayValue !== null) {
    frontmatter[currentKey] = currentArrayValue
  }

  return {
    frontmatter,
    content: remainingContent,
  }
}

/**
 * Extract title from markdown content.
 *
 * Looks for the first H1 heading (# Title) in the content.
 *
 * @param content - Markdown content (without frontmatter)
 * @returns Title text or null if no H1 found
 */
export function extractTitle(content: string): string | null {
  if (!content) {
    return null
  }

  const lines = content.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('# ')) {
      return trimmed.slice(2).trim()
    }
  }

  return null
}

/**
 * Validate SKILL.md content.
 *
 * Performs comprehensive validation including:
 * - Frontmatter parsing and validation (if present)
 * - Content length check
 * - Title presence check
 * - Quality gate checks
 *
 * @param content - Raw SKILL.md file content
 * @param options - Validation options
 * @returns Validation result with errors, warnings, and metadata
 *
 * @example
 * const result = validateSkillMdContent(`---
 * name: my-skill
 * description: A helpful skill for developers
 * ---
 *
 * # My Skill
 *
 * This is a comprehensive skill that helps developers.
 * `);
 *
 * console.log(result.valid); // true
 * console.log(result.metadata?.name); // 'my-skill'
 */
export function validateSkillMdContent(
  content: string,
  options: ValidationOptions = {}
): SkillMdValidationResult {
  const opts = { ...DEFAULT_OPTIONS, ...options }

  const result: SkillMdValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
    contentLength: 0,
    hasTitle: false,
    hasFrontmatter: false,
  }

  // Check for empty content
  if (!content || typeof content !== 'string') {
    result.valid = false
    result.errors.push('Content is empty or invalid')
    return result
  }

  const trimmedContent = content.trim()
  result.contentLength = trimmedContent.length

  // Check minimum content length
  if (trimmedContent.length < opts.minContentLength) {
    result.valid = false
    result.errors.push(
      `Content too short: ${trimmedContent.length} characters (minimum: ${opts.minContentLength})`
    )
    return result
  }

  // Parse frontmatter
  const parsed = parseYamlFrontmatter(trimmedContent)
  let markdownContent = trimmedContent

  if (parsed) {
    result.hasFrontmatter = true
    result.metadata = parsed.frontmatter
    markdownContent = parsed.content

    // Validate frontmatter fields
    if (parsed.frontmatter.name && typeof parsed.frontmatter.name !== 'string') {
      result.warnings.push('Frontmatter "name" should be a string')
    }

    if (parsed.frontmatter.description) {
      if (typeof parsed.frontmatter.description !== 'string') {
        result.warnings.push('Frontmatter "description" should be a string')
      } else if (parsed.frontmatter.description.length < opts.minDescriptionLength) {
        result.warnings.push(
          `Frontmatter "description" is short: ${parsed.frontmatter.description.length} characters (recommended: ${opts.minDescriptionLength}+)`
        )
      }
    } else {
      result.warnings.push('Frontmatter missing "description" field')
    }

    if (parsed.frontmatter.triggers) {
      if (!Array.isArray(parsed.frontmatter.triggers)) {
        result.warnings.push('Frontmatter "triggers" should be an array')
      }
    }
  } else if (opts.requireFrontmatter) {
    result.valid = false
    result.errors.push('YAML frontmatter is required but not found')
  }

  // Check for title
  const title = extractTitle(markdownContent)
  if (title) {
    result.hasTitle = true

    // If no name in frontmatter, use title as name
    if (!result.metadata?.name) {
      if (!result.metadata) {
        result.metadata = {}
      }
      result.metadata.name = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
    }
  } else {
    result.valid = false
    result.errors.push('No title heading (# Title) found in content')
  }

  return result
}

/**
 * Quality gate check for indexed skills.
 *
 * Validates that a skill meets minimum quality requirements
 * for inclusion in the registry.
 *
 * @param content - Raw SKILL.md content
 * @param strictValidation - Whether to require frontmatter
 * @returns True if skill passes quality gates
 */
export function passesQualityGate(content: string, strictValidation = true): boolean {
  const result = validateSkillMdContent(content, {
    minContentLength: 100,
    requireFrontmatter: strictValidation,
    minDescriptionLength: 10,
  })

  return result.valid
}
