/**
 * CLI Commands
 *
 * Export all CLI commands for registration.
 */

// SMI-744: Interactive Search
export { createSearchCommand } from './search.js'

// SMI-745: Skill Management
export { createListCommand, createUpdateCommand, createRemoveCommand } from './manage.js'

// SMI-746: Skill Authoring
export { createInitCommand, createValidateCommand, createPublishCommand } from './author.js'

// SMI-1389, SMI-1390: Subagent Generation
export { createSubagentCommand, createTransformCommand } from './author.js'

// SMI-1283: Codebase Analysis
export { createAnalyzeCommand } from './analyze.js'

// SMI-1299: Recommendations
export { createRecommendCommand } from './recommend.js'
