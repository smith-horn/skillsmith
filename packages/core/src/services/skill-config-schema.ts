/**
 * @fileoverview Zod schema for skill config.json validation
 * @module @skillsmith/core/services/skill-config-schema
 * @see SMI-3870: Config.json Schema Validation
 *
 * Validates config.json files fetched during skill installation.
 * v1 uses .passthrough() — logs unknown keys as warnings but does not reject.
 */

import { z } from 'zod'

/**
 * Schema for skill config.json files.
 * v1: passthrough mode — unknown keys logged as warnings, not rejected.
 * Switch to .strict() after publishing the schema spec.
 */
export const SkillConfigSchema = z
  .object({
    /** Skill display name override */
    displayName: z.string().max(100).optional(),
    /** Version constraint */
    version: z.string().max(20).optional(),
    /** Configuration presets (values must be primitives) */
    presets: z
      .record(z.string(), z.union([z.string().max(500), z.number(), z.boolean()]))
      .optional(),
    /** Custom settings (values must be primitives) */
    settings: z
      .record(z.string().max(50), z.union([z.string().max(500), z.number(), z.boolean()]))
      .optional(),
    /** MCP server requirements */
    mcpServers: z.array(z.string().max(100)).max(10).optional(),
    /** Minimum Claude Code version */
    minClaudeCodeVersion: z.string().max(20).optional(),
  })
  .passthrough()

export type SkillConfig = z.infer<typeof SkillConfigSchema>

const KNOWN_KEYS = [
  'displayName',
  'version',
  'presets',
  'settings',
  'mcpServers',
  'minClaudeCodeVersion',
]

export interface ConfigValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  /** Sanitized config (only if valid) */
  config?: SkillConfig
}

/**
 * Validate a config.json string against the skill config schema.
 * Returns validation result with errors and warnings for unknown keys.
 */
export function validateSkillConfig(content: string): ConfigValidationResult {
  try {
    const parsed: unknown = JSON.parse(content)
    const result = SkillConfigSchema.safeParse(parsed)
    if (!result.success) {
      return {
        valid: false,
        errors: result.error.issues.map((i) => i.path.join('.') + ': ' + i.message),
        warnings: [],
      }
    }
    // v1 passthrough: log unknown keys as warnings
    const warnings: string[] = []
    if (parsed !== null && typeof parsed === 'object') {
      const unknownKeys = Object.keys(parsed as Record<string, unknown>).filter(
        (k) => !KNOWN_KEYS.includes(k)
      )
      if (unknownKeys.length > 0) {
        warnings.push(
          'config.json contains unknown keys: ' + unknownKeys.join(', ') + '. These are ignored.'
        )
      }
    }
    return { valid: true, errors: [], warnings, config: result.data }
  } catch (e) {
    return {
      valid: false,
      errors: ['Invalid JSON: ' + (e instanceof Error ? e.message : 'parse error')],
      warnings: [],
    }
  }
}
