/**
 * MCP Tools exports
 */

// Search tool (SMI-581)
export { searchToolSchema, executeSearch, formatSearchResults } from './search.js'
export type { SearchInput } from './search.js'

// Install tool (SMI-586)
export { installTool, installSkill, installInputSchema } from './install.js'
export type { InstallInput, InstallResult } from './install.js'

// Uninstall tool (SMI-588)
export {
  uninstallTool,
  uninstallSkill,
  uninstallInputSchema,
  listInstalledSkills,
} from './uninstall.js'
export type { UninstallInput, UninstallResult } from './uninstall.js'

// Get skill tool (SMI-582)
export { getSkillToolSchema, executeGetSkill } from './get-skill.js'
export type { GetSkillInput } from './get-skill.js'

// Recommend tool (SMI-741)
export {
  recommendToolSchema,
  recommendInputSchema,
  executeRecommend,
  formatRecommendations,
} from './recommend.js'
export type { RecommendInput, SkillRecommendation, RecommendResponse } from './recommend.js'

// Validate tool (SMI-742)
export {
  validateToolSchema,
  validateInputSchema,
  executeValidate,
  formatValidationResults,
} from './validate.js'
export type { ValidateInput, ValidationError, ValidateResponse } from './validate.js'

// Compare tool (SMI-743)
export {
  compareToolSchema,
  compareInputSchema,
  executeCompare,
  formatComparisonResults,
} from './compare.js'
export type { CompareInput, SkillSummary, SkillDifference, CompareResponse } from './compare.js'
