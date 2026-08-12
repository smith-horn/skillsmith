/**
 * CLI argument parsing and id-selection reconciliation for
 * revalidate-stale-quarantines.ts, split out (SMI-5879 round-7, design doc
 * §11.2.8) to keep that file under its line budget.
 *
 * Two phases (design §11.2.3), with different guarantees:
 *
 *  - Phase 1 ({@link parseIdSelection}): PURE — argv only, plus exactly one
 *    `fs.readFileSync` call for `--ids-file`. Throws synchronously on any
 *    invalid input, so the process dies before `createSupabaseAdminClient()`
 *    is ever constructed. No console output, no DB touch, no network.
 *  - Phase 2 ({@link reconcileIdSelection} / {@link formatIdSelectionReport}):
 *    runs AFTER the single candidate read (`loadCandidates`) and BEFORE the
 *    processing loop — a refusal here still precedes every write in the
 *    file.
 */

import { readFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Phase 1 — pure argv/file parsing
// ---------------------------------------------------------------------------

/** Parsed CLI selection, ready to hand to `loadCandidates`/`runSweep`. */
export interface IdSelection {
  /** Cutoff over the discovered cohort in ascending-id page order. Mutually exclusive with `ids`. */
  limit?: number
  /** Deduped, order-preserving explicit id allowlist ("requested_unique"). Mutually exclusive with `limit`. */
  ids?: string[]
  /**
   * Count of validated tokens BEFORE dedup ("requested_raw", design §11.2.3:
   * "duplicate ids → deduped, order-preserving; requested_raw and
   * requested_unique both reported"). Deduping silently would hide genuine
   * duplicate input from the operator. Present only when `ids` is present.
   */
  requestedRawCount?: number
}

/** Only letters, digits, `_`, `-` are permitted in an id token; length 1..64. */
const ID_TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Dual `--flag value` / `--flag=value` parse, matching `purge-dead-quarantines.ts`'s
 * `parseLimitArg`/`parseExportArg` convention. Returns `undefined` only when
 * `flag` is entirely ABSENT from argv. If `flag` IS present but supplies no
 * value — a bare flag as the last token, or immediately followed by another
 * `--flag` — this THROWS rather than returning `undefined`: collapsing
 * "present with no value" into the same `undefined` as "absent" would let
 * `--apply --ids` (or any of `--ids`/`--ids-file`/`--limit` given with no
 * value) silently fall through to the unbounded whole-table sweep under
 * `--apply` — the exact failure class this file's phase-1 validation exists
 * to close (round-7-review finding, GPT-5.6-Sol adversarial pass).
 */
function findFlagValue(argv: string[], flag: string): string | undefined {
  const idx = argv.findIndex((a) => a === flag || a.startsWith(`${flag}=`))
  if (idx === -1) return undefined
  const eq = argv[idx].split('=')[1]
  if (eq !== undefined) return eq
  const next = argv[idx + 1]
  if (next === undefined || next.startsWith('--')) {
    throw new Error(
      `[revalidate-stale-quarantines] ${flag} was supplied with no value — refusing rather than treating it as absent.`
    )
  }
  return next
}

function parseLimitValue(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

interface RawToken {
  value: string
  location: string
}

/** Validate one trimmed token; throws naming the offending token and its location. */
function validateToken(token: RawToken): string {
  const trimmed = token.value.trim()
  if (trimmed.length === 0) {
    throw new Error(
      `[revalidate-stale-quarantines] empty id token at ${token.location} — refusing (phase 1).`
    )
  }
  if (!ID_TOKEN_RE.test(trimmed)) {
    const reason =
      trimmed.length > 64
        ? 'exceeds the 64-character limit'
        : 'contains a disallowed character (only letters, digits, "_", "-" are permitted)'
    throw new Error(
      `[revalidate-stale-quarantines] id token at ${token.location} ${reason}: "${trimmed.slice(0, 80)}"`
    )
  }
  return trimmed
}

/** Split `--ids=<a,b,c>` into raw (unvalidated) tokens. An all-whitespace value collapses to zero tokens. */
function parseIdsArgTokens(raw: string): RawToken[] {
  if (raw.trim().length === 0) return []
  return raw.split(',').map((value, i) => ({ value, location: `--ids position ${i + 1}` }))
}

/**
 * Read and tokenize `--ids-file`: one id per line; blank lines and lines
 * whose first non-whitespace character is `#` are ignored. The single
 * `fs.readFileSync` call for the whole module lives here.
 */
function readIdsFileTokens(path: string): RawToken[] {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch (err) {
    throw new Error(
      `[revalidate-stale-quarantines] --ids-file path unreadable: ${path} (${
        err instanceof Error ? err.message : String(err)
      })`
    )
  }
  const lines = content.split('\n')
  const tokens: RawToken[] = []
  for (let i = 0; i < lines.length; i++) {
    const trimmedForCheck = lines[i].trim()
    if (trimmedForCheck.length === 0) continue // blank line
    if (trimmedForCheck.startsWith('#')) continue // comment
    tokens.push({ value: lines[i], location: `--ids-file line ${i + 1}` })
  }
  return tokens
}

/** Dedupe an array, preserving first-occurrence order. */
function dedupeOrderPreserving(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

/**
 * Phase-1 (pure) CLI parser. Throws on: `--ids` + `--ids-file` both present;
 * an id selection together with `--limit`; an unreadable `--ids-file`; any
 * token failing shape validation; or a selection parsing to ZERO ids — the
 * single most important check (design §11.2.3): an empty selection must
 * NEVER fall through to the unbounded whole-table sweep.
 */
export function parseIdSelection(argv: string[]): IdSelection {
  const idsArg = findFlagValue(argv, '--ids')
  const idsFileArg = findFlagValue(argv, '--ids-file')
  const limitArg = findFlagValue(argv, '--limit')

  if (idsArg !== undefined && idsFileArg !== undefined) {
    throw new Error(
      '[revalidate-stale-quarantines] --ids and --ids-file are mutually exclusive — supply exactly one recorded source of truth.'
    )
  }

  const hasIdSelection = idsArg !== undefined || idsFileArg !== undefined

  if (hasIdSelection && limitArg !== undefined) {
    throw new Error(
      '[revalidate-stale-quarantines] --limit is mutually exclusive with --ids/--ids-file — composing them would silently truncate the requested id set (design §11.2.2).'
    )
  }

  if (!hasIdSelection) {
    return { limit: parseLimitValue(limitArg) }
  }

  const rawTokens =
    idsArg !== undefined ? parseIdsArgTokens(idsArg) : readIdsFileTokens(idsFileArg as string)

  if (rawTokens.length === 0) {
    throw new Error(
      '[revalidate-stale-quarantines] the --ids/--ids-file selection parsed to zero ids — refusing. An empty selection must never fall through to the unbounded whole-table sweep.'
    )
  }

  const validated = rawTokens.map(validateToken)
  return { ids: dedupeOrderPreserving(validated), requestedRawCount: validated.length }
}

// ---------------------------------------------------------------------------
// Phase 2 — post-read, pre-write reconciliation
// ---------------------------------------------------------------------------

/** Human-readable statement of the fixed predicate, for the not-loaded banner. */
export const PREDICATE_CLAUSES_BANNER =
  "quarantined = true AND repo_url ILIKE 'https://github.com/%' AND (quarantine_reason IS NULL OR quarantine_reason = 'stale')"

export interface IdReconciliation {
  /** Parsed ids after dedupe (phase 1 output), unchanged — "requested_unique" (design §11.2.3). */
  requested: string[]
  /** Count of validated tokens BEFORE dedupe — "requested_raw" (design §11.2.3). */
  requestedRawCount: number
  /** requested ∩ predicate — the ids `loadCandidates` actually returned rows for. */
  loaded: string[]
  /** requested \ loaded — skipped and reported, never force-processed. */
  notLoaded: string[]
  status: 'complete' | 'partial'
}

/**
 * Reconcile the requested id set against what `loadCandidates` actually
 * loaded (design §11.2.5). Two independent checks:
 *
 *  1. `loaded ⊆ requested` — structural, asserted in BOTH dry-run and apply
 *     mode. Intersection makes this true by construction, so a violation can
 *     only mean a chunking or filter-composition bug leaking an unrequested
 *     row into the write path; refusing converts that from a silent
 *     production write into a loud failure.
 *  2. Disposition of a non-empty `notLoaded` set — asymmetric by mode.
 *     Dry-run NEVER fails on it (dry-run is the discovery step). `--apply`
 *     throws HERE, before the caller's processing loop runs, so a divergence
 *     between what the operator asserted and what will be written can never
 *     pass unnoticed into a runbook checkbox. There is deliberately no
 *     override flag — the forward path for a benign divergence is pruning
 *     the id from the file.
 */
export function reconcileIdSelection(
  requestedIds: readonly string[],
  requestedRawCount: number,
  loadedRows: readonly { id: string }[],
  apply: boolean
): IdReconciliation {
  const requestedSet = new Set(requestedIds)
  const loadedIds = loadedRows.map((r) => r.id)

  const unrequested = loadedIds.filter((id) => !requestedSet.has(id))
  if (unrequested.length > 0) {
    throw new Error(
      `[revalidate-stale-quarantines] loadCandidates returned id(s) not present in the requested set: ${unrequested.join(
        ', '
      )} — refusing. This indicates a chunking or filter-composition bug, not a legitimate outcome (design §11.2.5's loaded ⊆ requested invariant).`
    )
  }

  const loadedSet = new Set(loadedIds)
  const notLoaded = requestedIds.filter((id) => !loadedSet.has(id))
  const status: 'complete' | 'partial' = notLoaded.length === 0 ? 'complete' : 'partial'

  if (apply && notLoaded.length > 0) {
    throw new Error(
      `[revalidate-stale-quarantines] --apply refused: ${notLoaded.length} requested id(s) did not match the fixed predicate (${PREDICATE_CLAUSES_BANNER}): ${notLoaded.join(
        ', '
      )}. No writes were made. Prune these ids from the file (recording why) and re-run, or investigate why they diverged — there is no override flag.`
    )
  }

  return { requested: [...requestedIds], requestedRawCount, loaded: loadedIds, notLoaded, status }
}

/** Format the id-selection summary + `not-loaded` section (design §11.2.5) for console output. */
export function formatIdSelectionReport(reconciliation: IdReconciliation): string {
  const lines: string[] = [
    `\nid-selection: requested_raw=${reconciliation.requestedRawCount} requested_unique=${reconciliation.requested.length} loaded=${reconciliation.loaded.length} not-loaded=${reconciliation.notLoaded.length} status=${reconciliation.status}`,
  ]
  if (reconciliation.notLoaded.length > 0) {
    lines.push(
      `\nnot-loaded — requested id(s) that did not match the fixed predicate (${PREDICATE_CLAUSES_BANNER}):`
    )
    for (const id of reconciliation.notLoaded) lines.push(`  - ${id}`)
  }
  return lines.join('\n') + '\n'
}

/**
 * Reconcile + print the id-selection report, if an id selection was given.
 * Wraps {@link reconcileIdSelection} + {@link formatIdSelectionReport} +
 * `console.log` in one call so the main file's `runSweep` doesn't need to
 * import either directly — keeps the id-selection/reconciliation logic
 * fully inside this sibling (design §11.2.8's line-budget split).
 */
export function reportIdSelectionIfPresent(
  ids: readonly string[] | undefined,
  requestedRawCount: number | undefined,
  loadedRows: readonly { id: string }[],
  apply: boolean
): void {
  if (ids === undefined) return
  const reconciliation = reconcileIdSelection(
    ids,
    requestedRawCount ?? ids.length,
    loadedRows,
    apply
  )
  console.log(formatIdSelectionReport(reconciliation))
}
