/**
 * @fileoverview MCP Uninstall Skill Tool for safely removing installed skills
 * @module @skillsmith/mcp-server/tools/uninstall
 * @see SMI-3483: Wave 0 — Delegate to SkillInstallationService from core
 *
 * Provides skill uninstallation functionality with:
 * - Manifest-based tracking of installed skills
 * - Modification detection (warns if files changed since install)
 * - Force removal option for modified or untracked skills
 * - Clean removal from ~/.claude/skills/ directory
 * - Orphan fallback: if skill not in manifest but exists on disk
 *
 * The core uninstall logic lives in @skillsmith/core SkillInstallationService.
 * This file is the MCP tool wrapper that bridges ToolContext to the service.
 */

import { z } from 'zod'
import { SkillInstallationService } from '@skillsmith/core'
import {
  CANONICAL_CLIENT,
  CLIENT_IDS,
  InvalidScopeValueError,
  parseInstallScope,
  removeLinks,
  resolveClientId,
  resolveScopedSkillsDir,
  UnsatisfiableWorkspaceScopeError,
  type ClientId,
} from '@skillsmith/core/install'
import type { ToolContext } from '../context.js'
import { getToolContext } from '../context.js'
import { withTelemetry } from '@skillsmith/core/telemetry'
import { MANIFEST_PATH } from './install.types.js'

/**
 * SMI-5982-style enum derivation (mirrors install.types.ts's
 * `CLIENT_ID_ENUM_VALUES`): a hand-duplicated literal enum silently drifts
 * from `CLIENT_IDS` as new clients are added (SMI-5982 audit finding) — this
 * derives from the same source of truth `assertClientId`/`resolveClientId`
 * validate against.
 */
const CLIENT_ID_ENUM_VALUES = CLIENT_IDS as unknown as [ClientId, ...ClientId[]]

// Input schema
export const uninstallInputSchema = z.object({
  skillName: z.string().min(1).describe('Name of the skill to uninstall'),
  force: z.boolean().default(false).describe('Force removal even if modified'),
  /** ADR-139 (SMI-6274 Wave 4) / GPT-5.6-Sol PR review: target client, mirroring
   *  install_skill's own `client` param (defaults to SKILLSMITH_CLIENT env or
   *  claude-code). Required for the (scope, client) triple scope resolution
   *  targets — resolving the wrong client's directory would uninstall from
   *  the wrong place entirely. */
  client: z
    .enum(CLIENT_ID_ENUM_VALUES)
    .optional()
    .describe('Target agent (defaults to SKILLSMITH_CLIENT env or claude-code)'),
  /** ADR-139 (SMI-6274 Wave 4) / GPT-5.6-Sol PR review: explicit uninstall
   *  scope, mirroring the CLI's `--scope` flag and install_skill's own
   *  `scope` param — see that param's doc comment (install.types.ts) for why
   *  a per-call parameter matters for a long-running MCP server beyond the
   *  SKILLSMITH_SCOPE env var alone. */
  scope: z
    .enum(['global', 'workspace'])
    .optional()
    .describe(
      'Uninstall scope (ADR-139): "workspace" targets the nearest ancestor workspace ' +
        "marker/.git root's skills directory (walked from `cwd` when provided); defaults to " +
        'SKILLSMITH_SCOPE env, then the per-client config default, then auto-detecting an ' +
        'EXISTING workspace directory, then global.'
    ),
  /** ADR-139 (SMI-6274 Wave 4): this MCP server is long-running, so its own
   *  process.cwd() is fixed at server launch and does not track the calling
   *  editor/agent's actual project — passing this is the only reliable way
   *  to walk the workspace-scope ancestor search from the RIGHT starting
   *  point. Optional: falls back to this server's own process.cwd(), which
   *  still resolves correctly for a bare global uninstall (the common case)
   *  but may under-resolve workspace auto-detection/creation without it. */
  cwd: z
    .string()
    .min(1, 'cwd must not be empty')
    .optional()
    .describe(
      "Absolute path to the calling client's actual project/workspace root, used as the " +
        'ancestor-walk starting point for workspace scope resolution. Optional — omitting it ' +
        "falls back to this server's own process.cwd(), which may not track the calling " +
        "editor/agent's real project."
    ),
})

export type UninstallInput = z.infer<typeof uninstallInputSchema>

// Output type — re-exported from core for backward compatibility
import type { CoreUninstallResult } from '@skillsmith/core'
export type UninstallResult = CoreUninstallResult

/**
 * ADR-139 (SMI-6274 Wave 4) / GPT-5.6-Sol PR review: structured error
 * envelope for an unsatisfiable/invalid `scope` request, matching
 * `CoreUninstallResult`'s shape (`{success, skillName, message}` — no
 * `error` field) — mirrors install_skill's `buildScopeError` precedent.
 */
function buildScopeError(skillName: string, error: Error): UninstallResult {
  return {
    success: false,
    skillName,
    message: error.message,
  }
}

/**
 * Uninstall a skill from the local agent skills directory (~/.claude/skills/).
 *
 * Delegates to SkillInstallationService from @skillsmith/core.
 *
 * ADR-139 (SMI-6274 Wave 4) / GPT-5.6-Sol PR review: this tool previously
 * constructed `SkillInstallationService` with NO `skillsDir`/`manifestPath`/
 * `client` at all, so it could only ever target the global directory for
 * the canonical client — the same "MCP server can't reach workspace scope"
 * gap `install_skill` had, plus a narrower pre-existing client gap on top.
 * Now routes through the SAME shared `resolveScopedSkillsDir()` resolver
 * the CLI's `remove` command uses (`manage.action.ts`'s `resolveEffectiveScope`).
 *
 * @param input - Uninstall parameters
 * @param _context - Optional tool context (falls back to singleton)
 * @returns Promise resolving to uninstall result with success status
 */
