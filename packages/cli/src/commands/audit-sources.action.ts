/**
 * @fileoverview Action implementation for `sklx audit sources`.
 * @module @skillsmith/cli/commands/audit-sources.action
 * @see SMI-5407
 *
 * Wires SourceRecoveryService (with real findCandidatesByName over the CLI DB)
 * and backfillManifest. Applies an already_tracked overlay after recovery (the
 * core service cannot know the current manifest state).
 *
 * Safety:
 *   - Dry-run unless --apply.
 *   - --apply requires typed phrase `BACKFILL SOURCES` (waived by --yes).
 *   - --write-frontmatter requires --force-write-frontmatter and prints a bold
 *     stderr WARNING before proceeding.
 *
 * Output:
 *   Human: === Skillsmith — Source Recovery === + table + footer summary.
 *   --json: { skills, summary } to stdout, no prompts, no file mutation.
 */

import { input } from '@inquirer/prompts'
import chalk from 'chalk'

import { hashContent } from '@skillsmith/core/services/skill-installation-helpers'
import {
  SourceRecoveryService,
  defaultSkillsRoot,
  backfillManifest,
  parseRepoUrl,
  skillNameVariants,
  METHOD_LABELS,
  type RecoveryCandidate,
  type RecoveryConfidence,
  type RecoveryReport,
  type SkillRecoveryResult,
} from '@skillsmith/core'
import { withTelemetry } from '@skillsmith/core/telemetry'
import { openCliDatabase } from '../utils/open-database.js'
import { loadManifest } from '../utils/manifest.js'
import { sanitizeError } from '../utils/sanitize.js'
import { DEFAULT_DB_PATH } from '../config.js'

// ============================================================================
// Constants
// ============================================================================

const BACKFILL_PHRASE = 'BACKFILL SOURCES'

const CONFIDENCE_BADGES: Record<RecoveryConfidence, string> = {
  exact: '[EXACT]',
  high: '[HIGH]',
  medium: '[MEDIUM]',
  low: '[LOW]',
  'user-specified': '[SET]',
  unknown: '[-]',
}

// ============================================================================
// Helpers
// ============================================================================

/** Parse `--set` pairs like `"dirName=owner/repo"` → Record. */
function parseSetPairs(pairs: string[] | undefined): Record<string, string> {
  if (!pairs || pairs.length === 0) return {}
  const out: Record<string, string> = {}
  for (const pair of pairs) {
    const eq = pair.indexOf('=')
    if (eq < 1) {
      console.error(chalk.yellow(`[audit sources] ignoring malformed --set pair: ${pair}`))
      continue
    }
    out[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return out
}

/** Parse `minConfidence` CLI value; fall back to `'high'` on unknown input. */
function parseMinConfidence(value: string | undefined): RecoveryConfidence {
  const valid: RecoveryConfidence[] = ['exact', 'high', 'medium', 'low', 'user-specified']
  const v = (value ?? 'high') as RecoveryConfidence
  return valid.includes(v) ? v : 'high'
}

/**
 * Apply the already_tracked overlay: a skill whose manifest entry already has a
 * non-empty source should be marked `already_tracked` (the core service cannot
 * know the current manifest state).
 *
 * Mutates `report.skills` in place and recomputes `report.summary`.
 */
async function overlayAlreadyTracked(report: RecoveryReport): Promise<void> {
  const manifest = await loadManifest()
  const installed = manifest.installedSkills ?? {}
  for (const skill of report.skills) {
    const entry = installed[skill.skillName]
    if (entry && typeof entry.source === 'string' && entry.source.trim().length > 0) {
      skill.status = 'already_tracked'
    }
  }
  // Recompute summary totals from mutated statuses.
  report.summary.recovered = 0
  report.summary.already_tracked = 0
  report.summary.unknown = 0
  report.summary.skipped_backup = 0
  for (const skill of report.skills) {
    report.summary[skill.status] += 1
  }
}

// ============================================================================
// Output — human-readable
// ============================================================================

const COL_SKILL = 24
const COL_SOURCE = 46
const COL_CONF = 12

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n - 1) + ' ' : s.padEnd(n)
}

function sourceCell(skill: SkillRecoveryResult): string {
  if (skill.status === 'already_tracked') return '(already tracked)'
  if (skill.status === 'skipped_backup') return '(backup — skipped)'
  if (skill.candidates.length > 1) return '(ambiguous)'
  if (!skill.recoveredSource) return '(unresolved)'
  return skill.recoveredSource.url
}

