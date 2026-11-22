/**
 * SMI-6531 (A1 step 8-i-a-1): the park-result path (A1 plan §3.5, UD66).
 *
 * Every production park goes through a `ParkReporter`: it calls
 * `parkTreeIndexed` (or a test's replacement) and records whether the park
 * moved anything (`parked` or `held`). Once per command, after every lock is
 * released, `finish` lists the set-aside folders and returns the space
 * warning, or null. A caller that parks therefore gets the warning from the
 * same object it parked through, and cannot forget to evaluate it.
 *
 * This is the only production module that imports `parkTreeIndexed`; a static
 * boundary test pins that (`park-report.boundary.test.ts`).
 *
 * `finish` never throws: the command it follows has already finished, so a
 * failure to list or measure becomes one line saying the check could not run,
 * the way `doctor backups` reported it before this path existed.
 *
 * @module @skillsmith/core/services/park-report
 */
import { parkTreeIndexed } from '../install/park-call.js'
import type { ParkOptions, ParkResult } from '../install/park-result.js'
import { listBackups } from './skill-backups.listing.js'
import type { ListBackupsOptions } from './skill-backups.listing.js'

/** The park call's signature, as `parkTreeIndexed` has it. */
export type ParkFn = (parentAbs: string, name: string, options: ParkOptions) => Promise<ParkResult>

/** What `finish` reads. */
interface ParkReportContext {
  /** The listing the warning is evaluated over (roots to add, test seams). */
  listing?: ListBackupsOptions
}

export interface ParkReporter {
  /** Parks through `parkTreeIndexed` (or the injected park) and records a move. The result is unchanged. */
  readonly park: ParkFn
  /**
   * The space warning, or null: null when nothing moved, or when the listing
   * finds nothing over its threshold and every entry measured. Call it once,
   * after every lock is released. Never throws.
   */
  finish(ctx?: ParkReportContext): Promise<string | null>
}

/** The line `finish` returns when the listing itself failed. */
const usageCheckFailed = (err: unknown): string =>
  `Could not check how much space Skillsmith's set-aside folders take: ${
    err instanceof Error ? err.message : String(err)
  }`

/**
 * A reporter for one command. `park` replaces `parkTreeIndexed` (a test seam,
 * or an outer reporter's `park`, so a nested one records into it too).
 */
export function createParkReporter(o: { park?: ParkFn | undefined } = {}): ParkReporter {
  const inner: ParkFn = o.park ?? parkTreeIndexed
  let moved = false
  const park: ParkFn = async (parentAbs, name, options) => {
    const r = await inner(parentAbs, name, options)
    if (r.status === 'parked' || r.status === 'held') moved = true
    return r
  }
  return {
    park,
    async finish(ctx: ParkReportContext = {}): Promise<string | null> {
      if (!moved) return null
      try {
        const listing = await listBackups(ctx.listing ?? {})
        return listing.warning.message
      } catch (err) {
        return usageCheckFailed(err)
      }
    },
  }
}
