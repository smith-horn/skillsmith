/**
 * SMI-1788: SkillDecomposer Types
 *
 * Type definitions for skill decomposition into sub-skills.
 * Used by the Skillsmith Optimization Layer for transforming
 * large skills into more performant versions.
 */

/**
 * Result of skill decomposition
 */
export interface DecompositionResult {
  /** The optimized main SKILL.md content */
  mainSkill: DecomposedSkill

  /** Extracted sub-skills */
  subSkills: SubSkill[]

  /** Whether decomposition was applied */
  wasDecomposed: boolean

  /** Statistics about the decomposition */
  stats: DecompositionStats
}

/**
 * The main skill after decomposition
 */
export interface DecomposedSkill {
  /** Filename (always SKILL.md) */
  filename: string

  /** The optimized content */
  content: string

  /** Line count after optimization */
  lineCount: number

  /** References to sub-skills */
  subSkillRefs: string[]
}

/**
 * An extracted sub-skill
 */
export interface SubSkill {
  /** Filename (e.g., api.md, examples.md) */
  filename: string

  /** Original section name */
  sectionName: string

  /** The extracted content */
  content: string

  /** Line count */
  lineCount: number

  /** Why this section was extracted */
  extractionReason: string
}

/**
 * Statistics about the decomposition
 */
export interface DecompositionStats {
  /** Original line count */
  originalLines: number

  /** Main skill line count after decomposition */
  mainSkillLines: number

  /** Total lines in sub-skills */
  subSkillLines: number

  /** Number of sub-skills created */
  subSkillCount: number

  /** Estimated token reduction percentage */
  tokenReductionPercent: number
}

/**
 * Metadata extracted from SKILL.md frontmatter
 */
export interface SkillMetadata {
  name?: string
  description?: string
  [key: string]: string | undefined
}

/**
 * Configuration for decomposition behavior
 */
export interface DecomposerOptions {
  /** Maximum lines for main skill (default: 400) */
  maxMainSkillLines?: number

  /** Minimum lines for a section to be extracted (default: 50) */
  minExtractableLines?: number

  /** Whether to add navigation links to main skill (default: true) */
  addNavigation?: boolean

  /** Whether to add "Optimized by Skillsmith" attribution (default: true) */
  addAttribution?: boolean

  /**
   * Keywords that indicate a section should be extracted as a sub-skill.
   * Sections with titles containing these keywords will be candidates for extraction.
   * @default ['api', 'reference', 'example', 'usage', 'advanced', 'configuration', 'troubleshoot', 'appendix']
   */
  extractKeywords?: string[]
}

/**
 * Parsed section from skill content (internal)
 */
export interface ParsedSection {
  level: number
  title: string
  startLine: number
  lines: string[]
}

/**
 * Resolved decomposer options with all required fields
 */
export type ResolvedDecomposerOptions = Required<DecomposerOptions>
