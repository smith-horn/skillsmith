/**
 * SMI-4813: SkillParser type surface, extracted from SkillParser.ts so the
 * class file stays under the audit:standards 500-line gate. Public surface
 * is preserved by re-export from `SkillParser.ts` and `indexer/index.ts`.
 *
 * SMI-628: Original SkillParser frontmatter / metadata types.
 */

import type { ConflictDeclaration, DependencyDeclaration } from '../types/dependencies.js'

/**
 * Raw metadata extracted from SKILL.md frontmatter
 */
export interface SkillFrontmatter {
  name: string
  description?: string
  author?: string
  version?: string
  tags?: string[]
  /** SMI-3135: Structured dependency declaration (replaces string[]) */
  dependencies?: DependencyDeclaration
  category?: string
  license?: string
  repository?: string
  homepage?: string
  /** SMI-2760: Compatibility tags — IDE, LLM, and platform values */
  compatibility?: string[]
  /** SMI-3135: Conflict declarations */
  conflicts?: ConflictDeclaration[]
  /** SMI-3135: Deprecation flag */
  deprecated?: boolean
  /** SMI-3135: Skill that supersedes this one */
  superseded_by?: string | null
  /** @deprecated Use dependencies.skills instead */
  composes?: string[]
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
  /** SMI-3135: Structured dependency declaration (replaces string[]) */
  dependencies?: DependencyDeclaration
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
