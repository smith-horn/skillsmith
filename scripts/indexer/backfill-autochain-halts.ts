/**
 * SMI-7121: the local driver's safety halts, evaluated by the backfill autochain
 * @module scripts/indexer/backfill-autochain-halts
 *
 * Pure functions only. `evaluateHalts` reads the completed run's checkpoint payload
 * (the counters and `resumed_from` that `backfill-checkpoint.counters.ts` persists)
 * and returns every halt that fired. Fail-closed throughout: a field that is absent
 * or malformed is a halt, never a pass.
 *
 * See docs/internal/implementation/smi-7121-autochain-driver-halts.md (D1-D4).
 */

export const HALT_NAMES = [
  'counters_missing',
  'b1_foreign_cursor',
  'no_default_branch',
  'license_filtered',
  'no_progress_record',
] as const

export type HaltName = (typeof HALT_NAMES)[number]

export interface Halt {
  name: HaltName
  detail: string
}

/** The slice of a checkpoint payload the halts read. Everything is untrusted. */
export interface HaltCheckpoint {
  dispatch_counters?: unknown
  resumed_from?: unknown
  dispatch_inputs?: { pathPrefix?: unknown } | null
}

/** The driver's default `BACKFILL_NDB_MAX`. */
export const DEFAULT_NDB_MAX = 50

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

interface ParsedCounters {
  no_default_branch: number
  license_filtered: number
}

/** All four counters must be non-negative integers, else the counters are unusable. */
function parseCounters(raw: unknown): ParsedCounters | null {
  if (!isRecord(raw)) return null
  const { no_default_branch: ndb, license_filtered: lf, admitted, ranges_crawled: rc } = raw
  if (!isCount(ndb) || !isCount(lf) || !isCount(admitted) || !isCount(rc)) return null
  return { no_default_branch: ndb, license_filtered: lf }
}

/**
 * Evaluate the halts for a checkpoint-path link (not the retry path, which crawled
 * nothing and is exempt). Order: counters_missing, b1_foreign_cursor,
 * no_default_branch, license_filtered.
 */
export function evaluateHalts(checkpoint: HaltCheckpoint, opts: { ndbMax: number }): Halt[] {
  const halts: Halt[] = []
  const hasResumedFrom = 'resumed_from' in checkpoint
  const counters = parseCounters(checkpoint.dispatch_counters)
  const countersOk = counters !== null

  if (!countersOk || !hasResumedFrom) {
    const missing = [
      ...(countersOk ? [] : ['dispatch_counters (absent or malformed)']),
      ...(hasResumedFrom ? [] : ['resumed_from (absent)']),
    ].join(', ')
    halts.push({
      name: 'counters_missing',
      detail: `The checkpoint lacks ${missing}: it predates SMI-7121 or the run could not record them, so the safety halts cannot be evaluated.`,
    })
  }

  const resumedFrom = checkpoint.resumed_from
  const prefix = checkpoint.dispatch_inputs?.pathPrefix
  if (hasResumedFrom && resumedFrom !== null && resumedFrom !== undefined) {
    const loadedPath = isRecord(resumedFrom) ? resumedFrom.path : undefined
    if (typeof prefix !== 'string') {
      // Fail closed: without a usable dispatch prefix the property cannot be checked.
      halts.push({
        name: 'b1_foreign_cursor',
        detail: `The run resumed from a checkpoint (path=${JSON.stringify(loadedPath ?? null)}) but its dispatch path_prefix is missing or unusable (${JSON.stringify(prefix ?? null)}), so a foreign cursor cannot be ruled out.`,
      })
    } else if (loadedPath !== prefix) {
      halts.push({
        name: 'b1_foreign_cursor',
        detail: `The run resumed from a checkpoint with path=${JSON.stringify(loadedPath ?? null)} but its dispatch path_prefix is ${JSON.stringify(prefix)}: a foreign cursor was inherited.`,
      })
    }
  }

  if (counters) {
    if (counters.no_default_branch > opts.ndbMax) {
      halts.push({
        name: 'no_default_branch',
        detail: `no_default_branch=${counters.no_default_branch} exceeds the threshold ${opts.ndbMax} (W5 regression).`,
      })
    }
    if (counters.license_filtered > 0) {
      halts.push({
        name: 'license_filtered',
        detail: `license_filtered=${counters.license_filtered} exceeds the threshold 0 (gate regression).`,
      })
    }
  }
  return halts
}

/** `BACKFILL_NDB_MAX`: undefined or '' is the default; else digits only, or throw. */
export function parseNdbMax(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_NDB_MAX
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(
      `BACKFILL_NDB_MAX must be a non-negative integer (digits only), got ${JSON.stringify(raw)}`
    )
  }
  const n = Number(raw)
  if (!Number.isSafeInteger(n)) {
    throw new Error(`BACKFILL_NDB_MAX is out of range: ${JSON.stringify(raw)}`)
  }
  return n
}

/** `ACKNOWLEDGE_HALTS`: comma-separated known halt names; unknown or unacknowledgeable throws. */
export function parseAcknowledgedHalts(raw: string | undefined): Set<HaltName> {
  const acked = new Set<HaltName>()
  if (raw === undefined || raw === '') return acked
  for (const part of raw.split(',')) {
    const name = part.trim()
    if (name === 'no_progress_record') {
      throw new Error(
        'no_progress_record cannot be acknowledged: there is nothing to resume from. Follow the runbook manual-dispatch procedure.'
      )
    }
    if (!(HALT_NAMES as readonly string[]).includes(name)) {
      throw new Error(
        `ACKNOWLEDGE_HALTS names an unknown halt ${JSON.stringify(name)}; known: ${HALT_NAMES.join(', ')}`
      )
    }
    acked.add(name as HaltName)
  }
  return acked
}

/**
 * The canonical comma list for an acknowledgement (SMI-7121: carried on a deferral marker so
 * it survives the pause): parsed exactly as {@link parseAcknowledgedHalts} (so unknown names
 * and `no_progress_record` throw), deduplicated, in HALT_NAMES order. `''` means none.
 */
export function canonicalAcknowledgedHalts(raw: string | undefined): string {
  const acked = parseAcknowledgedHalts(raw)
  return HALT_NAMES.filter((n) => acked.has(n)).join(',')
}

/** Only the halts the operator has not acknowledged. */
export function applyAcknowledgements(halts: Halt[], acked: Set<HaltName>): Halt[] {
  return halts.filter((h) => !acked.has(h.name))
}

/** The `no_progress_record` halt: no checkpoint and no skip-branch row for a finished run. */
export function noProgressRecordHalt(supabaseEnv: string): Halt {
  return {
    name: 'no_progress_record',
    detail: `No checkpoint or skip-branch audit row exists for this run in the ${supabaseEnv} project. Three causes leave no row, each with its own log line: a lock-lost abort (backfill_aborted_lock_lost), a failed subdirectory phase (subdirectory_search error phase_failed), or a failed checkpoint write (checkpoint FAILED). Check the run log for which one.`,
  }
}

/** The GITHUB_OUTPUT map for a halted link. `skip: 'true'` so nothing dispatches. */
export function haltOutputs(halts: Halt[]): Record<string, string> {
  const names = halts.map((h) => h.name).join(',')
  const message = halts.map((h) => `${h.name}: ${h.detail}`).join('\n')
  return {
    skip: 'true',
    halted: 'true',
    halt_names: names,
    halt_message: message,
    skip_reason: `Halted (${names}): ${message}`,
  }
}
