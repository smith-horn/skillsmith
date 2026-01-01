/**
 * SMI-911: First Run Detection and Tier 1 Skill Auto-Installation
 *
 * Detects first run of Skillsmith MCP server and provides:
 * - First run detection via marker file
 * - Tier 1 skills list for auto-installation
 * - Welcome message formatting
 *
 * Tier 1 skills (from research doc):
 * - varlock (score: 95) - Security foundation
 * - commit (score: 92) - Git workflow
 * - governance (score: 88) - Code quality
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

/**
 * Skillsmith configuration directory
 */
export const SKILLSMITH_DIR = join(homedir(), '.skillsmith')

/**
 * Marker file indicating first run is complete
 */
export const FIRST_RUN_MARKER = join(SKILLSMITH_DIR, '.first-run-complete')

/**
 * Tier 1 skill definition
 */
export interface Tier1Skill {
  /** Full skill ID (e.g., 'anthropic/varlock') */
  id: string
  /** Short name for display */
  name: string
  /** Quality score from research (0-100) */
  score: number
}

/**
 * Tier 1 skills to auto-install on first run
 *
 * These are the highest-value, lowest-friction skills identified
 * in the skill prioritization research.
 */
export const TIER1_SKILLS: readonly Tier1Skill[] = [
  { id: 'anthropic/varlock', name: 'varlock', score: 95 },
  { id: 'anthropic/commit', name: 'commit', score: 92 },
  { id: 'anthropic/governance', name: 'governance', score: 88 },
] as const

/**
 * Check if this is the first run of Skillsmith
 *
 * First run is detected by the absence of the marker file
 * at ~/.skillsmith/.first-run-complete
 *
 * @returns true if this is the first run, false otherwise
 */
export function isFirstRun(): boolean {
  return !existsSync(FIRST_RUN_MARKER)
}

/**
 * Mark first run as complete
 *
 * Creates the marker file at ~/.skillsmith/.first-run-complete
 * with the current timestamp. Also ensures the .skillsmith
 * directory exists.
 */
export function markFirstRunComplete(): void {
  if (!existsSync(SKILLSMITH_DIR)) {
    mkdirSync(SKILLSMITH_DIR, { recursive: true })
  }
  writeFileSync(FIRST_RUN_MARKER, new Date().toISOString())
}

/**
 * Generate welcome message after first run setup
 *
 * @param installedSkills - List of skill names that were installed
 * @returns Formatted welcome message
 */
export function getWelcomeMessage(installedSkills: string[]): string {
  const skillList = installedSkills.map((s) => `  - ${s}`).join('\n')

  return `
Welcome to Skillsmith!

Essential skills installed:
${skillList}

Try: "Write a commit message" to see the commit skill in action.
`.trim()
}