function confCell(skill: SkillRecoveryResult): string {
  if (skill.status === 'already_tracked' || skill.status === 'skipped_backup') return '-'
  return CONFIDENCE_BADGES[skill.confidence] ?? '?'
}

function methodCell(skill: SkillRecoveryResult): string {
  if (skill.status === 'already_tracked' || skill.status === 'skipped_backup') return '-'
  if (!skill.method) return '-'
  return METHOD_LABELS[skill.method] ?? skill.method
}

function printHumanReport(report: RecoveryReport, applying: boolean): void {
  console.log(chalk.bold.blue('\n=== Skillsmith — Source Recovery ===\n'))

  const hdr =
    pad('skill', COL_SKILL) +
    '| ' +
    pad('source', COL_SOURCE) +
    '| ' +
    pad('confidence', COL_CONF) +
    '| method'
  const sep = '-'.repeat(hdr.length)
  console.log(hdr)
  console.log(sep)

  for (const skill of report.skills) {
    const row =
      pad(skill.skillName, COL_SKILL) +
      '| ' +
      pad(sourceCell(skill), COL_SOURCE) +
      '| ' +
      pad(confCell(skill), COL_CONF) +
      '| ' +
      methodCell(skill)
    console.log(row)

    // Multi-candidate indented row for ambiguous name matches.
    if (skill.candidates.length > 1) {
      const parts = skill.candidates
        .map((c: RecoveryCandidate, i: number) => `(${i + 1}) ${c.owner}/${c.repo}`)
        .join(' ')
      console.log(chalk.dim(`  -> ${parts} [ambiguous — --set or --embedding]`))
    }
  }

  console.log()

  const s = report.summary
  const exactCount = report.skills.filter(
    (sk) => sk.status === 'recovered' && sk.confidence === 'exact'
  ).length
  const highCount = report.skills.filter(
    (sk) =>
      sk.status === 'recovered' && (sk.confidence === 'high' || sk.confidence === 'user-specified')
  ).length

  console.log(
    chalk.bold(
      `Summary: ${s.total} scanned, ${s.recovered} recovered ` +
        `(${exactCount} exact, ${highCount} high), ` +
        `${s.already_tracked} already-tracked, ` +
        `${s.unknown} unresolved, ` +
        `${s.skipped_backup} backups skipped.`
    )
  )

  if (!applying) {
    console.log(chalk.dim('Dry run — --apply to backfill.'))
  }
  console.log()
}

// ============================================================================
// Typed-confirmation gate
// ============================================================================

async function requireBackfillPhrase(): Promise<void> {
  const answer = await input({
    message: `Type ${chalk.bold(BACKFILL_PHRASE)} to confirm writing recovered sources to the manifest`,
  })
  if (answer !== BACKFILL_PHRASE) {
    throw new Error(
      `Confirmation phrase mismatch — operation aborted. ` + `Must be exactly: ${BACKFILL_PHRASE}`
    )
  }
}

// ============================================================================
// Options
// ============================================================================

export interface AuditSourcesOptions {
  skillsRoot: string | undefined
  apply: boolean
  yes: boolean
  set: string[] | undefined
  minConfidence: string
  json: boolean
  embedding: boolean
  catalogHint: boolean
  writeFrontmatter: boolean
  forceWriteFrontmatter: boolean
  db: string
}

// ============================================================================
// Main entry
// ============================================================================

