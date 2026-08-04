/**
 * @fileoverview `skillsmith registry install` action implementation + telemetry wrapper.
 * @module @skillsmith/cli/commands/registry-install.action
 * @see SMI-5905 Wave 4 — CLI transport to the Enterprise-tier private team registry.
 * @see docs/internal/implementation/private-registry-skill-install.md
 *
 * Follows the SMI-5127/SMI-5128 sibling-split convention (CLAUDE.md CI Health
 * Requirements): the action impl + withTelemetry-wrapped export live here;
 * the commander factory stays in `registry-install.ts`.
 *
 * Talks to the Wave 2 Edge Function (`private-registry-get`) directly via
 * `getPrivateRegistrySkillContent()` (`@skillsmith/core`) — the CLI never
 * carries Supabase credentials, only a fetch under the signed-in user's own
 * JWT (`resolveFreshAccessToken()`, populated by `skillsmith login`). The
 * fetched content is installed to disk via Wave 1's
 * `SkillInstallationService.installFromContent()` — the same core install
 * primitive `install.ts` uses for the GitHub-fetch path, just entered from an
 * already-resolved `{skillId, version, content}` triple instead of a repo URL.
 *
 * Error-mapping contract (see supabase/functions/private-registry-get/access.ts):
 *   unauthenticated (401) → re-run `skillsmith login`
 *   forbidden (403)       → caller's team is not (or no longer) Enterprise-entitled
 *   not_found (404)       → no visible row; NEVER distinguishes "doesn't
 *                            exist" from "not your team" — matches the Edge
 *                            Function's own non-leaking 404 contract
 *   rate_limited (429)    → try again shortly
 *   invalid_request / server_error / network_error → the transport's own message
 *
 * No `requireTier('enterprise')` pre-flight gate here (unlike `diff`/`pin`/
 * `audit`): that helper checks the LOCAL personal license/API-key tier, but
 * private-registry entitlement is a TEAM subscription tier checked
 * server-side against the caller's JWT (Sol plan-review finding #1) — the two
 * are not the same thing, and gating on the wrong one would incorrectly block
 * an Enterprise-team member with no personal API key. The Edge Function's own
 * 403 is the single source of truth for entitlement.
 */

import chalk from 'chalk'
import ora from 'ora'
import {
  SkillRepository,
  SkillDependencyRepository,
  SkillInstallationService,
  getPrivateRegistrySkillContent,
  resolveFreshAccessToken,
  emitInstallEvent,
  type PrivateRegistryGetResult,
  type InstallFromContentOptions,
} from '@skillsmith/core'
import { getCliLogger } from '../cli-logger.js'
import { withTelemetry } from '@skillsmith/core/telemetry'
import { openCliDatabase } from '../utils/open-database.js'
import { getInstallPath, resolveClientId, type ClientId } from '@skillsmith/core/install'
import { DEFAULT_DB_PATH, DEFAULT_MANIFEST_PATH } from '../config.js'
import { sanitizeError } from '../utils/sanitize.js'
import { displayResult, formatJsonResult } from './install.js'

const logger = getCliLogger()

/**
 * Registry skillIds are always `author/name` — no GitHub-URL alternative
 * (unlike the public `install` command): private-registry content has no
 * repo URL at all, it only exists as a row in `private_registry_skills`.
 * Mirrors the Edge Function's own `SKILL_ID_PATTERN`/`MAX_SKILL_ID_LENGTH`
 * (supabase/functions/private-registry-get/access.ts) so a locally-rejected
 * ID and a server-rejected one agree.
 */
const SKILL_ID_PATTERN = /^[^/]+\/[^/]+$/
const MAX_SKILL_ID_LENGTH = 200

/**
 * Sol final-code-review finding #1: SKILL_ID_PATTERN alone accepts "." / ".." as either
 * segment (e.g. "team/.."), which installFromContent() would otherwise turn into an install
 * path outside the skills directory. Reject it here too, matching the same check added to
 * registry-tools.ts and skill-installation.content.ts.
 */
function hasSafeSkillIdSegments(skillId: string): boolean {
  return skillId.split('/').every((segment) => {
    const trimmed = segment.trim()
    return trimmed.length > 0 && trimmed !== '.' && trimmed !== '..'
  })
}

/** @internal Exported for tests. */
export function isValidPrivateRegistrySkillId(skillId: string): boolean {
  return (
    skillId.length > 0 &&
    skillId.length <= MAX_SKILL_ID_LENGTH &&
    SKILL_ID_PATTERN.test(skillId) &&
    hasSafeSkillIdSegments(skillId)
  )
}

/**
 * Map a failed `getPrivateRegistrySkillContent()` result to a CLI-facing
 * message. Never implies anything about whether a cross-team skill exists on
 * `not_found` — matches the Edge Function's own non-leaking 404 contract.
 *
 * @internal Exported for tests.
 */
