/**
 * Core skill type definitions
 * Canonical types used across the extension for skill data.
 */

/** Core skill data -- used across the extension */
export interface SkillData {
  id: string
  name: string
  description: string
  author: string
  category: string
  trustTier: string
  score: number
  repository?: string
}

/** Score breakdown for skill quality metrics */
export interface ScoreBreakdown {
  quality: number
  popularity: number
  maintenance: number
  security: number
  documentation: number
}

/** Extended skill data with MCP-only fields (version, tags, score breakdown) */
export interface ExtendedSkillData extends SkillData {
  version: string | undefined
  tags: string[] | undefined
  installCommand: string | undefined
  scoreBreakdown: ScoreBreakdown | undefined
  /** SMI-3672: Raw SKILL.md content (markdown), when available */
  content?: string | undefined
}
