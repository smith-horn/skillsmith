/**
 * Type definitions for SkillDetailPanel
 */

/**
 * Score breakdown type for skill quality metrics
 */
export interface ScoreBreakdown {
  quality: number
  popularity: number
  maintenance: number
  security: number
  documentation: number
}

/**
 * Extended skill data with optional fields from MCP
 */
export interface ExtendedSkillData {
  id: string
  name: string
  description: string
  author: string
  category: string
  trustTier: string
  score: number
  repository: string | undefined
  version: string | undefined
  tags: string[] | undefined
  installCommand: string | undefined
  scoreBreakdown: ScoreBreakdown | undefined
}

/**
 * Message types received from the webview
 */
export interface SkillPanelMessage {
  command: 'install' | 'openRepository'
  url?: string
}
