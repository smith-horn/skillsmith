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
 * {@link warnUndetermined} in that case, so the open failure is printed once,
 * with no skills installed too.
 *
 * The scan opens the one database once per directory it scans, so the opens
 * can disagree (a transient WASM unstable read in one, a clean read in
 * another). Hence the three shapes:
 *
 * - no skills: the failure, and that no update status could be checked;
 * - skills, none undetermined: one open failed but every listed skill was
 *   still checked (so it does not contradict "All installed skills are up to
 *   date.");
 * - some undetermined: how many, the open failure, and any OTHER reason among
 *   those rows (a lookup that failed after a good open), named so it is not
 *   lost.
 *
 * @param error - the first open failure; its message carries the remedy (for
 *   a corruption refusal, the files and the commands).
 * @param openReasons - the per-skill reasons the failed opens were classified
 *   as; undetermined rows with any other reason are named separately.
 */
export function warnDatabaseUnopenable(
  error: unknown,
  openReasons: ReadonlySet<string>,
  undetermined: InstalledSkill[],
  total: number
): void {
  const otherReasons = [
    ...new Set(
      undetermined
        .map((s) => s.updateStatusReason)
        .filter((r): r is string => !!r && !openReasons.has(r))
    ),
  ]
  let scope: string
  if (total === 0) {
    scope = 'The local database could not be opened, so no update status could be checked.'
  } else if (undetermined.length === 0) {
    scope =
      "One of the local database's opens failed, but every listed skill's update status was " +
      'still checked.'
  } else {
    const count =
      undetermined.length === total
        ? "No skill's update status could be determined"
        : `${undetermined.length} of ${total} skills' update status could not be determined`
    const also = otherReasons.length > 0 ? `; also: ${otherReasons.join('; ')}` : ''
    scope =
      `${count}: the local database could not be opened${also}. ` +
      `Shown as "Unknown" rather than "Up to date" — this is not a claim that they are current.`
  }
  logger.warn(chalk.yellow(scope) + `\n${sanitizeError(error)}`)
}
