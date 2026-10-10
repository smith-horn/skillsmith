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
}

/**
 * The process exit status for a finished run. Any failed transformation fails
 * the run: a run where every transformation failed used to print
 * "Experiments complete!" and exit 0, which is how a broken transform() call
 * (SMI-7060) went unnoticed.
 */
export function experimentExitCode(tally: ExperimentTally): number {
  return tally.transformFailed > 0 ? 1 : 0
}
