/**
 * SMI-911: Onboarding Module
 *
 * Exports first-run detection and Tier 1 skill auto-installation functionality.
 */

export {
  SKILLSMITH_DIR,
  FIRST_RUN_MARKER,
  TIER1_SKILLS,
  isFirstRun,
  markFirstRunComplete,
  getWelcomeMessage,
  type Tier1Skill,
} from './first-run.js'