export async function runAuditSources(options: AuditSourcesOptions): Promise<void> {
  const skillsRoot = options.skillsRoot ?? defaultSkillsRoot()
  const setOverrides = parseSetPairs(options.set)
  const minConfidence = parseMinConfidence(options.minConfidence)

  // --write-frontmatter requires --force-write-frontmatter.
  if (options.writeFrontmatter && !options.forceWriteFrontmatter) {
    console.error(
      chalk.red(
        '--write-frontmatter requires --force-write-frontmatter. ' +
          'Re-run with both flags to modify SKILL.md files inside installed skill directories.'
      )
    )
    process.exit(1)
    return
  }

  // Bold warning when frontmatter mutation is armed.
  if (options.writeFrontmatter && options.forceWriteFrontmatter) {
    console.error(
      chalk.bold.yellow(
        'WARNING: --write-frontmatter will modify SKILL.md files inside ' +
          'git-tracked skill repos. This operation is irreversible without a git reset.'
      )
    )
  }

  // Open local DB (required for findCandidatesByName).
  const db = await openCliDatabase(options.db)
  let report: RecoveryReport

  try {
    const findCandidatesByName = async (name: string): Promise<RecoveryCandidate[]> => {
      type SkillRow = {
        id: string
        name: string
        repo_url: string | null
        quality_score: number | null
      }
      const variants = skillNameVariants(name)
      const placeholders = variants.map(() => '?').join(', ')
      const rows = db
        .prepare<SkillRow>(
          `SELECT id, name, repo_url, quality_score FROM skills WHERE name IN (${placeholders})`
        )
        .all(...variants)

      const candidates: RecoveryCandidate[] = []
      for (const row of rows) {
        if (!row.repo_url) continue
        try {
          const parsed = parseRepoUrl(row.repo_url)
          candidates.push({
            id: row.id,
            name: row.name,
            owner: parsed.owner,
            repo: parsed.repo,
            url: `https://github.com/${parsed.owner}/${parsed.repo}`,
            qualityScore: row.quality_score ?? 0,
          })
        } catch {
          // Non-GitHub repo_url — skip candidate.
        }
      }
      // Prefer an exact-name match so the affix-broadened query never downgrades
      // a clean exact hit to ambiguous; fall back to affix variants. SMI-5413.
      const exact = candidates.filter((c) => c.name.toLowerCase() === name.toLowerCase())
      return exact.length > 0 ? exact : candidates
    }

    const service = new SourceRecoveryService({ hashContent, findCandidatesByName })

    report = await service.recoverSources({
      skillsRoot,
      enableEmbedding: options.embedding,
      enableCatalogHint: options.catalogHint,
    })
  } finally {
    db.close()
  }

  // Overlay already_tracked status from the current manifest.
  await overlayAlreadyTracked(report)

  // --json: emit raw data, no prompts, no writes.
  if (options.json) {
    process.stdout.write(
      JSON.stringify({ skills: report.skills, summary: report.summary }, null, 2)
    )
    process.stdout.write('\n')
    return
  }

  printHumanReport(report, options.apply)

  if (!options.apply) return

  // --apply: confirm and write.
  if (!options.yes) {
    await requireBackfillPhrase()
  }

  const outcome = await backfillManifest(report, {
    minConfidence,
    apply: true,
    setOverrides,
    writeFrontmatter: options.writeFrontmatter,
  })

  if (outcome.written.length > 0) {
    console.log(
      chalk.green(`Backfilled ${outcome.written.length} skill(s): ${outcome.written.join(', ')}`)
    )
  } else {
    console.log(chalk.dim('Nothing new to backfill.'))
  }
  if (outcome.skipped.length > 0) {
    console.log(chalk.dim(`Skipped: ${outcome.skipped.join(', ')}`))
  }
}

// ============================================================================
// withTelemetry-wrapped export (SMI-5127+)
// ============================================================================

async function auditSourcesActionImpl(
  skillsRoot: string | undefined,
  opts: Record<string, unknown>
): Promise<void> {
  try {
    await runAuditSources({
      skillsRoot,
      apply: (opts['apply'] as boolean) ?? false,
      yes: (opts['yes'] as boolean) ?? false,
      set: opts['set'] as string[] | undefined,
      minConfidence: (opts['minConfidence'] as string | undefined) ?? 'high',
      json: (opts['json'] as boolean) ?? false,
      embedding: (opts['embedding'] as boolean) ?? false,
      catalogHint: (opts['catalogHint'] as boolean) ?? false,
      writeFrontmatter: (opts['writeFrontmatter'] as boolean) ?? false,
      forceWriteFrontmatter: (opts['forceWriteFrontmatter'] as boolean) ?? false,
      db: (opts['db'] as string | undefined) ?? DEFAULT_DB_PATH,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : sanitizeError(error)
    if (msg.startsWith('Confirmation phrase mismatch')) {
      console.error(chalk.yellow(msg))
    } else {
      console.error(chalk.red('Error:'), msg)
    }
    process.exit(1)
  }
}

export const auditSourcesAction = withTelemetry(auditSourcesActionImpl, {
  source: 'cli',
  extractSkillId: () => 'audit-sources',
  extractFramework: () => 'cli',
})

export { BACKFILL_PHRASE }
