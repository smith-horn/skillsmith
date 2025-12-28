/**
 * SMI-628: SkillParser - Parse SKILL.md files with YAML frontmatter
 *
 * Parses skill definition files from repositories to extract metadata.
 * Supports the standard SKILL.md format with YAML frontmatter containing:
 * - name, description, author, version
 * - tags, dependencies, category
 * - Additional metadata fields
 */

import type { TrustTier } from '../types/skill.js'

/**
 * Raw metadata extracted from SKILL.md frontmatter
 */
export interface SkillFrontmatter {
  name: string
  description?: string
  author?: string
  version?: string
  tags?: string[]
  dependencies?: string[]
  category?: string
  license?: string
  repository?: string
  homepage?: string
  [key: string]: unknown
}

/**
 * Parsed skill metadata ready for database insertion
 */
export interface ParsedSkillMetadata {
  name: string
  description: string | null
  author: string | null
  version: string | null
  tags: string[]
  dependencies: string[]
  category: string | null
  license: string | null
  repository: string | null
  rawContent: string
  frontmatter: SkillFrontmatter
}

/**
 * Validation result for skill metadata
 */
export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

/**
 * Parser options
 */
export interface SkillParserOptions {
  /**
   * Whether to require a name field (default: true)
   */
  requireName?: boolean

  /**
   * Whether to require a description field (default: false)
   */
  requireDescription?: boolean

  /**
   * Custom validation function
   */
  customValidator?: (frontmatter: SkillFrontmatter) => ValidationResult
}

/**
 * Simple YAML frontmatter parser
 * Parses basic YAML key-value pairs without external dependencies
 */
