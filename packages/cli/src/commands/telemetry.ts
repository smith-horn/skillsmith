/**
 * @fileoverview `skillsmith telemetry` command group — opt-in telemetry management.
 * @module @skillsmith/cli/commands/telemetry
 * @see SMI-5021 Wave 3 Step 2 — CLI subcommands for telemetry (plan lines 195–196, 576)
 * @see SMI-5128 batch D — action impls + run* logic moved to telemetry.action.ts
 *   (sibling-split convention) so the 6 subcommand handlers are withTelemetry-
 *   wrapped without this file exceeding the 500-LOC gate. This file retains the
 *   commander factory and re-exports the run* test helpers for back-compat.
 *
 * Subcommands:
 *   skillsmith telemetry enable
 *   skillsmith telemetry disable
 *   skillsmith telemetry status
 *   skillsmith telemetry install-hook   [--scope user|project] [--endpoint <url>]
 *   skillsmith telemetry uninstall-hook [--scope user|project]
 *   skillsmith telemetry reset-id
 *
 * Privacy invariants (plan line 719):
 *   - anonymousId is NEVER printed in full. Only the last 8 hex chars appear in stdout.
 *   - The full SHA-256 hex travels only to the events endpoint in hook payloads.
 *
 * Shared-state coordination (plan line 717):
 *   - install-hook reads then writes ~/.claude/settings.json via telemetry.helpers.ts
 *   - Refuses on foreign Skill matcher (security gate)
 *   - manifest read/write always via loadManifest / saveManifest (atomic rename)
 */

import { Command } from 'commander'

import {
  telemetryEnableAction,
  telemetryDisableAction,
  telemetryStatusAction,
  telemetryInstallHookAction,
  telemetryUninstallHookAction,
  telemetryResetIdAction,
} from './telemetry.action.js'

// ---------------------------------------------------------------------------
// Command factory
// ---------------------------------------------------------------------------

export function createTelemetryCommand(): Command {
  const telemetry = new Command('telemetry').description(
    'Manage Skillsmith telemetry preferences and Claude Code hook installation'
  )

  telemetry
    .command('enable')
    .description('Opt in to anonymous skill-invocation telemetry')
    .action(telemetryEnableAction)

  telemetry
    .command('disable')
    .description('Opt out of telemetry (anonymous ID is retained for re-enable continuity)')
    .action(telemetryDisableAction)

  telemetry
    .command('status')
    .description('Show current telemetry state; triggers annual ID rotation if due')
    .action(telemetryStatusAction)

  telemetry
    .command('install-hook')
    .description('Install the Skill telemetry hook into ~/.claude/settings.json')
    .option(
      '--scope <scope>',
      'Settings scope: user (~/.claude/settings.json) or project (./.claude/settings.json)',
      'user'
    )
    .option('--endpoint <url>', 'Override the telemetry endpoint (default: prod Supabase events)')
    .action(telemetryInstallHookAction)

  telemetry
    .command('uninstall-hook')
    .description('Remove the Skillsmith Skill hook entries from settings.json')
    .option('--scope <scope>', 'Settings scope: user or project', 'user')
    .action(telemetryUninstallHookAction)

  telemetry
    .command('reset-id')
    .description('Immediately rotate the anonymous ID (previous ID kept for 7-day overlap window)')
    .action(telemetryResetIdAction)

  return telemetry
}

// Internal exports for tests — sourced from telemetry.action.ts (SMI-5128 split).
export {
  runEnable,
  runDisable,
  runStatus,
  runInstallHook,
  runUninstallHook,
  runResetId,
  idTail,
} from './telemetry.action.js'
