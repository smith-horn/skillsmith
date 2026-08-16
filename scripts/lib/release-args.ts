/**
 * CLI argument parsing + usage text for `scripts/prepare-release.ts`.
 * @module scripts/lib/release-args
 *
 * Extracted per the SMI-4783 convention that keeps the release orchestrator
 * under the 500-line file-length budget (SMI-6033 Wave 1 added the
 * `--no-typosquat-snapshot` flag, which pushed it over).
 */

import { PACKAGE_SPECS } from './version-utils.js'

export interface Options {
  bumps: Map<string, string>
  dryRun: boolean
  noChangelog: boolean
  noCommit: boolean
  noLockfileRegen: boolean
  allowDowngrade: boolean
  check: boolean
  /** SMI-6033 Wave 1 (Gap 7): skip the typosquat-snapshot refresh/gate (Step 6.4). */
  noTyposquatSnapshot: boolean
}

export function parseArgs(): Options {
  const args = process.argv.slice(2)
  const bumps = new Map<string, string>()
  let dryRun = false
  let noChangelog = false
  let noCommit = false
  let noLockfileRegen = false
  let allowDowngrade = false
  let check = false
  let noTyposquatSnapshot = false

  for (const arg of args) {
    if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--no-changelog') {
      noChangelog = true
    } else if (arg === '--no-commit') {
      noCommit = true
    } else if (arg === '--no-lockfile-regen') {
      noLockfileRegen = true
    } else if (arg === '--allow-downgrade') {
      allowDowngrade = true
    } else if (arg === '--check') {
      check = true
    } else if (arg === '--no-typosquat-snapshot') {
      noTyposquatSnapshot = true
    } else if (arg.startsWith('--all=')) {
      const type = arg.split('=')[1]
      for (const spec of PACKAGE_SPECS) {
        bumps.set(spec.shortName, type)
      }
    } else if (arg.startsWith('--core=')) {
      bumps.set('core', arg.split('=')[1])
    } else if (arg.startsWith('--mcp-server=')) {
      bumps.set('mcp-server', arg.split('=')[1])
    } else if (arg.startsWith('--cli=')) {
      bumps.set('cli', arg.split('=')[1])
    } else if (arg.startsWith('--vscode=')) {
      bumps.set('vscode', arg.split('=')[1])
    } else if (arg === '--help' || arg === '-h') {
      printUsage()
      process.exit(0)
    } else {
      console.error(`Unknown argument: ${arg}`)
      printUsage()
      process.exit(1)
    }
  }

  if (bumps.size === 0 && !check) {
    console.error('Error: No packages specified. Use --all=patch or --core=patch etc.')
    printUsage()
    process.exit(1)
  }

  // --check with no explicit bumps audits a patch bump for all packages
  if (check && bumps.size === 0) {
    for (const spec of PACKAGE_SPECS) {
      bumps.set(spec.shortName, 'patch')
    }
  }

  return {
    bumps,
    dryRun,
    noChangelog,
    noCommit,
    noLockfileRegen,
    allowDowngrade,
    check,
    noTyposquatSnapshot,
  }
}

export function printUsage(): void {
  console.log(`
Usage: npx tsx scripts/prepare-release.ts [options]

Package bumps:
  --all=<type>          Bump all packages (patch|minor|major)
  --core=<type|ver>     Bump core (patch|minor|major|X.Y.Z)
  --mcp-server=<type>   Bump mcp-server
  --cli=<type|ver>      Bump cli
  --vscode=<type|ver>   Bump vscode-extension

Options:
  --dry-run             Preview changes without writing
  --no-changelog        Skip changelog generation
  --no-commit           Write files but don't create git commit
  --no-lockfile-regen   Skip 'npm install --package-lock-only' after dep-range bumps (SMI-4775)
  --no-typosquat-snapshot
                        Skip the typosquat reference-snapshot refresh/staleness gate (SMI-6033).
                        Emergency use only: ships whatever snapshot is checked in.
  --check               Audit-only: run npm collision check, no writes, exit non-zero on conflict
  --allow-downgrade     Permit bumping to a semver <= highest published (rare; never overrides equals-published)
  --help                Show this help
`)
}
