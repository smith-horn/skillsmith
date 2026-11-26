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
 * SMI-7260: the one warning for a command whose database exists but could not
 * be opened (ADR-175 § 5: one warning per command, naming the cause and the
 * remedy; the command still exits 0). Used INSTEAD of {@link warnUndetermined}
 * in that case, so the cause is not printed twice: every undetermined row is
 * explained by this one failure. Printed with no skills installed too, so the
 * database fault is visible even when no row could carry it.
 *
 * @param error - the open failure; its message carries the remedy (for a
 *   corruption refusal, the files and the commands).
 * @param undetermined - how many rows are "Unknown"; normally all of them,
 *   fewer only if the scan's several opens of the one file disagreed.
 */
export function warnDatabaseUnopenable(error: unknown, undetermined: number, total: number): void {
  const opened = 'the local database could not be opened'
  const scope =
    undetermined === 0
      ? `The local database could not be opened${total === 0 ? ', so no update status could be checked' : ''}`
      : `${undetermined === total ? "No skill's update status could be determined" : `${undetermined} of ${total} skills' update status could not be determined`}: ${opened}. ` +
        `Shown as "Unknown" rather than "Up to date" — this is not a claim that they are current`
  logger.warn(chalk.yellow(`${scope}.`) + `\n${sanitizeError(error)}`)
}
