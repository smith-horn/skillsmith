/**
 * @fileoverview MCP Skill Validate Tool for validating SKILL.md files
 * @module @skillsmith/mcp-server/tools/validate
 * @see SMI-742: Add MCP Tool skill_validate
 *
 * Validates skill definition files against the Skillsmith specification:
 * - YAML frontmatter structure
 * - Required fields (name, description)
 * - Field length limits
 * - Security patterns (SSRF, path traversal)
 *
 * @example
 * // Basic validation
 * const result = await executeValidate({
 *   skill_path: '/path/to/SKILL.md'
 * });
 *
 * @example
 * // Strict validation
 * const result = await executeValidate({
 *   skill_path: '/path/to/skill-directory',
 *   strict: true
 * });
 */

import { z } from 'zod'
import { promises as fs } from 'fs'
import { join } from 'path'
import { SkillsmithError, ErrorCodes } from '@skillsmith/core'

/**
 * Zod schema for validate tool input
 */
export const validateInputSchema = z.object({
  /** Path to SKILL.md file or skill directory */
  skill_path: z.string().min(1, 'skill_path is required'),
  /** Enable strict validation (default false) */
  strict: z.boolean().default(false),
})

/**
 * Input type (before parsing, allows optional fields)
 */
export type ValidateInput = z.input<typeof validateInputSchema>

/**
 * Output type (after parsing, with defaults applied)
 */
type ValidateParsed = z.output<typeof validateInputSchema>

/**
 * Validation error with severity
 */
export interface ValidationError {
  /** Field that has the error */
  field: string
  /** Error message */
  message: string
  /** Severity level */
  severity: 'error' | 'warning'
}

/**
 * Validation response
 */
export interface ValidateResponse {
  /** Whether the skill is valid */
  valid: boolean
  /** List of validation errors/warnings */
  errors: ValidationError[]
  /** Parsed metadata if valid */
  metadata: Record<string, unknown> | null
  /** File path validated */
  path: string
  /** Performance timing */
  timing: {
    totalMs: number
  }
}

/**
 * MCP tool schema definition for skill_validate
 */
export const validateToolSchema = {
  name: 'skill_validate',
  description:
    'Validate a SKILL.md file or skill directory against Skillsmith specification. Checks structure, required fields, and security patterns.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      skill_path: {
        type: 'string',
        description: 'Path to SKILL.md file or skill directory containing SKILL.md',
      },
      strict: {
        type: 'boolean',
        description:
          'Enable strict validation mode (default false). Strict mode treats warnings as errors.',
        default: false,
      },
    },
    required: ['skill_path'],
  },
}

/**
 * Maximum field lengths for validation
 */
const FIELD_LIMITS = {
  name: 64,
  description: 1024,
  author: 128,
  version: 32,
  category: 64,
  license: 64,
  tagLength: 32,
  maxTags: 20,
}

/**
 * Dangerous URL patterns for SSRF prevention
 */
const SSRF_PATTERNS = [
  /^file:\/\//i,
  /^gopher:\/\//i,
  /^dict:\/\//i,
  /^ldap:\/\//i,
  /localhost/i,
  /127\.0\.0\.\d+/,
  /0\.0\.0\.0/,
  /\[::1\]/,
  /10\.\d+\.\d+\.\d+/,
  /172\.(1[6-9]|2\d|3[01])\.\d+\.\d+/,
  /192\.168\.\d+\.\d+/,
]

/**
 * Path traversal patterns
 */
const PATH_TRAVERSAL_PATTERNS = [/\.\./, /\.\.%2[fF]/, /%2[eE]%2[eE]/, /\\\.\\./]

/**
 * Parse YAML frontmatter from markdown content
 */
