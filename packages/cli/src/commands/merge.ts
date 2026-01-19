/**
 * SMI-1455: CLI command for safe skill database merging
 *
 * Provides a user-friendly interface to merge skill databases using
 * the merge tooling from @skillsmith/core (SMI-1448).
 *
 * Usage:
 *   skillsmith merge <source-db> [target-db]
 *   sklx merge <source-db> --strategy keep_newer --dry-run
 */

import { Command } from 'commander'
import { resolve } from 'path'
import { existsSync } from 'fs'
import Database from 'better-sqlite3'
import {
  mergeSkillDatabases,
  checkSchemaCompatibility,
  type MergeStrategy,
  type MergeOptions,
  type MergeConflict,
} from '@skillsmith/core'
import { getDefaultDbPath } from '../config.js'

/**
 * Format merge result for display
 */
function formatMergeResult(result: {
  skillsAdded: number
  skillsUpdated: number
  skillsSkipped: number
  conflicts: MergeConflict[]
  duration: number
}): string {
  const lines: string[] = [
    '',
    '╔══════════════════════════════════════════════════════════════╗',
    '║                    Merge Results                             ║',
    '╠══════════════════════════════════════════════════════════════╣',
    `║  Skills added:    ${result.skillsAdded.toString().padStart(8)}                           ║`,
    `║  Skills updated:  ${result.skillsUpdated.toString().padStart(8)}                           ║`,
    `║  Skills skipped:  ${result.skillsSkipped.toString().padStart(8)}                           ║`,
    `║  Conflicts:       ${result.conflicts.length.toString().padStart(8)}                           ║`,
    `║  Duration:        ${(result.duration / 1000).toFixed(2).padStart(8)}s                          ║`,
    '╚══════════════════════════════════════════════════════════════╝',
    '',
  ]

  return lines.join('\n')
}

/**
 * Create the merge command
 */
export function createMergeCommand(): Command {
  const command = new Command('merge')
    .description('Merge skills from one database into another')
    .argument('<source>', 'Source database path to merge from')
    .argument('[target]', 'Target database path (default: local skills.db)')
    .option(
      '-s, --strategy <strategy>',
      'Merge strategy: keep_target, keep_source, keep_newer, merge_fields',
      'keep_newer'
    )
    .option('-d, --dry-run', 'Preview changes without applying them', false)
    .option('-v, --verbose', 'Show detailed conflict information', false)
    .option('-q, --quiet', 'Only output errors', false)
    .option('--force', 'Skip compatibility checks', false)
    .action(async (sourcePath: string, targetPath: string | undefined, options) => {
      const { strategy, dryRun, verbose, quiet, force } = options

      // Validate strategy
      const validStrategies: MergeStrategy[] = [
        'keep_target',
        'keep_source',
        'keep_newer',
        'merge_fields',
      ]
      if (!validStrategies.includes(strategy as MergeStrategy)) {
        console.error(`Invalid strategy: ${strategy}`)
        console.error(`Valid strategies: ${validStrategies.join(', ')}`)
        process.exit(1)
      }

      // Resolve paths
      const resolvedSource = resolve(sourcePath)
      const resolvedTarget = targetPath ? resolve(targetPath) : getDefaultDbPath()

      // Check source exists
      if (!existsSync(resolvedSource)) {
        console.error(`Source database not found: ${resolvedSource}`)
        process.exit(1)
      }

      // Check target exists (or will be created)
      if (!existsSync(resolvedTarget)) {
        console.error(`Target database not found: ${resolvedTarget}`)
        console.error('Create a new database first with: skillsmith init')
        process.exit(1)
      }

      if (!quiet) {
        console.log('╔══════════════════════════════════════════════════════════════╗')
        console.log('║              Skillsmith Database Merge                       ║')
        console.log('╠══════════════════════════════════════════════════════════════╣')
        console.log(`║  Source:   ${resolvedSource.slice(-48).padEnd(48)} ║`)
        console.log(`║  Target:   ${resolvedTarget.slice(-48).padEnd(48)} ║`)
        console.log(`║  Strategy: ${(strategy as string).padEnd(48)} ║`)
        console.log(`║  Dry Run:  ${(dryRun ? 'Yes' : 'No').padEnd(48)} ║`)
        console.log('╚══════════════════════════════════════════════════════════════╝')
        console.log('')
      }

      // Open databases
      let sourceDb: ReturnType<typeof Database> | null = null
      let targetDb: ReturnType<typeof Database> | null = null

      try {
        sourceDb = new Database(resolvedSource, { readonly: true })
        targetDb = new Database(resolvedTarget)

        // Check schema compatibility
        if (!force) {
          const sourceCompat = checkSchemaCompatibility(sourceDb)
          const targetCompat = checkSchemaCompatibility(targetDb)

          if (!sourceCompat.isCompatible) {
            console.error(`Source database: ${sourceCompat.message}`)
            process.exit(1)
          }

          if (!targetCompat.isCompatible) {
            console.error(`Target database: ${targetCompat.message}`)
            process.exit(1)
          }

          if (!quiet && sourceCompat.action !== 'none') {
            console.log(`Source: ${sourceCompat.message}`)
          }
          if (!quiet && targetCompat.action !== 'none') {
            console.log(`Target: ${targetCompat.message}`)
          }
        }

        // Configure merge options
        const mergeOptions: MergeOptions = {
          strategy: strategy as MergeStrategy,
          dryRun,
          skipInvalid: true,
          onConflict: verbose
            ? (conflict) => {
                console.log(`  Conflict: ${conflict.skillId} (${conflict.reason})`)
                return strategy as MergeStrategy
              }
            : undefined,
        }

        // Perform merge
        if (!quiet) {
          console.log('Merging databases...')
        }

        const result = mergeSkillDatabases(targetDb, sourceDb, mergeOptions)

        // Display results
        if (!quiet) {
          console.log(formatMergeResult(result))

          if (dryRun) {
            console.log('⚠️  DRY RUN: No changes were made to the target database.')
            console.log('   Remove --dry-run to apply these changes.')
          } else {
            console.log('✅ Merge complete!')
          }
        }

        // Exit with error if there were issues
        if (result.skillsAdded === 0 && result.skillsUpdated === 0) {
          if (!quiet) {
            console.log('\nNo new skills to merge.')
          }
        }
      } catch (error) {
        console.error('Merge failed:', error instanceof Error ? error.message : error)
        process.exit(1)
      } finally {
        sourceDb?.close()
        targetDb?.close()
      }
    })

  return command
}

export default createMergeCommand
