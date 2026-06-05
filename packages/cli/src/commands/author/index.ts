/**
 * SMI-746: Skill Authoring Commands
 * SMI-1389: Subagent Generation Command
 * SMI-1390: Transform Command
 * SMI-1433: MCP Server Scaffolding
 * SMI-1487: Refactored into modular structure
 *
 * Provides CLI commands for creating, validating, publishing skills,
 * and generating companion subagents.
 */

// Re-export command creators
// SMI-5129: the command factories moved to init.action.ts (sibling-split);
// the logic functions + types stay in init.ts.
export { createInitCommand, createValidateCommand, createPublishCommand } from './init.action.js'
export {
  initSkill,
  validateSkill,
  publishSkill,
  type InitOptions,
  VALID_CATEGORIES,
} from './init.js'

export { createSubagentCommand, generateSubagent, type SubagentOptions } from './subagent.js'

export { createTransformCommand, transformSkill, type TransformOptions } from './transform.js'

export { createMcpInitCommand, initMcpServer, type McpInitOptions } from './mcp-init.js'

// Re-export utilities that may be useful externally
export {
  printValidationResult,
  fileExists,
  ensureAgentsDirectory,
  extractTriggerPhrases,
  validateSubagentDefinition,
} from './utils.js'
