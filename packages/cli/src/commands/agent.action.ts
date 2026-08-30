/**
 * @fileoverview `skillsmith agent` action implementations + telemetry wrappers.
 * @module @skillsmith/cli/commands/agent.action
 * @see SMI-5456 Wave 1 Step 5 — `sklx agent install` / `sklx agent uninstall`.
 *   Follows the SMI-5128 sibling-split convention: run* business logic +
 *   withTelemetry-wrapped exports live here; the commander factory stays in
 *   agent.ts.
 *
 * `installAgentPack` / `uninstallAgentPack` (both `@skillsmith/core/install`)
 * do all the filesystem work and detection; this module is presentation
 * (the per-harness report) + the CLI's standard error-mapping/exit-code
 * envelope, matching `inventory.action.ts`'s shape.
 */

import chalk from 'chalk'

import { installAgentPack, parseInstallScope, uninstallAgentPack } from '@skillsmith/core/install'
import type { MergeStatus } from '@skillsmith/core/install'
import { getCliLogger } from '../cli-logger.js'
import { withTelemetry } from '@skillsmith/core/telemetry'
import { sanitizeError } from '../utils/sanitize.js'

const logger = getCliLogger()

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

export interface AgentInstallCliOptions {
  force?: boolean
  /**
   * ADR-139 (SMI-6274 Wave 4): `'workspace'` bootstraps AntiGravity as a
   * target by creating (if needed) its workspace-scoped `.agents/skills`
   * directory — the only thing allowed to create it (point 5's Wave 5
   * bootstrap requirement). Omitted/`'global'` preserves today's behavior
   * exactly (AntiGravity untouched by `agent install`).
   */
  scope?: 'global' | 'workspace'
}

function mergeStatusColor(status: MergeStatus): (text: string) => string {
  if (status === 'conflict') return chalk.yellow
  if (status === 'error') return chalk.red
  return chalk.green
}

/**
 * Install the Skillsmith Agent pack across every detected harness and print
 * a per-harness report (support tier, what was written, MCP merge status).
 *
 * @see SMI-5456
 */
export async function runInstall(opts: AgentInstallCliOptions = {}): Promise<void> {
  // Commander passes an unvalidated raw string — parseInstallScope() throws
  // InvalidScopeValueError for anything other than global/workspace/empty,
  // caught by this function's caller (agentInstallActionImpl).
  const scope = parseInstallScope(opts.scope)
  const result = installAgentPack({
    force: opts.force ?? false,
    ...(scope !== undefined && { scope }),
  })

  console.log(chalk.bold('Skillsmith Agent — install report'))
  console.log()
  for (const report of result.harnessReports) {
    const badge = report.detected ? chalk.green('detected') : chalk.dim('not detected')
    console.log(
      `${chalk.bold(report.harness.padEnd(14))} ${chalk.dim(`Tier ${report.tier}`)}  ${badge}`
    )
    if (report.skillPackWritten) console.log(`  skill pack:   ${chalk.green('written')}`)
    if (report.shimWritten) console.log(`  named shim:   ${chalk.green('written')}`)
    if (report.hooksInstalled) console.log(`  hooks:        ${chalk.green('installed')}`)
    if (report.mcpConfig) {
      const color = mergeStatusColor(report.mcpConfig.status)
      console.log(`  MCP config:   ${color(report.mcpConfig.status)}`)
    }
    for (const note of report.notes) {
      console.log(`  ${chalk.dim('note:')} ${note}`)
    }
    console.log()
  }
  console.log(chalk.dim(`Manifest: ${result.manifestPath}`))
  console.log(
    chalk.dim(
      'A registered harness with a conflicting MCP entry was left untouched — re-run with --force to overwrite it.'
    )
  )
}

/** @internal Exported for unit tests. */
export async function agentInstallActionImpl(options: AgentInstallCliOptions): Promise<void> {
  try {
    await runInstall(options)
  } catch (err) {
    logger.error(`${chalk.red('Error:')} ${sanitizeError(err)}`)
    process.exit(1)
  }
}

export const agentInstallAction = withTelemetry(agentInstallActionImpl, {
  source: 'cli',
  extractSkillId: () => 'agent install',
  extractFramework: () => 'cli',
})

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

/**
 * Reverse exactly what a prior `sklx agent install` wrote: manifest-driven,
 * restoring modified config files from backup and deleting anything the
 * installer created outright.
 *
 * @see SMI-5456
 */
export async function runUninstall(): Promise<void> {
  const result = uninstallAgentPack()

  console.log(chalk.bold('Skillsmith Agent — uninstall report'))
  console.log(`  removed:       ${result.removed.length}`)
  console.log(`  restored:      ${result.restored.length}`)
  if (result.alreadyGone.length > 0) {
    console.log(
      chalk.dim(`  already gone:  ${result.alreadyGone.length} (deleted outside sklx — no-op)`)
    )
  }
  if (result.rejected.length > 0) {
    console.log(
      chalk.yellow(
        `  rejected:      ${result.rejected.length} (manifest entries pointing outside known install targets — left untouched, manifest may be corrupted)`
      )
    )
  }
  if (
    result.removed.length === 0 &&
    result.restored.length === 0 &&
    result.alreadyGone.length === 0 &&
    result.rejected.length === 0
  ) {
    console.log(chalk.dim('  Nothing to uninstall — the agent pack was not installed.'))
  }
}

/** @internal Exported for unit tests. */
export async function agentUninstallActionImpl(): Promise<void> {
  try {
    await runUninstall()
  } catch (err) {
    logger.error(`${chalk.red('Error:')} ${sanitizeError(err)}`)
    process.exit(1)
  }
}

export const agentUninstallAction = withTelemetry(agentUninstallActionImpl, {
  source: 'cli',
  extractSkillId: () => 'agent uninstall',
  extractFramework: () => 'cli',
})