async function uninstallSkillImpl(
  input: UninstallInput,
  _context?: ToolContext
): Promise<UninstallResult> {
  const context = _context ?? getToolContext()

  const effectiveClient = resolveClientId(input.client)

  let scopeTarget: ReturnType<typeof resolveScopedSkillsDir>
  try {
    scopeTarget = resolveScopedSkillsDir({
      client: effectiveClient,
      explicitScope: parseInstallScope(input.scope),
      ...(input.cwd !== undefined && { cwd: input.cwd }),
      globalManifestPath: MANIFEST_PATH,
    })
  } catch (scopeError) {
    if (
      scopeError instanceof UnsatisfiableWorkspaceScopeError ||
      scopeError instanceof InvalidScopeValueError
    ) {
      return buildScopeError(input.skillName, scopeError)
    }
    throw scopeError
  }

  const service = new SkillInstallationService({
    db: context.db,
    skillRepo: context.skillRepository,
    skillDependencyRepo: context.skillDependencyRepository,
    skillsDir: scopeTarget.dir,
    manifestPath: scopeTarget.manifestPath,
    client: effectiveClient,
  })

  const result = await service.uninstall(input.skillName, { force: input.force })

  // SMI-4578: tear down any --also-link fan-out destinations recorded
  // for this skill. Best-effort — uninstall must succeed even if the
  // manifest is missing or a destination was already cleaned up. Match
  // the CLI's parity behavior in `manage.action.ts` (`createRemoveCommand`'s
  // action impl).
  //
  // ADR-139 (SMI-6274 Wave 4) / GPT-5.6-Sol PR review round 3: fan-out links
  // are always recorded FROM the GLOBAL canonical install — `removeLinks
  // (skillId)` reads the GLOBAL `~/.skillsmith/links/manifest.json` and
  // matches purely by bare skill name, with no scope or per-destination
  // client scoping at all. `effectiveClient === CANONICAL_CLIENT` alone is
  // NOT sufficient: it still fires for a canonical client's WORKSPACE-scoped
  // uninstall, which would delete the unrelated GLOBAL canonical install's
  // `--also-link` fan-out destinations, even though only the workspace copy
  // was meant to go. Requiring scope === 'global' too closes that — a
  // fan-out is always global-canonical-to-global-client, so BOTH client
  // identity AND scope are correctness-relevant here, not client alone.
  if (result.success && effectiveClient === CANONICAL_CLIENT && scopeTarget.scope === 'global') {
    try {
      await removeLinks(input.skillName)
    } catch {
      // Manifest read/write failure should never fail the uninstall.
    }
  }

  return result
}

/**
 * List all skills currently installed via Skillsmith.
 *
 * Reads the manifest file and returns an array of skill names.
 * This only includes skills tracked in the manifest, not skills
 * manually placed in ~/.claude/skills/.
 *
 * @returns Promise resolving to array of installed skill names
 */
export async function listInstalledSkills(): Promise<string[]> {
  // This lightweight operation reads the manifest directly
  // rather than constructing a full service instance.
  const fs = await import('fs/promises')
  const path = await import('path')
  const os = await import('os')

  const manifestPath = path.join(os.homedir(), '.skillsmith', 'manifest.json')
  try {
    const content = await fs.readFile(manifestPath, 'utf-8')
    const manifest = JSON.parse(content)
    return Object.keys(manifest.installedSkills || {})
  } catch {
    return []
  }
}

/**
 * MCP tool definition
 */
export const uninstallTool = {
  name: 'uninstall_skill',
  description:
    "[Skillsmith — Retire stage] Uninstall an agent skill from the local Claude Code skills directory (~/.claude/skills/) or runtime-equivalent path. Use when the user asks to uninstall/remove/delete a specific skill — e.g. 'uninstall playwright-cli', 'remove getsentry/commit', 'use Skillsmith to delete the testing skill'. Optional `force` flag overrides protection on locally-modified skills. Skillsmith is a registry for sharing, scanning, and tracking agent skills across any MCP-capable runtime.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      skillName: {
        type: 'string',
        description: 'Name of the skill to uninstall',
      },
      force: {
        type: 'boolean',
        description: 'Force removal even if skill has been modified',
      },
      // ADR-139 (SMI-6274 Wave 4): mirrors install_skill's client param.
      client: {
        type: 'string',
        enum: [...CLIENT_IDS],
        description: 'Target agent (default: SKILLSMITH_CLIENT env or claude-code)',
      },
      // ADR-139 (SMI-6274 Wave 4): mirrors install_skill's scope param.
      scope: {
        type: 'string',
        enum: ['global', 'workspace'],
        description:
          'Uninstall scope (ADR-139): "workspace" targets the nearest ancestor workspace ' +
          "marker/.git root's skills directory (walked from cwd when provided); defaults to " +
          'SKILLSMITH_SCOPE env, then the per-client config default, then auto-detecting an ' +
          'EXISTING workspace directory, then global.',
      },
      cwd: {
        type: 'string',
        description:
          "Absolute path to the calling client's actual project/workspace root, used as the " +
          'ancestor-walk starting point for workspace scope resolution. Optional.',
      },
    },
    required: ['skillName'],
  },
}

export default uninstallTool

// SMI-5017 W2.S2: wrap at export boundary
export const uninstallSkill = withTelemetry(uninstallSkillImpl, {
  source: 'mcp-tool',
  extractSkillId: () => 'uninstall_skill',
  extractFramework: () => 'unknown',
})
