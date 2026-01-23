/**
 * Validate Tool Types and Schemas
 * @module @skillsmith/mcp-server/tools/validate.types
 */

import { z } from 'zod'

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
export const FIELD_LIMITS = {
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
export const SSRF_PATTERNS = [
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
  /169\.254\.\d+\.\d+/, // SMI-1723: Cloud metadata service (AWS, Azure, GCP)
]

/**
 * Path traversal patterns
 */
export const PATH_TRAVERSAL_PATTERNS = [/\.\./, /\.\.%2[fF]/, /%2[eE]%2[eE]/, /\\\.\\./]
