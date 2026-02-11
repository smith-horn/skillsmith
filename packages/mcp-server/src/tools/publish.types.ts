/**
 * Publish Tool Types and Schemas
 * @module @skillsmith/mcp-server/tools/publish.types
 * @see SMI-2440: MCP Publish Tool
 */

import { z } from 'zod'

/**
 * Zod schema for publish tool input
 */
export const publishInputSchema = z.object({
  /** Path to the skill directory (must contain SKILL.md) */
  skill_path: z.string().min(1, 'skill_path is required'),
  /** Run reference check before publishing (default: true) */
  check_references: z.boolean().default(true),
  /** Additional reference patterns to check (regex strings) */
  reference_patterns: z.array(z.string()).optional(),
  /** Create GitHub repository (requires gh CLI) */
  create_repo: z.boolean().default(false),
  /** GitHub visibility if creating repo (default: 'public') */
  visibility: z.enum(['public', 'private']).default('public'),
  /** Add claude-skill topic for registry discovery */
  add_topic: z.boolean().default(false),
})

/**
 * Input type (before parsing, allows optional fields)
 */
export type PublishInput = z.input<typeof publishInputSchema>

/**
 * Reference warning from project-specific reference scanning
 */
export interface ReferenceWarning {
  /** File where reference was found */
  file: string
  /** Line number */
  line: number
  /** Matched text (truncated to 80 chars) */
  text: string
  /** Pattern that matched */
  pattern: string
}

/**
 * Pre-flight check results for GitHub CLI
 */
export interface PreflightResult {
  /** Whether gh CLI is installed */
  ghAvailable: boolean
  /** Whether gh CLI is authenticated */
  ghAuthenticated: boolean
}

/**
 * Publish response
 */
export interface PublishResponse {
  /** Whether publish preparation succeeded */
  success: boolean
  /** Skill metadata */
  metadata: {
    name: string
    version: string
    checksum: string
    trustTier: string
  } | null
  /** Reference check results (if enabled) */
  referenceWarnings: ReferenceWarning[]
  /** GitHub repo URL (if created) */
  repoUrl?: string
  /** Pre-flight check results */
  preflight?: PreflightResult
  /** Next steps for the user */
  nextSteps: string[]
  /** Error message if failed */
  error?: string
}

/**
 * MCP tool schema definition for publish
 */
export const publishToolSchema = {
  name: 'publish',
  description:
    'Prepare a skill for publishing. Validates the skill, generates a checksum, ' +
    'creates a publish manifest, and optionally checks for project-specific references. ' +
    'Can also create a GitHub repository for registry discovery.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      skill_path: {
        type: 'string',
        description: 'Path to the skill directory (must contain SKILL.md)',
      },
      check_references: {
        type: 'boolean',
        description: 'Run reference check before publishing (default: true)',
        default: true,
      },
      reference_patterns: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional regex patterns to check (regex strings)',
      },
      create_repo: {
        type: 'boolean',
        description: 'Create GitHub repository (requires gh CLI — will pre-flight check)',
        default: false,
      },
      visibility: {
        type: 'string',
        enum: ['public', 'private'],
        description: "GitHub visibility if creating repo (default: 'public')",
        default: 'public',
      },
      add_topic: {
        type: 'boolean',
        description: 'Add claude-skill topic for registry discovery',
        default: false,
      },
    },
    required: ['skill_path'],
  },
}
