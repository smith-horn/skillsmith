/**
 * CLI argument parsing, help text, and environment validation for the
 * Batch Skill Transformation CLI.
 *
 * Extracted from batch-transform-skills.ts (SMI-4935) to keep each module
 * under the 500-line limit. See batch-transform-skills.ts for the entrypoint.
 */

import { parseArgs } from 'node:util'
import { DEFAULT_CHECKPOINT_INTERVAL } from './lib/constants'
import type { CliOptions, EnvConfig, ProgressMode } from './batch-transform-skills.types'
import { getDefaultProgressMode, validateProgressMode } from './batch-transform-skills.progress'

export function parseCliArgs(): CliOptions {
  const { values } = parseArgs({
    options: {
      limit: { type: 'string', short: 'l' },
      offset: { type: 'string', short: 'o' },
      'dry-run': { type: 'boolean', short: 'd' },
      verbose: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
      resume: { type: 'boolean', short: 'r' },
      reset: { type: 'boolean' },
      'checkpoint-interval': { type: 'string', short: 'C' },
      force: { type: 'boolean', short: 'f' },
      'no-rate-limit': { type: 'boolean' },
      // SMI-2201: Filter flags
      'retry-failed': { type: 'boolean' },
      'retry-skipped': { type: 'boolean' },
      'only-missing': { type: 'boolean' },
      since: { type: 'string' },
      'trust-tier': { type: 'string' },
      'monorepo-skills': { type: 'boolean' },
      // SMI-2204: Progress and output options
      progress: { type: 'string', short: 'p' },
      json: { type: 'boolean' },
    },
    allowPositionals: false,
  })

  // Validate progress mode using exported function
  const progressMode = values.progress as ProgressMode | undefined
  if (progressMode && !validateProgressMode(progressMode)) {
    console.error(`Error: Invalid progress mode '${progressMode}'. Valid modes: dots, bar, json`)
    process.exit(1)
  }

  return {
    limit: values.limit ? parseInt(values.limit, 10) : Infinity,
    offset: values.offset ? parseInt(values.offset, 10) : 0,
    dryRun: values['dry-run'] ?? false,
    verbose: values.verbose ?? false,
    help: values.help ?? false,
    resume: values.resume ?? false,
    reset: values.reset ?? false,
    checkpointInterval: values['checkpoint-interval']
      ? parseInt(values['checkpoint-interval'], 10)
      : DEFAULT_CHECKPOINT_INTERVAL,
    force: values.force ?? false,
    noRateLimit: values['no-rate-limit'] ?? false,
    // SMI-2201: Filter flags
    retryFailed: values['retry-failed'] ?? false,
    retrySkipped: values['retry-skipped'] ?? false,
    onlyMissing: values['only-missing'] ?? false,
    since: values.since,
    trustTier: values['trust-tier'],
    monorepoSkills: values['monorepo-skills'] ?? false,
    // SMI-2204: Progress and output options
    progress: progressMode ?? getDefaultProgressMode(),
    json: values.json ?? false,
  }
}

export function printHelp(): void {
  console.log(`
Batch Skill Transformation CLI
SMI-1840: Pre-transform skills using TransformationService
SMI-2200: Checkpoint-based resumability
SMI-2201: Targeted backfill modes
SMI-2203: Dynamic rate limiting
SMI-2204: Progress modes and UX improvements

Usage:
  varlock run -- npx tsx scripts/batch-transform-skills.ts [options]

Options:
  --limit, -l <n>              Maximum skills to process (default: all)
  --offset, -o <n>             Skip first n skills (default: 0)
  --dry-run, -d                Preview transformations without saving
  --verbose, -v                Show detailed output
  --resume, -r                 Continue from last checkpoint
  --reset                      Clear checkpoint and start over (prompts for confirmation)
  --checkpoint-interval, -C <n> Save checkpoint every N skills (default: ${DEFAULT_CHECKPOINT_INTERVAL})
  --force, -f                  Skip confirmation prompts (for CI/scripted use)
  --no-rate-limit              Bypass dynamic rate limiting (fixed 50ms delay)
  --help, -h                   Show this help message

Filter Flags (SMI-2201):
  --retry-failed               Only process skills where previous transform failed
  --retry-skipped              Only process skills that were skipped (SKILL.md not found)
  --only-missing               Only process skills without existing transformation
  --since <YYYY-MM-DD>         Only process skills indexed after date (ISO-8601)
  --trust-tier <tier>          Filter by trust tier (verified, community, experimental, unknown)
  --monorepo-skills            Only process monorepo subdirectory skills (tree URLs)

Progress and Output (SMI-2204):
  --progress, -p <mode>        Progress display mode (default: bar in TTY, dots in CI)
                               - dots: Simple progress dots (. = ok, s = skip, F = fail)
                               - bar: Progress bar with ETA (requires TTY)
                               - json: NDJSON output per skill (for scripting)
  --json                       Output final results as JSON (machine-readable)

Environment Variables:
  SUPABASE_URL                 Supabase project URL (required)
  SUPABASE_SERVICE_ROLE_KEY    Supabase service role key (required)
  GITHUB_TOKEN                 GitHub token for higher rate limits (optional)
  GITHUB_API_BASE_DELAY        Base delay between GitHub requests in ms (default: 150)

Examples:
  # Dry-run first 10 skills
  varlock run -- npx tsx scripts/batch-transform-skills.ts --dry-run --limit 10

  # Transform all skills with verbose output
  varlock run -- npx tsx scripts/batch-transform-skills.ts --verbose

  # Resume from last checkpoint
  varlock run -- npx tsx scripts/batch-transform-skills.ts --resume

  # Reset checkpoint and start fresh
  varlock run -- npx tsx scripts/batch-transform-skills.ts --reset --force

  # Retry only failed skills
  varlock run -- npx tsx scripts/batch-transform-skills.ts --retry-failed --verbose

  # Process only missing transformations for verified tier
  varlock run -- npx tsx scripts/batch-transform-skills.ts --only-missing --trust-tier verified

  # Process skills indexed since January 25, 2026
  varlock run -- npx tsx scripts/batch-transform-skills.ts --since 2026-01-25

  # Dry-run with filter preview
  varlock run -- npx tsx scripts/batch-transform-skills.ts --dry-run --only-missing --monorepo-skills

  # Use progress bar mode
  varlock run -- npx tsx scripts/batch-transform-skills.ts --progress bar

  # Output JSON for scripting
  varlock run -- npx tsx scripts/batch-transform-skills.ts --json --progress json
`)
}

export function validateEnv(): EnvConfig {
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const githubToken = process.env.GITHUB_TOKEN

  const missing: string[] = []
  if (!supabaseUrl) missing.push('SUPABASE_URL')
  if (!supabaseServiceKey) missing.push('SUPABASE_SERVICE_ROLE_KEY')

  if (missing.length > 0) {
    console.error('\nError: Missing required environment variables:')
    missing.forEach((v) => console.error(`  - ${v}`))
    console.error('\nMake sure to run with Varlock:')
    console.error('  varlock run -- npx tsx scripts/batch-transform-skills.ts')
    process.exit(2)
  }

  return {
    supabaseUrl: supabaseUrl!,
    supabaseServiceKey: supabaseServiceKey!,
    githubToken,
  }
}
