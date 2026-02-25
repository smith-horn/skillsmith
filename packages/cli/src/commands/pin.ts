/**
 * @fileoverview skillsmith pin / unpin — content-hash pinning for installed skills
 * @module @skillsmith/cli/commands/pin
 * @see SMI-skill-version-tracking Wave 2
 *
 * pin <name>:   writes the current contentHash as pinnedVersion in the manifest
 * unpin <name>: removes pinnedVersion from the manifest entry
 *
 * The pinnedVersion field is an 8-char truncated content hash that the
 * skill_updates tool (Wave 1) and install flow (future Wave 3) can use
 * to enforce an update hold.
 *
 * Tier gate: Individual (requires requireTier('individual')).
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { requireTier } from '../utils/require-tier.js'
import { sanitizeError } from '../utils/sanitize.js'
import { loadManifest, updateManifestEntry } from '../utils/manifest.js'

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

// ============================================================================
// Command factories
// ============================================================================

/**
 * Create the pin command
 */
export function createPinCommand(): Command {
  return new Command('pin')
    .description('Pin an installed skill to its current content hash (Individual tier)')
    .argument('<skill>', 'Skill name to pin')
    .action(async (skillName: string): Promise<void> => {
      try {
        await requireTier('individual')

        const manifest = await loadManifest()
        const entry = manifest.installedSkills[skillName]

        if (!entry) {
          console.error(
            chalk.red(
              `Skill "${skillName}" not found in manifest. ` +
                `Install the skill first with: skillsmith install-skill`
            )
          )
          process.exit(1)
        }

        const hash = entry.contentHash ?? entry.originalContentHash ?? null

        if (!hash) {
          console.warn(
            chalk.yellow(
              `Warning: No content hash available for "${skillName}". ` +
                `Reinstall the skill to record a hash.`
            )
          )
          process.exit(1)
        }

        const pinHash = truncateHash(hash)

        await updateManifestEntry((m) => {
          const existingEntry = m.installedSkills[skillName]
          if (!existingEntry) return m
          return {
            ...m,
            installedSkills: {
              ...m.installedSkills,
              [skillName]: {
                ...existingEntry,
                pinnedVersion: pinHash,
              },
            },
          }
        })

        console.log(chalk.green(`Pinned ${skillName} to content hash ${pinHash}`))
      } catch (error) {
        console.error(chalk.red('Error:'), sanitizeError(error))
        process.exit(1)
      }
    })
}

/**
 * Create the unpin command
 */
export function createUnpinCommand(): Command {
  return new Command('unpin')
    .description('Remove the content-hash pin from an installed skill (Individual tier)')
    .argument('<skill>', 'Skill name to unpin')
    .action(async (skillName: string): Promise<void> => {
      try {
        await requireTier('individual')

        const manifest = await loadManifest()
        const entry = manifest.installedSkills[skillName]

        if (!entry) {
          console.error(chalk.red(`Skill "${skillName}" not found in manifest.`))
          process.exit(1)
        }

        if (!entry.pinnedVersion) {
          console.log(chalk.dim(`Skill "${skillName}" is not pinned.`))
          return
        }

        const previousPin = entry.pinnedVersion

        await updateManifestEntry((m) => {
          const existingEntry = m.installedSkills[skillName]
          if (!existingEntry) return m

          const { pinnedVersion: _removed, ...rest } = existingEntry
          return {
            ...m,
            installedSkills: {
              ...m.installedSkills,
              [skillName]: rest,
            },
          }
        })

        console.log(chalk.green(`Unpinned ${skillName} (was pinned to ${previousPin})`))
      } catch (error) {
        console.error(chalk.red('Error:'), sanitizeError(error))
        process.exit(1)
      }
    })
}