function parseYamlFrontmatter(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = yaml.split('\n')
  let currentKey: string | null = null
  let arrayBuffer: string[] = []
  let inArray = false

  for (const line of lines) {
    const trimmed = line.trim()

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    // Check for array item
    if (trimmed.startsWith('- ')) {
      if (currentKey && inArray) {
        const value = trimmed.slice(2).trim()
        // Remove quotes if present
        const unquoted = value.replace(/^["']|["']$/g, '')
        arrayBuffer.push(unquoted)
      }
      continue
    }

    // Check for key-value pair
    const colonIndex = trimmed.indexOf(':')
    if (colonIndex > 0) {
      // Save previous array if exists
      if (currentKey && inArray && arrayBuffer.length > 0) {
        result[currentKey] = arrayBuffer
        arrayBuffer = []
      }

      const key = trimmed.slice(0, colonIndex).trim()
      const value = trimmed.slice(colonIndex + 1).trim()

      if (value === '' || value === '|' || value === '>') {
        // This might be an array or multiline value
        currentKey = key
        inArray = true
        arrayBuffer = []
      } else {
        // Simple key-value
        currentKey = null
        inArray = false

        // Parse the value
        let parsedValue: unknown = value

        // Remove quotes
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          parsedValue = value.slice(1, -1)
        }
        // Parse boolean
        else if (value === 'true') {
          parsedValue = true
        } else if (value === 'false') {
          parsedValue = false
        }
        // Parse number
        else if (/^-?\d+(\.\d+)?$/.test(value)) {
          parsedValue = parseFloat(value)
        }
        // Parse inline array [item1, item2]
        else if (value.startsWith('[') && value.endsWith(']')) {
          parsedValue = value
            .slice(1, -1)
            .split(',')
            .map((item) => item.trim().replace(/^["']|["']$/g, ''))
            .filter((item) => item.length > 0)
        }

        result[key] = parsedValue
      }
    }
  }

  // Save final array if exists
  if (currentKey && inArray && arrayBuffer.length > 0) {
    result[currentKey] = arrayBuffer
  }

  return result
}

/**
 * SkillParser - Parses SKILL.md files with YAML frontmatter
 */
export class SkillParser {
  private options: Required<Omit<SkillParserOptions, 'customValidator'>> &
    Pick<SkillParserOptions, 'customValidator'>

  constructor(options: SkillParserOptions = {}) {
    this.options = {
      requireName: options.requireName ?? true,
      requireDescription: options.requireDescription ?? false,
      customValidator: options.customValidator,
    }
  }

  /**
   * Parse a SKILL.md file content
   * @param content - Raw file content
   * @returns Parsed skill metadata or null if invalid
   */
  parse(content: string): ParsedSkillMetadata | null {
    const frontmatter = this.extractFrontmatter(content)
    if (!frontmatter) {
      return null
    }

    const validation = this.validate(frontmatter)
    if (!validation.valid) {
      return null
    }

    return this.toMetadata(frontmatter, content)
  }

  /**
   * Parse with validation results
   * @param content - Raw file content
   * @returns Parsed metadata with validation info
   */
  parseWithValidation(content: string): {
    metadata: ParsedSkillMetadata | null
    validation: ValidationResult
    frontmatter: SkillFrontmatter | null
  } {
    const frontmatter = this.extractFrontmatter(content)
    if (!frontmatter) {
      return {
        metadata: null,
        validation: {
          valid: false,
          errors: ['Failed to extract YAML frontmatter'],
          warnings: [],
        },
        frontmatter: null,
      }
    }

    const validation = this.validate(frontmatter)
    const metadata = validation.valid ? this.toMetadata(frontmatter, content) : null

    return { metadata, validation, frontmatter }
  }

  /**
   * Extract YAML frontmatter from markdown content
   */
  extractFrontmatter(content: string): SkillFrontmatter | null {
    const trimmed = content.trim()

    // Check for frontmatter delimiters
    if (!trimmed.startsWith('---')) {
      return null
    }

    // Find closing delimiter
    const endIndex = trimmed.indexOf('---', 3)
    if (endIndex === -1) {
      return null
    }

    const yamlContent = trimmed.slice(3, endIndex).trim()

    try {
      const parsed = parseYamlFrontmatter(yamlContent)

      // Ensure name is a string if present
      if (parsed.name !== undefined && typeof parsed.name !== 'string') {
        parsed.name = String(parsed.name)
      }

      return parsed as SkillFrontmatter
    } catch {
      return null
    }
  }

  /**
   * Validate skill frontmatter
   */
  validate(frontmatter: SkillFrontmatter): ValidationResult {
    const errors: string[] = []
    const warnings: string[] = []

    // Required fields
    if (this.options.requireName && !frontmatter.name) {
      errors.push('Missing required field: name')
    }

    if (this.options.requireDescription && !frontmatter.description) {
      errors.push('Missing required field: description')
    }

    // Type validation
    if (frontmatter.name && typeof frontmatter.name !== 'string') {
      errors.push('Field "name" must be a string')
    }

    if (frontmatter.description && typeof frontmatter.description !== 'string') {
      errors.push('Field "description" must be a string')
    }

    if (frontmatter.author && typeof frontmatter.author !== 'string') {
      errors.push('Field "author" must be a string')
    }

    if (frontmatter.version && typeof frontmatter.version !== 'string') {
      errors.push('Field "version" must be a string')
    }

    if (frontmatter.tags && !Array.isArray(frontmatter.tags)) {
      errors.push('Field "tags" must be an array')
    }

    if (frontmatter.dependencies && !Array.isArray(frontmatter.dependencies)) {
      errors.push('Field "dependencies" must be an array')
    }

    // Warnings for recommended fields
    if (!frontmatter.description) {
      warnings.push('Consider adding a description for better discoverability')
    }

    if (!frontmatter.version) {
      warnings.push('Consider adding a version number')
    }

    if (!frontmatter.tags || frontmatter.tags.length === 0) {
      warnings.push('Consider adding tags for better searchability')
    }

    // Custom validation
    if (this.options.customValidator) {
      const customResult = this.options.customValidator(frontmatter)
      errors.push(...customResult.errors)
      warnings.push(...customResult.warnings)
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    }
  }

  /**
   * Convert frontmatter to metadata
   */
  private toMetadata(frontmatter: SkillFrontmatter, rawContent: string): ParsedSkillMetadata {
    return {
      name: frontmatter.name,
      description: frontmatter.description ?? null,
      author: frontmatter.author ?? null,
      version: frontmatter.version ?? null,
      tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
      dependencies: Array.isArray(frontmatter.dependencies) ? frontmatter.dependencies : [],
      category: frontmatter.category ?? null,
      license: frontmatter.license ?? null,
      repository: frontmatter.repository ?? null,
      rawContent,
      frontmatter,
    }
  }

  /**
   * Extract markdown body (content after frontmatter)
   */
  extractBody(content: string): string {
    const trimmed = content.trim()

    if (!trimmed.startsWith('---')) {
      return content
    }

    const endIndex = trimmed.indexOf('---', 3)
    if (endIndex === -1) {
      return content
    }

    return trimmed.slice(endIndex + 3).trim()
  }

  /**
   * Infer trust tier from metadata
   */
  inferTrustTier(metadata: ParsedSkillMetadata): TrustTier {
    // Verified authors/organizations
    const verifiedAuthors = ['anthropic', 'anthropics', 'skillsmith']

    if (
      metadata.author &&
      verifiedAuthors.some((v) => metadata.author?.toLowerCase().includes(v))
    ) {
      return 'verified'
    }

    // Has comprehensive metadata
    const hasDescription = !!metadata.description && metadata.description.length > 50
    const hasTags = metadata.tags.length >= 3
    const hasVersion = !!metadata.version
    const hasLicense = !!metadata.license

    const metadataScore = [hasDescription, hasTags, hasVersion, hasLicense].filter(Boolean).length

    if (metadataScore >= 3) {
      return 'community'
    }

    if (metadataScore >= 1) {
      return 'experimental'
    }

    return 'unknown'
  }
}

export default SkillParser
