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
// SMI-1389, SMI-1390: Subagent Generation
// SMI-1433: MCP Server Scaffolding
// SMI-1487: Refactored into modular structure
export {
  createInitCommand,
  createValidateCommand,
  createPublishCommand,
  createSubagentCommand,
  createTransformCommand,
  createMcpInitCommand,
} from './author/index.js'

// SMI-1283: Codebase Analysis
export { createAnalyzeCommand } from './analyze.js'

// SMI-1299: Recommendations
export { createRecommendCommand } from './recommend.js'

// Registry Sync
export { createSyncCommand } from './sync.js'

// SMI-1455: Database Merge Command
export { createMergeCommand } from './merge.js'

// SMI-3484: Install skill from registry/GitHub
export { createInstallCommand } from './install.js'

// SMI-824: Install Skillsmith Skill Command (renamed to 'setup')
export { createInstallSkillCommand } from './install-skill.js'

// SMI-2715: CLI Login Device Flow
export { createLoginCommand } from './login.js'
export { createLogoutCommand } from './logout.js'
export { createWhoamiCommand } from './whoami.js'

// SMI-skill-version-tracking Wave 2: diff, pin, unpin
export { createDiffCommand } from './diff.js'
export { createPinCommand, createUnpinCommand } from './pin.js'

// SMI-skill-version-tracking Wave 3: Security Advisory Audit
export { createAuditCommand } from './audit.js'

// SMI-3083: Embedded skill scaffolding
export { createCreateCommand, createSkill, validateSkillName } from './create.js'

// SMI-3672: Skill info with SKILL.md content
export { createInfoCommand } from './info.js'
