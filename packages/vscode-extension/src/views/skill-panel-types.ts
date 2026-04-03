/**
 * Type definitions for SkillDetailPanel
 * ExtendedSkillData and ScoreBreakdown are canonical in types/skill.ts;
 * re-exported here for backwards compatibility.
 */

export type { ScoreBreakdown, ExtendedSkillData } from '../types/skill.js'

/**
 * Message types received from the webview
 */
export interface SkillPanelMessage {
  command: 'install' | 'openRepository' | 'openExternal' | 'expandContent' | 'retry'
  url?: string
}