export function describePrivateRegistryError(
  result: Extract<PrivateRegistryGetResult, { ok: false }>
): string {
  switch (result.code) {
    case 'unauthenticated':
      return 'Your session has expired or is invalid. Run `skillsmith login` and try again.'
    case 'forbidden':
      return "Enterprise subscription required for your team's private registry."
    case 'not_found':
      return 'Skill not found in your private registry.'
    case 'rate_limited':
      return 'Rate limit exceeded. Please try again in a moment.'
    case 'invalid_request':
      return result.message
    case 'server_error':
      return `Private registry request failed (status ${result.status}). ${result.message}`
    case 'network_error':
    default:
      return `Could not reach the private registry: ${result.message}`
  }
}

/** JSON-mode error envelope, matching install.ts's `{success, skillId, error}` shape. */
function emitJsonError(skillId: string, error: string, errorCode?: string): void {
  console.log(
    JSON.stringify(
      { success: false, skillId, error, ...(errorCode !== undefined && { errorCode }) },
      null,
      2
    )
  )
}

export interface RegistryInstallActionOptions {
  version?: string
  force?: boolean
  quiet?: boolean
  json?: boolean
  db?: string
  client?: string
}

// SMI-5128: extracted from inline .action() closure so withTelemetry can wrap
// it at the export boundary (SMI-5040 coverage gate) — mirrors install.ts.
async function registryInstallActionImpl(
  skillId: string,
  opts: RegistryInstallActionOptions
): Promise<void> {
  const quiet = opts.quiet ?? false
  const jsonOutput = opts.json ?? false

  try {
    if (!isValidPrivateRegistrySkillId(skillId)) {
      const errorMsg =
        'Invalid skill ID format. Expected "author/name".\n' +
        '  Example:\n' +
        '    skillsmith registry install my-team/internal-helper'
      if (jsonOutput) {
        emitJsonError(skillId, errorMsg)
      } else {
        logger.error(chalk.red(errorMsg))
      }
      process.exit(1)
      return
    }

    // SMI-5894: same --client / SKILLSMITH_CLIENT resolution as install.ts.
    const client: ClientId = resolveClientId(opts.client ?? process.env['SKILLSMITH_CLIENT'])
    const skillsDir = getInstallPath(client)

    // Must be signed in BEFORE any network call — the Edge Function 401s on
    // anything but a real user JWT, so there is no point calling it without one.
    const jwtToken = await resolveFreshAccessToken()
    if (!jwtToken) {
      const message = 'Not logged in. Run `skillsmith login` and try again.'
      if (jsonOutput) {
        emitJsonError(skillId, message)
      } else {
        logger.error(chalk.red(message))
      }
      process.exit(1)
      return
    }

    const dbPath = opts.db ?? DEFAULT_DB_PATH
    const db = await openCliDatabase(dbPath)
    const spinner = jsonOutput ? null : ora('Fetching skill from private registry...').start()

    try {
      const fetchResult = await getPrivateRegistrySkillContent({
        jwtToken,
        skillId,
        ...(opts.version !== undefined && { version: opts.version }),
      })

      if (!fetchResult.ok) {
        const message = describePrivateRegistryError(fetchResult)
        if (spinner) spinner.fail('Fetch failed')
        if (jsonOutput) {
          emitJsonError(skillId, message, fetchResult.code)
        } else {
          logger.error(chalk.red(`\n${message}`))
        }
        process.exit(1)
        return
      }

      if (spinner) spinner.text = 'Installing skill...'

      const skillRepo = new SkillRepository(db)
      const skillDependencyRepo = new SkillDependencyRepository(db)

      const service = new SkillInstallationService({
        db,
        skillRepo,
        skillDependencyRepo,
        skillsDir,
        manifestPath: DEFAULT_MANIFEST_PATH,
        client,
        onProgress: (_stage: string, detail: string) => {
          if (spinner) {
            spinner.text = detail
          }
        },
      })

      // Content is never echoed back to the terminal from here on — only
      // the install RESULT (name/version/path), same as install.ts.
      const installOptions: InstallFromContentOptions = {
        skillId,
        version: fetchResult.data.version,
        content: fetchResult.data.content,
      }
      if (opts.force !== undefined) {
        installOptions.force = opts.force
      }

      const installStart = Date.now()
      const result = await service.installFromContent(installOptions)

      // SMI-4182 / SMI-4795: same install-telemetry event shape as install.ts.
      void emitInstallEvent({
        skillId,
        source: 'cli',
        success: result.success,
        durationMs: Date.now() - installStart,
        ...(result.trustTier !== undefined && { trustTier: result.trustTier }),
        ...(!result.success && result.errorCode !== undefined && { errorCode: result.errorCode }),
      })

      if (spinner) {
        if (result.success) {
          spinner.succeed('Skill installed')
        } else {
          spinner.fail('Installation failed')
        }
      }

      if (jsonOutput) {
        console.log(formatJsonResult(result))
      } else {
        displayResult(result, quiet)
      }

      if (!result.success) {
        process.exit(1)
      }
    } finally {
      db.close()
    }
  } catch (error) {
    if (jsonOutput) {
      emitJsonError(skillId, sanitizeError(error))
    } else {
      logger.error(`${chalk.red('Registry install error:')} ${sanitizeError(error)}`)
    }
    process.exit(1)
  }
}

export const registryInstallAction = withTelemetry(registryInstallActionImpl, {
  source: 'cli',
  extractSkillId: () => 'registry install',
  extractFramework: () => 'cli',
})