function parseYamlFrontmatter(content: string): Record<string, unknown> | null {
  const trimmed = content.trim()

  if (!trimmed.startsWith('---')) {
    return null
  }

  const endIndex = trimmed.indexOf('---', 3)
  if (endIndex === -1) {
    return null
  }

  const yamlContent = trimmed.slice(3, endIndex).trim()
  const result: Record<string, unknown> = {}
  const lines = yamlContent.split('\n')
  let currentKey: string | null = null
  let arrayBuffer: string[] = []
  let inArray = false

  for (const line of lines) {
    const trimmedLine = line.trim()

    if (!trimmedLine || trimmedLine.startsWith('#')) {
      continue
    }

    if (trimmedLine.startsWith('- ')) {
      if (currentKey && inArray) {
        const value = trimmedLine
          .slice(2)
          .trim()
          .replace(/^["']|["']$/g, '')
        arrayBuffer.push(value)
      }
      continue
    }

    const colonIndex = trimmedLine.indexOf(':')
    if (colonIndex > 0) {
      if (currentKey && inArray && arrayBuffer.length > 0) {
        result[currentKey] = arrayBuffer
        arrayBuffer = []
      }

      const key = trimmedLine.slice(0, colonIndex).trim()
      const value = trimmedLine.slice(colonIndex + 1).trim()

      if (value === '' || value === '|' || value === '>') {
        currentKey = key
        inArray = true
        arrayBuffer = []
      } else {
        currentKey = null
        inArray = false

        let parsedValue: unknown = value
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          parsedValue = value.slice(1, -1)
        } else if (value === 'true') {
          parsedValue = true
        } else if (value === 'false') {
          parsedValue = false
        } else if (/^-?\d+(\.\d+)?$/.test(value)) {
          parsedValue = parseFloat(value)
        } else if (value.startsWith('[') && value.endsWith(']')) {
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

  if (currentKey && inArray && arrayBuffer.length > 0) {
    result[currentKey] = arrayBuffer
  }

  return result
}

/**
 * Check for SSRF patterns in a URL
 */
function hasSsrfPattern(url: string): boolean {
  return SSRF_PATTERNS.some((pattern) => pattern.test(url))
}

/**
 * Check for path traversal patterns
 */
function hasPathTraversal(path: string): boolean {
  return PATH_TRAVERSAL_PATTERNS.some((pattern) => pattern.test(path))
}

/**
 * Validate skill metadata
 */
function validateMetadata(metadata: Record<string, unknown>, strict: boolean): ValidationError[] {
  const errors: ValidationError[] = []

  // Required fields
  if (!metadata.name) {
    errors.push({
      field: 'name',
      message: 'Required field "name" is missing',
      severity: 'error',
    })
  } else if (typeof metadata.name !== 'string') {
    errors.push({
      field: 'name',
      message: 'Field "name" must be a string',
      severity: 'error',
    })
  } else if (metadata.name.length > FIELD_LIMITS.name) {
    errors.push({
      field: 'name',
      message: `Field "name" exceeds maximum length of ${FIELD_LIMITS.name} characters`,
      severity: 'error',
    })
  }

  // Description validation
  if (!metadata.description) {
    errors.push({
      field: 'description',
      message: 'Required field "description" is missing',
      severity: strict ? 'error' : 'warning',
    })
  } else if (typeof metadata.description !== 'string') {
    errors.push({
      field: 'description',
      message: 'Field "description" must be a string',
      severity: 'error',
    })
  } else if (metadata.description.length > FIELD_LIMITS.description) {
    errors.push({
      field: 'description',
      message: `Field "description" exceeds maximum length of ${FIELD_LIMITS.description} characters`,
      severity: 'error',
    })
  }

  // Author validation
  if (metadata.author !== undefined) {
    if (typeof metadata.author !== 'string') {
      errors.push({
        field: 'author',
        message: 'Field "author" must be a string',
        severity: 'error',
      })
    } else if (metadata.author.length > FIELD_LIMITS.author) {
      errors.push({
        field: 'author',
        message: `Field "author" exceeds maximum length of ${FIELD_LIMITS.author} characters`,
        severity: 'error',
      })
    }
  }

  // Version validation
  if (metadata.version !== undefined) {
    if (typeof metadata.version !== 'string') {
      errors.push({
        field: 'version',
        message: 'Field "version" must be a string',
        severity: 'error',
      })
    } else if (metadata.version.length > FIELD_LIMITS.version) {
      errors.push({
        field: 'version',
        message: `Field "version" exceeds maximum length of ${FIELD_LIMITS.version} characters`,
        severity: 'error',
      })
    }
  } else if (strict) {
    errors.push({
      field: 'version',
      message: 'Field "version" is recommended',
      severity: 'warning',
    })
  }

  // Tags validation
  if (metadata.tags !== undefined) {
    if (!Array.isArray(metadata.tags)) {
      errors.push({
        field: 'tags',
        message: 'Field "tags" must be an array',
        severity: 'error',
      })
    } else {
      if (metadata.tags.length > FIELD_LIMITS.maxTags) {
        errors.push({
          field: 'tags',
          message: `Field "tags" exceeds maximum count of ${FIELD_LIMITS.maxTags}`,
          severity: 'error',
        })
      }
      for (let i = 0; i < metadata.tags.length; i++) {
        const tag = metadata.tags[i]
        if (typeof tag !== 'string') {
          errors.push({
            field: `tags[${i}]`,
            message: 'Tag must be a string',
            severity: 'error',
          })
        } else if (tag.length > FIELD_LIMITS.tagLength) {
          errors.push({
            field: `tags[${i}]`,
            message: `Tag exceeds maximum length of ${FIELD_LIMITS.tagLength} characters`,
            severity: 'error',
          })
        }
      }
    }
  } else if (strict) {
    errors.push({
      field: 'tags',
      message: 'Field "tags" is recommended for discoverability',
      severity: 'warning',
    })
  }

  // Security: Check repository URL for SSRF
  if (metadata.repository !== undefined) {
    if (typeof metadata.repository !== 'string') {
      errors.push({
        field: 'repository',
        message: 'Field "repository" must be a string',
        severity: 'error',
      })
    } else if (hasSsrfPattern(metadata.repository)) {
      errors.push({
        field: 'repository',
        message: 'Field "repository" contains potentially dangerous URL pattern',
        severity: 'error',
      })
    }
  }

  // Security: Check homepage URL for SSRF
  if (metadata.homepage !== undefined) {
    if (typeof metadata.homepage !== 'string') {
      errors.push({
        field: 'homepage',
        message: 'Field "homepage" must be a string',
        severity: 'error',
      })
    } else if (hasSsrfPattern(metadata.homepage)) {
      errors.push({
        field: 'homepage',
        message: 'Field "homepage" contains potentially dangerous URL pattern',
        severity: 'error',
      })
    }
  }

  // Security: Check for path traversal in any string fields
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === 'string' && hasPathTraversal(value)) {
      errors.push({
        field: key,
        message: `Field "${key}" contains path traversal pattern`,
        severity: 'error',
      })
    }
  }

  return errors
}

/**
 * Execute skill validation.
 *
 * Validates a SKILL.md file against the Skillsmith specification.
 * Checks structure, required fields, field lengths, and security patterns.
 *
 * @param input - Validation parameters
 * @returns Promise resolving to validation response
 * @throws {SkillsmithError} When path is invalid or file cannot be read
 *
 * @example
 * const response = await executeValidate({
 *   skill_path: './skills/my-skill/SKILL.md',
 *   strict: true
 * });
 * if (response.valid) {
 *   console.log('Skill is valid:', response.metadata);
 * } else {
 *   console.log('Errors:', response.errors);
 * }
 */
export async function executeValidate(input: ValidateInput): Promise<ValidateResponse> {
  const startTime = performance.now()

  // Validate input with Zod
  const validated = validateInputSchema.parse(input)
  const { skill_path, strict } = validated

  // Security: Check for path traversal in input path
  if (hasPathTraversal(skill_path)) {
    throw new SkillsmithError(
      ErrorCodes.VALIDATION_INVALID_TYPE,
      'Path contains path traversal pattern',
      { details: { path: skill_path } }
    )
  }

  // Determine actual file path
  let filePath = skill_path
  let isDirectory = false

  try {
    const stats = await fs.stat(skill_path)
    isDirectory = stats.isDirectory()

    if (isDirectory) {
      filePath = join(skill_path, 'SKILL.md')
    }
  } catch {
    // Path doesn't exist or is inaccessible
    throw new SkillsmithError(ErrorCodes.SKILL_NOT_FOUND, `Path not found: ${skill_path}`, {
      details: { path: skill_path },
    })
  }

  // Read file content
  let content: string
  try {
    content = await fs.readFile(filePath, 'utf-8')
  } catch {
    throw new SkillsmithError(ErrorCodes.SKILL_NOT_FOUND, `Cannot read file: ${filePath}`, {
      details: { path: filePath },
    })
  }

  // Parse frontmatter
  const metadata = parseYamlFrontmatter(content)
  const errors: ValidationError[] = []

  if (!metadata) {
    errors.push({
      field: 'frontmatter',
      message:
        'Failed to parse YAML frontmatter. Ensure file starts with "---" and ends with "---"',
      severity: 'error',
    })
  } else {
    // Validate metadata
    errors.push(...validateMetadata(metadata, strict))
  }

  // Determine validity
  const hasErrors = errors.some((e) => e.severity === 'error')
  const valid = !hasErrors

  const endTime = performance.now()

  return {
    valid,
    errors,
    metadata: valid && metadata ? metadata : null,
    path: filePath,
    timing: {
      totalMs: Math.round(endTime - startTime),
    },
  }
}

/**
 * Format validation results for terminal display
 */
export function formatValidationResults(response: ValidateResponse): string {
  const lines: string[] = []

  lines.push('\n=== Skill Validation Results ===\n')
  lines.push(`Path: ${response.path}`)
  lines.push('')

  if (response.valid) {
    lines.push('Status: VALID')
    lines.push('')

    if (response.metadata) {
      lines.push('Metadata:')
      if (response.metadata.name) {
        lines.push(`  Name: ${response.metadata.name}`)
      }
      if (response.metadata.description) {
        const desc = String(response.metadata.description)
        lines.push(`  Description: ${desc.slice(0, 80)}${desc.length > 80 ? '...' : ''}`)
      }
      if (response.metadata.author) {
        lines.push(`  Author: ${response.metadata.author}`)
      }
      if (response.metadata.version) {
        lines.push(`  Version: ${response.metadata.version}`)
      }
      if (response.metadata.tags && Array.isArray(response.metadata.tags)) {
        lines.push(`  Tags: ${response.metadata.tags.join(', ')}`)
      }
    }
  } else {
    lines.push('Status: INVALID')
    lines.push('')
  }

  if (response.errors.length > 0) {
    const errorCount = response.errors.filter((e) => e.severity === 'error').length
    const warningCount = response.errors.filter((e) => e.severity === 'warning').length

    lines.push(`Issues: ${errorCount} error(s), ${warningCount} warning(s)`)
    lines.push('')

    for (const error of response.errors) {
      const prefix = error.severity === 'error' ? '[ERROR]' : '[WARN]'
      lines.push(`  ${prefix} ${error.field}: ${error.message}`)
    }
  }

  lines.push('')
  lines.push('---')
  lines.push(`Completed in ${response.timing.totalMs}ms`)

  return lines.join('\n')
}
