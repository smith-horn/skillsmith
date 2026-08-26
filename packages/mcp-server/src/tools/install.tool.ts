/**
 * @fileoverview MCP Tool Definition for install_skill
 * @module @skillsmith/mcp-server/tools/install.tool
 * @see SMI-2741: Split from install.ts to meet 500-line standard
 *
 * The MCP tool schema definition for the install_skill tool, extracted
 * from install.ts to keep that file within the 500-line limit.
 */

import { CLIENT_IDS } from '@skillsmith/core/install'

/**
 * MCP tool definition for install_skill
 *
 * SMI-5982 (Wave 6) audit finding: `client`/`alsoLink` `enum` below used to
 * be a hand-duplicated 5-value literal, independently stale from the zod
 * schema's own copy in install.types.ts (both predated opencode/hermes/grok)
 * — now both derive from the same `CLIENT_IDS` source of truth.
 */
export const installTool = {
  name: 'install_skill',
  description:
    "[Skillsmith — Install stage] Install an agent skill (SKILL.md format) from the Skillsmith registry or a GitHub repository to the local Claude Code skills directory (~/.claude/skills/) — or runtime-equivalent path when SKILLSMITH_CLIENT is set (cursor, copilot, windsurf). Use when the user asks to install/add/get a specific skill — e.g. 'install playwright-cli', 'add getsentry/commit', 'use Skillsmith to install the testing skill'. Performs Skillsmith security scan and content optimization (decomposition, subagent generation) before installation. Returns install path and Skillsmith optimization summary. Skillsmith is a registry for sharing, scanning, and tracking agent skills across any MCP-capable runtime.",
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
        enum: [...CLIENT_IDS],
        description:
          'Target agent (default: SKILLSMITH_CLIENT env or claude-code). Codex users pass agents.',
      },
      alsoLink: {
        type: 'array',
        items: {
          type: 'string',
          enum: [...CLIENT_IDS],
        },
        description:
          'Additional clients to fan-out into (default: copy; pair with symlink for POSIX symlinks)',
      },
      symlink: {
        type: 'boolean',
        description:
          'Use relative symlinks instead of file copies for alsoLink targets (POSIX only; falls back to copy on Windows EPERM)',
      },
      // SMI-5982 code-review fix #1: long-running server, cwd is not the caller's project.
      cwd: {
        type: 'string',
        description:
          "Absolute path to the calling client's actual project/workspace root, used to " +
          'resolve project-scoped companion-agent output (e.g. Antigravity) correctly. Optional ' +
          'for flat, absolute-path clients (unused). REQUIRED for directory-package clients ' +
          "(Antigravity) — this MCP server's own process.cwd() is fixed at server launch and " +
          "does not track the calling editor/agent's real project, so the install fails closed " +
          'with a clear error if omitted rather than silently writing to the wrong directory.',
      },
    },
    required: ['skillId'],
  },
}

export default installTool
