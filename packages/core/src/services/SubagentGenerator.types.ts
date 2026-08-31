/**
 * SMI-1788: Types for SubagentGenerator — split out under the 500-line
 * standard (SMI-6276) following this directory's existing `.types.ts`
 * convention (see SkillAnalyzer.types.ts / SkillDecomposer.types.ts).
 */

/**
 * SMI-1795: Claude model constants for type safety and consistency
 */
export const CLAUDE_MODELS = {
  HAIKU: 'haiku',
  SONNET: 'sonnet',
  OPUS: 'opus',
} as const

export type ClaudeModel = (typeof CLAUDE_MODELS)[keyof typeof CLAUDE_MODELS]

/**
 * Generated subagent definition
 */
export interface SubagentDefinition {
  /** Subagent name (e.g., "jest-helper-specialist") */
  name: string

  /** Description for the Task tool */
  description: string

  /** Trigger phrases that should invoke this subagent */
  triggerPhrases: string[]

  /** Tools the subagent needs access to */
  tools: string[]

  /** Recommended model */
  model: ClaudeModel

  /** The full markdown content for the target client's companion-agent directory */
  content: string
}

/**
 * Result of subagent generation
 */
export interface SubagentGenerationResult {
  /** Whether a subagent was generated */
  generated: boolean

  /** The subagent definition (if generated) */
  subagent?: SubagentDefinition

  /** Reason if not generated */
  reason?: string

  /** CLAUDE.md integration snippet */
  claudeMdSnippet?: string
}
