/**
 * Reporting for skills whose update status could not be determined
 * (ADR-175 section 5, SMI-6946).
 *
 * Extracted from manage.action.ts to stay under the 500-line standard, the
 * same reason manage.update.helpers.ts exists.
 */
import chalk from 'chalk'
import { getCliLogger } from '../cli-logger.js'
import type { InstalledSkill } from '../utils/skills-directory.js'
import { sanitizeError } from '../utils/sanitize.js'

// Deliberately the CLI's own logger rather than core's `createLogger`: this
// file is reached by suites that mock '@skillsmith/core' wholesale, and adding
// a new core import here would require every one of those mocks to grow an
// export. `manage.action.ts`, which this was extracted from, already uses this.
const logger = getCliLogger()

/**
 * One warning per command for skills whose update state could not be determined.
 *
 * ADR-175 § 5. Per command, not per skill: the cause is almost always a single
 * database fault shared by every entry, and repeating it once per row buries
 * the table it is meant to annotate.
 *
 * Says nothing when nothing is undetermined — silence here is accurate, which
 * is the one case where silence is the right output.
 */
export function warnUndetermined(undetermined: InstalledSkill[], total: number): void {
  if (undetermined.length === 0) return

  // Distinct reasons, in first-seen order. Normally one, since a single open
  // failure explains every row. More than one is reachable two ways: the open
  // succeeded and per-skill lookups failed for differing causes (a corruption
  // code versus anything else), or several scanned directories resolved to
  // different database paths.
  const reasons = [
    ...new Set(undetermined.map((s) => s.updateStatusReason).filter((r): r is string => !!r)),
  ]

  const scope =
    undetermined.length === total
      ? `No skill's update status could be determined`
      : `${undetermined.length} of ${total} skills' update status could not be determined`

  logger.warn(
    chalk.yellow(
      `${scope}${reasons.length > 0 ? `: ${reasons.join('; ')}` : ''}. ` +
        `Shown as "Unknown" rather than "Up to date" — this is not a claim that they are current.`
    )
  )
}

/**
 * SMI-7260: the one warning for a command whose database exists but at least
 * one of whose opens failed (ADR-175 § 5: one warning per command, naming the
 * cause and the remedy; the command still exits 0). Used INSTEAD of
 * {@link warnUndetermined} in that case, with no skills installed too.
 *
 * The scan opens the one database once per directory it scans, so the opens
 * can disagree. The warning is built as:
 *
 * 1. a headline: no skills (no update status could be checked); skills, none
 *    Unknown ("One of"/"Some of" the opens failed, by the number of distinct
 *    causes, but every listed skill was still checked); or some Unknown (how
 *    many, and that the database could not be opened);
 * 2. each distinct failed-open error, deduped by its PRINTED text, which
 *    carries its remedy (for a corruption refusal, the files and the
 *    commands). Not deduped by reason: `classifyOpenFailure` maps several
 *    different errors to one reason, and each must still be named;
 * 3. `Also:` with each distinct Unknown-row reason that is not a failed-open
 *    reason (a lookup that failed after a good open).
 *
 * A row is explained only by a failed-open reason, and every failed open's
 * error is printed. The benign absent case never reaches here: the scan does
 * not report it.
 *
 * @param openReasons - the classified reasons of the failed opens.
 * @param openErrors - every failed open's error, in the order seen.
 */
export function warnDatabaseUnopenable(
  openReasons: ReadonlySet<string>,
  openErrors: readonly unknown[],
  undetermined: InstalledSkill[],
  total: number
): void {
  const causes = [...new Set(openErrors.map((error) => sanitizeError(error)))]
  let headline: string
  if (total === 0) {
    headline = 'The local database could not be opened, so no update status could be checked.'
  } else if (undetermined.length === 0) {
    headline =
      `${causes.length > 1 ? 'Some' : 'One'} of the local database's opens failed, but every ` +
      "listed skill's update status was still checked."
  } else {
    const count =
      undetermined.length === total
        ? "No skill's update status could be determined"
        : `${undetermined.length} of ${total} skills' update status could not be determined`
    headline =
      `${count}: the local database could not be opened. ` +
      `Shown as "Unknown" rather than "Up to date" — this is not a claim that they are current.`
  }
  const otherReasons = [
    ...new Set(
      undetermined
        .map((s) => s.updateStatusReason)
        .filter((r): r is string => !!r && !openReasons.has(r))
    ),
  ]
  const also = otherReasons.length > 0 ? [`Also: ${otherReasons.join('; ')}.`] : []
  logger.warn([chalk.yellow(headline), ...causes, ...also].join('\n'))
}
