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
  command:
    | 'install'
    | 'openRepository'
    | 'openExternal'
    | 'expandContent'
    | 'retry'
    | 'uninstall'
    | 'openSkillFile'
    | 'openFolder'
  url?: string
}

/**
 * Drives the panel's conditional action block (#1437 / SMI-5308).
 *
 * Resolved at load time from the installed-skill cross-reference: when the skill
 * being viewed is also installed locally, `installed` is true and `skillPath`
 * points at the on-disk directory. `hasSkillMd` gates the "Open SKILL.md" action
 * so it never targets an absent file.
 */
export interface SkillActionContext {
  installed: boolean
  skillPath?: string
  hasSkillMd?: boolean
}
