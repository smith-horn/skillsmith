/**
 * CLI Templates
 *
 * Export all templates for skill scaffolding.
 */

export { SKILL_MD_TEMPLATE } from './skill.md.template.js'
export { README_MD_TEMPLATE } from './readme.md.template.js'
export {
  SUBAGENT_MD_TEMPLATE,
  CLAUDE_MD_SNIPPET_TEMPLATE,
  renderSubagentTemplate,
  renderClaudeMdSnippet,
} from './subagent.md.template.js'
export {
  renderMcpServerTemplates,
  type McpServerTemplateData,
  type McpToolDefinition,
  type McpParameterDefinition,
} from './mcp-server.template.js'
