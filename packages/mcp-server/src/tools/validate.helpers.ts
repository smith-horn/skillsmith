/**
 * Validate Tool Helper Functions
 * @module @skillsmith/mcp-server/tools/validate.helpers
 */

import type { ValidationError } from './validate.types.js'
import { FIELD_LIMITS, SSRF_PATTERNS, PATH_TRAVERSAL_PATTERNS } from './validate.types.js'
import { KNOWN_IDES, KNOWN_LLMS } from '../utils/validation.js'

/**
 * Parse YAML frontmatter from markdown content
 */
export function parseYamlFrontmatter(content: string): Record<string, unknown> | null {
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
export function hasSsrfPattern(url: string): boolean {
  return SSRF_PATTERNS.some((pattern) => pattern.test(url))
}

/**
 * Check for path traversal patterns
 */
export function hasPathTraversal(path: string): boolean {
  return PATH_TRAVERSAL_PATTERNS.some((pattern) => pattern.test(path))
}

/**
 * Validate skill metadata
 */
export function validateMetadata(
  metadata: Record<string, unknown>,
  strict: boolean
): ValidationError[] {
  const errors: ValidationError[] = []

  // Required fields - name
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

  // SMI-2759: Warn on missing repository for published (versioned) skills or --strict
  if (metadata.repository === undefined && (metadata.version !== undefined || strict)) {
    errors.push({
      field: 'repository',
      message:
        'Field "repository" is recommended for published skills (links to source for transparency)',
      severity: 'warning',
    })
  }

  // SMI-2760: Warn on missing compatibility for published (versioned) skills or --strict
  if (metadata.compatibility === undefined && (metadata.version !== undefined || strict)) {
    errors.push({
      field: 'compatibility',
      message:
        'Field "compatibility" is recommended for published skills (e.g. ["claude-code", "cursor", "claude"]). ' +
        `Known IDEs: ${KNOWN_IDES.join(', ')}. Known LLMs: ${KNOWN_LLMS.join(', ')}.`,
      severity: 'warning',
    })
  }

  // SMI-2760: Validate known compatibility values if present
  if (metadata.compatibility !== undefined && Array.isArray(metadata.compatibility)) {
    const knownValues = new Set([...KNOWN_IDES, ...KNOWN_LLMS])
    for (const tag of metadata.compatibility) {
      if (typeof tag === 'string' && !knownValues.has(tag)) {
        errors.push({
          field: 'compatibility',
          message: `Unknown compatibility value "${tag}". Known IDEs: ${KNOWN_IDES.join(', ')}. Known LLMs: ${KNOWN_LLMS.join(', ')}.`,
          severity: 'warning',
        })
      }
    }
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
 * Detect if a skill appears to modify CLAUDE.md files.
 * Returns warnings if the skill body contains patterns suggesting CLAUDE.md modification.
 * This is a heuristic check — false positives are possible.
 */
export function detectClaudeMdModification(body: string): string[] {
  const warnings: string[] = []

  const claudeMdPatterns = [
    /CLAUDE\.md/i,
    /progressive\s+disclosure/i,
    /sub-document/i,
    /optimize.*claude/i,
  ]

  const modifiesClaudeMd = claudeMdPatterns.some((p) => p.test(body))

  if (modifiesClaudeMd) {
    warnings.push(
      'This skill appears to modify CLAUDE.md. ' +
        'Ensure it detects CI scripts that regex-scan CLAUDE.md and preserves matched content inline. ' +
        'See: docs/internal/architecture/standards.md#ci-machine-readable-content-dependencies'
    )
  }

  return warnings
}
