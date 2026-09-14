/**
 * @fileoverview skillsmith pin / unpin — content-hash pinning for installed skills
 * @module @skillsmith/cli/commands/pin
 * @see SMI-skill-version-tracking Wave 2
 * @see SMI-6358: keys through manifestKeyFor(name, client), locked write
 *
 * pin <name>:   writes the current contentHash as pinnedVersion in the manifest
 * unpin <name>: removes pinnedVersion from the manifest entry
 *
 * The pinnedVersion field is an 8-char truncated content hash that the
 * skill_updates tool (Wave 1) and install flow (future Wave 3) can use
 * to enforce an update hold.
 *
 * Tier gate: Individual (requires requireTier('individual')).
 *
 * Client scoping (SMI-6358): a skill installed under a non-canonical client
 * (e.g. `cursor`) is keyed in the manifest as `name::client`
 * (manifestKeyFor()), NOT bare `name` — bare `name` is reserved for the
 * canonical `claude-code` client. Before this fix, pin/unpin always read and
 * wrote the bare-name key regardless of --client, so pinning a non-canonical
 * client's skill could read/mutate an unrelated canonical entry of the same
 * name (or silently no-op against a key that was never written). --client
 * resolution mirrors update/remove/install (resolveEffectiveClient in
 * manage.action.ts): an explicit --client wins, else SKILLSMITH_CLIENT, else
 * canonical — for the canonical client, manifestKeyFor(name, 'claude-code')
 * === name, so this is byte-identical to the old behavior for every
 * existing (single-client) install.
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { getCliLogger } from '../cli-logger.js'
import { withTelemetry } from '@skillsmith/core/telemetry'
import { manifestKeyFor } from '@skillsmith/core'
import { resolveClientId, type ClientId } from '@skillsmith/core/install'
import { requireTier } from '../utils/require-tier.js'
import { sanitizeError } from '../utils/sanitize.js'
import { loadManifest, updateManifestEntry } from '../utils/manifest.js'
import { VALID_CLIENT_HINT } from './install.js'

const logger = getCliLogger()

// ============================================================================
// Helpers
// ============================================================================

/**
 * Truncate a full content hash to its 8-char human-readable prefix.
 * If the hash is already short (e.g. the manifest stores an 8-char value),
 * the full value is returned as-is.
 */
function truncateHash(hash: string): string {
  return hash.slice(0, 8)
}

/**
 * SMI-6358: resolve the effective client the same way update/install/remove
 * do (manage.action.ts's resolveEffectiveClient) — an explicit --client
 * wins, else SKILLSMITH_CLIENT, else the canonical client. pin/unpin have no
 * scope/skillsDir concept of their own (they only ever touch the manifest,
 * never the filesystem), so this is the full extent of parity needed.
 */
function resolveEffectiveClient(explicit: string | undefined): ClientId {
  return resolveClientId(explicit ?? process.env['SKILLSMITH_CLIENT'])
}

// ============================================================================
// Command factories
// ============================================================================

// SMI-5128 batch B: extracted from inline .action() closures so withTelemetry
// can wrap them at the export boundary (SMI-5018 coverage gate).

async function pinActionImpl(
  skillName: string,
  opts: Record<string, string | boolean | undefined> = {}
): Promise<void> {
  try {
    await requireTier('individual')

    const client = resolveEffectiveClient(opts['client'] as string | undefined)
    const manifestKey = manifestKeyFor(skillName, client)

    const manifest = await loadManifest()
    const entry = manifest.installedSkills[manifestKey]

    if (!entry) {
      logger.error(
        chalk.red(
          `Skill "${skillName}" not found in manifest. ` +
            `Install the skill first with: skillsmith setup`
        )
      )
      process.exit(1)
    }

    const hash = entry.contentHash ?? entry.originalContentHash ?? null

    if (!hash) {
      logger.warn(
        chalk.yellow(
          `Warning: No content hash available for "${skillName}". ` +
            `Reinstall the skill to record a hash.`
        )
      )
      process.exit(1)
    }

    const pinHash = truncateHash(hash)

    await updateManifestEntry((m) => {
      const existingEntry = m.installedSkills[manifestKey]
      if (!existingEntry) return m
      return {
        ...m,
        installedSkills: {
          ...m.installedSkills,
          [manifestKey]: {
            ...existingEntry,
            pinnedVersion: pinHash,
          },
        },
      }
    })

    console.log(chalk.green(`Pinned ${skillName} to content hash ${pinHash}`))
  } catch (error) {
    logger.error(`${chalk.red('Error:')} ${sanitizeError(error)}`)
    process.exit(1)
  }
}

export const pinAction = withTelemetry(pinActionImpl, {
  source: 'cli',
  extractSkillId: () => 'pin',
  extractFramework: () => 'cli',
})

async function unpinActionImpl(
  skillName: string,
  opts: Record<string, string | boolean | undefined> = {}
): Promise<void> {
  try {
    await requireTier('individual')

    const client = resolveEffectiveClient(opts['client'] as string | undefined)
    const manifestKey = manifestKeyFor(skillName, client)

    const manifest = await loadManifest()
    const entry = manifest.installedSkills[manifestKey]

    if (!entry) {
      logger.error(chalk.red(`Skill "${skillName}" not found in manifest.`))
      process.exit(1)
    }

    if (!entry.pinnedVersion) {
      console.log(chalk.dim(`Skill "${skillName}" is not pinned.`))
      return
    }

    const previousPin = entry.pinnedVersion

    await updateManifestEntry((m) => {
      const existingEntry = m.installedSkills[manifestKey]
      if (!existingEntry) return m

      const { pinnedVersion: _removed, ...rest } = existingEntry
      return {
        ...m,
        installedSkills: {
          ...m.installedSkills,
          [manifestKey]: rest,
        },
      }
    })

    console.log(chalk.green(`Unpinned ${skillName} (was pinned to ${previousPin})`))
  } catch (error) {
    logger.error(`${chalk.red('Error:')} ${sanitizeError(error)}`)
    process.exit(1)
  }
}

export const unpinAction = withTelemetry(unpinActionImpl, {
  source: 'cli',
  extractSkillId: () => 'unpin',
  extractFramework: () => 'cli',
})

/**
 * Create the pin command
 */
export function createPinCommand(): Command {
  return new Command('pin')
    .description('Pin an installed skill to its current content hash (Individual tier)')
    .argument('<skill>', 'Skill name to pin')
    .option(
      '--client <id>',
      `pin the copy installed for a specific agent (defaults to SKILLSMITH_CLIENT env or claude-code; ${VALID_CLIENT_HINT})`
    )
    .action(pinAction)
}

/**
 * Create the unpin command
 */
export function createUnpinCommand(): Command {
  return new Command('unpin')
    .description('Remove the content-hash pin from an installed skill (Individual tier)')
    .argument('<skill>', 'Skill name to unpin')
    .option(
      '--client <id>',
      `unpin the copy installed for a specific agent (defaults to SKILLSMITH_CLIENT env or claude-code; ${VALID_CLIENT_HINT})`
    )
    .action(unpinAction)
}
