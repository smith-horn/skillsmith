/**
 * @fileoverview MCP Tool Definition for install_skill
 * @module @skillsmith/mcp-server/tools/install.tool
 * @see SMI-2741: Split from install.ts to meet 500-line standard
 *
 * The MCP tool schema definition for the install_skill tool, extracted
 * from install.ts to keep that file within the 500-line limit.
 */

/**
 * MCP tool definition for install_skill
 */
export const installTool = {
  name: 'install_skill',
  description:
    'Install a Claude Code skill from GitHub. Performs security scan and Skillsmith optimization before installation.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      skillId: {
        type: 'string',
        description: 'Skill ID (owner/repo/skill) or GitHub URL',
      },
      force: {
        type: 'boolean',
        description: 'Force reinstall if skill already exists',
      },
      skipScan: {
        type: 'boolean',
        description: 'Skip security scan (not recommended)',
      },
      skipOptimize: {
        type: 'boolean',
        description: 'Skip Skillsmith optimization (decomposition, subagent generation)',
      },
      conflictAction: {
        type: 'string',
        enum: ['overwrite', 'merge', 'cancel'],
        description:
          'Action when local modifications detected: overwrite (backup + replace), merge (three-way), or cancel',
      },
      confirmed: {
        type: 'boolean',
        description:
          'Confirm install despite security warnings (required for experimental/unknown tier skills)',
      },
      // SMI-4578: multi-client install
      client: {
        type: 'string',
        enum: ['claude-code', 'cursor', 'copilot', 'windsurf', 'agents'],
        description:
          'Target agent (default: SKILLSMITH_CLIENT env or claude-code). Codex users pass agents.',
      },
      alsoLink: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['claude-code', 'cursor', 'copilot', 'windsurf', 'agents'],
        },
        description:
          'Additional clients to fan-out into (default: copy; pair with symlink for POSIX symlinks)',
      },
      symlink: {
        type: 'boolean',
        description:
          'Use relative symlinks instead of file copies for alsoLink targets (POSIX only; falls back to copy on Windows EPERM)',
      },
    },
    required: ['skillId'],
  },
}

export default installTool
