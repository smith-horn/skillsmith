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

import { promises as fs } from 'fs'
import { join } from 'path'
import { SkillsmithError, ErrorCodes } from '@skillsmith/core'
import type { ToolContext } from '../context.js'

// Import types
import type { ValidateInput, ValidateResponse, ValidationError } from './validate.types.js'
import { validateInputSchema } from './validate.types.js'

// Import helpers
import { parseYamlFrontmatter, hasPathTraversal, validateMetadata } from './validate.helpers.js'

// Re-export only public API types (SMI-1718: trimmed internal exports)
export type { ValidateInput, ValidateResponse, ValidationError } from './validate.types.js'
export { validateInputSchema, validateToolSchema } from './validate.types.js'

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
export async function executeValidate(
  input: ValidateInput,
  _context?: ToolContext
): Promise<ValidateResponse> {
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
