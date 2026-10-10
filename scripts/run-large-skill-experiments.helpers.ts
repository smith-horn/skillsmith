/**
 * Pure helpers for scripts/run-large-skill-experiments.ts (SMI-7060).
 *
 * Kept out of the main script so they can be unit-tested without downloading
 * skills or invoking Claude, and so the main script (already over the
 * file-length limit, SMI-7011) does not grow.
 */
import { parseFrontmatter } from './indexer/frontmatter-parser.ts'

/**
 * The description TransformationService.transform() needs, read from a
 * SKILL.md's YAML frontmatter with the repo's own parser (folded, literal,
 * quoted and multi-line values included). Anything other than a string --
 * no frontmatter, no description key, a list -- yields ''.
 */
export function skillDescription(content: string): string {
  const description = parseFrontmatter(content)?.description
  return typeof description === 'string' ? description.trim() : ''
}

export interface ExperimentTally {
  /** Skills the run tried to transform. */
  attempted: number
  /** Of those, how many transformations failed. */
  transformFailed: number
  /** A/B tests that produced no successful sample on one side or both. */
  abFailed: number
}

/** The sample arrays an A/B test result carries, one per variant. */
export interface ABSamples {
  original: { tokens: number[] }
  optimized: { tokens: number[] }
}

/**
 * True when an A/B test has nothing to compare: runABTest keeps only
 * successful Claude invocations, so a missing `claude` binary, or every call
 * failing, leaves a side empty while still returning a result (SMI-7067).
 */
export function abTestFailed(result: ABSamples): boolean {
  return result.original.tokens.length === 0 || result.optimized.tokens.length === 0
}

/**
 * The process exit status for a finished run. Any failed transformation or
 * failed A/B test fails the run: a run where every transformation failed used
 * to print "Experiments complete!" and exit 0, which is how a broken
 * transform() call (SMI-7060) went unnoticed, and an A/B test with no samples
 * was counted as completed (SMI-7067).
 */
export function experimentExitCode(tally: ExperimentTally): number {
  return tally.transformFailed > 0 || tally.abFailed > 0 ? 1 : 0
}
