/**
 * @fileoverview `private_registry_manage(action:'install')` handler
 * @module @skillsmith/mcp-server/tools/registry-tools.install-action
 * @see SMI-5905 Wave 3: MCP tool surface — `install` action + `getContent()`
 * @see docs/internal/implementation/private-registry-skill-install.md
 *
 * Lives outside `registry-tools.ts` because that file was 466/500 lines before this wave — the
 * same `foo.action.ts` split CLAUDE.md prescribes for a command whose handlers push it over.
 *
 * Two invariants this handler exists to hold:
 *
 * 1. **The raw `content` map never reaches the MCP tool result.** That result is rendered straight
 *    into the calling model's context and `content` can be 2 MB (ADR-129 Risks). The success path
 *    therefore builds a `PrivateRegistryInstallSummary` — an explicit allowlist — rather than
 *    forwarding core's `InstallResult`, which carries `securityReport` (content-derived match
 *    snippets) and would silently grow whatever fields a future core change adds.
 *
 * 2. **Entitlement is not this file's job, and must not be re-implemented here.** It is enforced
 *    inside `getContent()` (registry-tools.live.content.ts), against the team that owns the row.
 *    A second copy of the check here could drift from the Edge Function's; a `catch` that
 *    swallowed its error would silently un-gate the feature. Errors from `getContent()` propagate
 *    to the caller's message unchanged.
 */

import { SkillInstallationService } from '@skillsmith/core'
import { getInstallPath, resolveClientId } from '@skillsmith/core/install'
import type { ToolContext } from '../context.js'
import { getToolContext } from '../context.js'
import type { PrivateRegistryInstallSummary } from './registry-tools.content.types.js'
import type {
  PrivateRegistryManageInput,
  PrivateRegistryManageResult,
  PrivateRegistryService,
} from './registry-tools.js'

/** Derive the on-disk skill directory name from an `author/name` skillId. */
function skillNameFromSkillId(skillId: string): string {
  const parts = skillId.split('/')
  return parts.length >= 2 ? parts[parts.length - 1] : skillId
}

/**
 * Build the installer.
 *
 * Injectable (see {@link RegistryInstallParams.createInstaller}) because `getInstallPath()`
 * resolves from the real home directory at module load — without a seam, any end-to-end test of
 * this handler would write into the developer's own `~/.claude/skills`. `install_skill` has no
 * such seam and is correspondingly untestable end to end.
 *
 * `client` deliberately comes from `SKILLSMITH_CLIENT`/the canonical default only — there is no
 * per-call `client` input on `private_registry_manage`. Explicit `--client` targeting is Wave 4's
 * CLI surface (plan §4); adding a second, differently-shaped targeting mechanism here first would
 * be the harder thing to remove later.
 */
function defaultInstaller(context: ToolContext): SkillInstallationService {
  const client = resolveClientId(undefined)
  return new SkillInstallationService({
    db: context.db,
    skillRepo: context.skillRepository,
    skillDependencyRepo: context.skillDependencyRepository,
    skillsDir: getInstallPath(client),
    client,
  })
}

export interface RegistryInstallParams {
  input: PrivateRegistryManageInput
  /** License-derived team id, resolved by the outer handler. Never taken from tool input. */
  teamId: string
  dataSource: 'stub' | 'live'
  service: PrivateRegistryService
  /** The outer handler's ToolContext; falls back to the process-wide one when absent. */
  context?: ToolContext
  /** Test seam — see {@link defaultInstaller}. Production callers omit it. */
  createInstaller?: (context: ToolContext) => SkillInstallationService
}

/**
 * Fetch a private-registry skill's content and install it to disk.
 *
 * Errors are returned as `{success:false, error}` rather than thrown, matching every other action
 * in `executePrivateRegistryManageImpl` — including the entitlement denial from `getContent()`,
 * whose message is already written for the end user.
 */
export async function executeRegistryInstall(
  params: RegistryInstallParams
): Promise<PrivateRegistryManageResult> {
  const { input, teamId, dataSource, service } = params

  if (!input.skillId) {
    return { success: false, dataSource, error: 'skillId is required for action "install".' }
  }

  const fetched = await service.getContent(teamId, input.skillId, input.version)
  if (!fetched) {
    // Byte-identical to the `get` action's not-found message. A cross-team skillId lands here too
    // (RLS + the tenant filter simply return no rows), so this must not distinguish "does not
    // exist" from "not your team" — it would otherwise be an existence oracle for another team.
    return {
      success: false,
      dataSource,
      error: `Skill "${input.skillId}" not found in private registry.`,
    }
  }

  const context = params.context ?? getToolContext()
  const installer = (params.createInstaller ?? defaultInstaller)(context)
  const result = await installer.installFromContent({
    skillId: fetched.skillId,
    // The version `getContent()` actually resolved — never the caller's (possibly absent) input,
    // so the manifest records what was installed rather than what was asked for.
    version: fetched.version,
    content: fetched.content,
    force: input.force ?? false,
  })

  if (!result.success) {
    return {
      success: false,
      dataSource,
      // `result.error` is already user-facing (e.g. a rejected traversal content key, a failed
      // scan). `errorCode` is the stable machine-readable taxonomy value (SMI-4795).
      error: `${result.error ?? 'Install failed.'} (${result.errorCode ?? 'UNKNOWN'})`,
    }
  }

  const install: PrivateRegistryInstallSummary = {
    skillId: fetched.skillId,
    skillName: skillNameFromSkillId(fetched.skillId),
    version: fetched.version,
    installPath: result.installPath,
    fileCount: Object.keys(fetched.content).length,
    trustTier: result.trustTier,
    tips: result.tips,
  }

  return {
    success: true,
    dataSource,
    install,
    message:
      `Installed ${fetched.skillId}@${fetched.version} from the private registry to ` +
      `${result.installPath}.`,
  }
}
