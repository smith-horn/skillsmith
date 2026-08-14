/**
 * Core per-row control-flow helpers for smi5879-simulate-full.ts: the
 * retry-wrapped fetch adapters, verdict extraction, and tier-1/tier-2 outcome
 * classification (`processRow`). Coverage aggregation, checkpoint I/O, and
 * the tier-3 sweep loop live in the sibling `smi5879-simulate-full.sweep.ts`
 * (split for CLAUDE.md's <500-line-per-file convention).
 * @module scripts/indexer/smi5879-simulate-full.helpers
 *
 * Plan: docs/internal/implementation/smi-5879-wave3-census-simulation-plan.md §3a/§3b
 * Design: docs/internal/implementation/smi-5879-edge-twin-parity-design.md §8.2.3
 */

import { shouldQuarantine, generateContentHash } from './_shared/security-scanner-edge.ts'
import { parseSkillMdUrl, fetchSkillMd, type ParsedSkillUrl } from './_shared/skill-md-fetch.ts'
import { fetchSiblingContent, type ScanSkillBundleResult } from './skill-processor.security.ts'
import { runCancellablePool, type RateLimitTelemetry } from './_shared/rate-limit.ts'
import { GitHubAuthError } from './_shared/github-auth.ts'
import { withFetchRetry, type FetchRetryOptions } from './smi5879-fetch-retry.ts'
import { resolveTokenSource } from './backfill-checkpoint.ts'
import type {
  BranchMap,
  ScanSkillBundleFn,
  SimRowOutcome,
  SimRowResult,
  SimSnapshotRow,
  TokenSource,
} from './smi5879-simulate-full.types.ts'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const HEARTBEAT_INTERVAL_MS = 60_000
/** Bounded concurrency + batch size for the main pass, matching revalidate-stale-quarantines.ts's polite BATCH. */
export const PROCESS_CONCURRENCY = 5
export const CHECKPOINT_BATCH_SIZE = 25

/**
 * Hard-refuses (throws) when `token_source` resolves to `'app'` — plan §3a.
 * Shared by BOTH `smi5879-simulate-full.ts` and
 * `smi5879-simulate-preflight-estimate.ts` (plan §3c: "Both tools share...
 * a token_source field — hard-refuses to start on 'app'"), so it lives here
 * rather than in either CLI file.
 */
export function assertPatTokenSource(env: NodeJS.ProcessEnv = process.env): TokenSource {
  const source = resolveTokenSource(env)
  if (source === 'app') {
    throw new Error(
      'SMI-5879: token_source resolved to "app" — the simulator MUST authenticate via PAT, ' +
        'never the GitHub App (plan §3a: a multi-day unattended batch on the App installation ' +
        'would compete with the 00:00/03:00 indexer crons for the same core bucket). Unset ' +
        'GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, and GITHUB_APP_PRIVATE_KEY for this run.'
    )
  }
  return source
}

const DEFAULT_FETCH_RETRY_OPTIONS: FetchRetryOptions = {}

/**
 * SMI-6015: thrown by `retryPrimaryFetch` on an HTTP 401 — a credential-level
 * failure, not a per-row condition. `_shared/skill-md-fetch.ts`'s
 * `fetchSkillMd` is a SHARED primitive (also used by
 * `dequarantine-false-positives.ts`, `stale-reconciliation.ts`, and
 * `revalidate-stale-quarantines.ts`, each with its own fail-open/fail-closed
 * semantics for a `transient` result) — deliberately NOT changed to throw on
 * 401 itself, which would alter behavior for all of those unrelated callers.
 * Instead this simulator-local adapter inspects `fetchSkillMd`'s already-
 * classified `{kind:'transient', status:401}` result and escalates ONLY
 * here, where a multi-day unattended run makes silently burning retries (and
 * ultimately classifying every subsequent row `unevaluable`) on a dead token
 * far more costly than in any of `fetchSkillMd`'s other callers.
 * `withFetchRetry` only retries a `RateLimitError`
 * (`smi5879-fetch-retry.ts:106-115`) — any other thrown error, including
 * this one, propagates immediately without consuming retry budget.
 */
export class PrimaryFetchAuthError extends GitHubAuthError {
  constructor(
    public readonly owner: string,
    public readonly repo: string
  ) {
    super(
      `SMI-5879/SMI-6015: GitHub returned 401 (Unauthorized) fetching SKILL.md for ${owner}/${repo} ` +
        '— credential-level failure. Aborting the simulation run rather than classifying this (and ' +
        "every subsequent row hitting the same dead token) as 'unevaluable'."
    )
    this.name = 'PrimaryFetchAuthError'
  }
}

// ---------------------------------------------------------------------------
// Retry-wrapped fetch adapters
// ---------------------------------------------------------------------------

/**
 * Adapt `fetchSkillMd`'s `{kind:'content'|'not-found'|'transient'}` shape to
 * `RetryableFetchResult` (`{content}|{removed:true}|null`) so the SAME
 * tier-1 wrapper drives both the primary and sibling fetch paths. `retries=0`
 * is passed to `fetchSkillMd` itself — `withFetchRetry` owns ALL retry
 * decisions uniformly; letting `fetchSkillMd`'s own internal retry loop also
 * fire would double-apply backoff with two independent schedules.
 *
 * `getHeaders` (SMI-6015) is invoked FRESH on every attempt, not once for
 * the whole (potentially multi-day) run — see `runSimulateFull`'s own
 * `getHeaders` callback and `_shared/github-auth.ts`'s `getInstallationToken()`
 * caching, which makes this ~free when the token is still fresh.
 */
export async function retryPrimaryFetch(
  parsed: ParsedSkillUrl,
  getHeaders: () => Promise<Record<string, string>>,
  options: FetchRetryOptions = DEFAULT_FETCH_RETRY_OPTIONS
): Promise<ReturnType<typeof withFetchRetry>> {
  let lastStatus: number | null = null
  return withFetchRetry(
    async () => {
      const headers = await getHeaders()
      const result = await fetchSkillMd(parsed, headers, 0)
      if (result.kind === 'content') return { content: result.content }
      if (result.kind === 'not-found') return { removed: true }
      if (result.status === 401) {
        throw new PrimaryFetchAuthError(parsed.owner, parsed.repo)
      }
      lastStatus = result.status
      return null
    },
    { ...options, captureStatus: () => lastStatus ?? undefined }
  )
}

/**
 * Build a per-row, per-relPath-cached sibling fetcher. Both the post-port and
 * pre-port `scanSkillBundle` calls share this SAME instance (passed as
 * `deps.fetchSiblingContent`), so each sibling is physically fetched (with
 * tier-1 retry) at most ONCE per row regardless of which scan triggers it
 * first — production `scanSkillBundle`'s own fail-open `null` handling then
 * runs identically for both scans, exactly matching what a single production
 * call would observe.
 */
export function makeCachingSiblingFetcher(
  options: FetchRetryOptions = DEFAULT_FETCH_RETRY_OPTIONS
): {
  fetchSiblingContent: (
    owner: string,
    repo: string,
    branch: string,
    relPath: string,
    telemetry: RateLimitTelemetry
  ) => Promise<{ content: string } | { removed: true } | null>
  getExhausted: () => { relPath: string; lastStatus: number | null }[]
} {
  const cache = new Map<string, { content: string } | { removed: true } | null>()
  const exhausted: { relPath: string; lastStatus: number | null }[] = []

  const cachingFetch = async (
    owner: string,
    repo: string,
    branch: string,
    relPath: string,
    tel: RateLimitTelemetry
  ): Promise<{ content: string } | { removed: true } | null> => {
    if (cache.has(relPath)) return cache.get(relPath) ?? null
    const outcome = await withFetchRetry(
      () => fetchSiblingContent(owner, repo, branch, relPath, tel),
      options
    )
    let result: { content: string } | { removed: true } | null
    if ('exhausted' in outcome) {
      exhausted.push({ relPath, lastStatus: outcome.lastStatus })
      result = null
    } else {
      result = outcome
    }
    cache.set(relPath, result)
    return result
  }

  return { fetchSiblingContent: cachingFetch, getExhausted: () => exhausted }
}

// ---------------------------------------------------------------------------
// Verdict extraction + tier-2 classification
// ---------------------------------------------------------------------------

/**
 * Canonical "effective verdict" derivation — matches skill-processor.ts's own
 * `mergedScan ? mergedScan.quarantine : securityScan ? shouldQuarantine(securityScan) : false`
 * (skill-processor.ts:398-402), so the simulator's comparison basis is
 * identical to what production actually decides on.
 */
export function effectiveVerdict(result: ScanSkillBundleResult): {
  quarantine: boolean
  riskScore: number
} {
  if (result.mergedSecurityScan) {
    return {
      quarantine: result.mergedSecurityScan.quarantine,
      riskScore: result.mergedSecurityScan.riskScore,
    }
  }
  return {
    quarantine: shouldQuarantine(result.securityScan),
    riskScore: result.securityScan.riskScore,
  }
}

/** Verdict-delta classification (one of the four non-terminal outcomes). */
export function classifyVerdictDelta(prePort: boolean, postPort: boolean): SimRowOutcome {
  if (!prePort && postPort) return 'newly_quarantined'
  if (prePort && !postPort) return 'newly_cleared'
  if (!prePort && !postPort) return 'unchanged_clean'
  return 'unchanged_quarantined'
}

/**
 * True iff every sibling target 404'd (bundle scope confirmed empty) — checked
 * against the post-port scan's `siblingFailures`, which is identical to the
 * pre-port scan's by construction (both share the same caching fetcher).
 */
export function isBundleAbsent(result: ScanSkillBundleResult): boolean {
  return (
    result.siblingScans.length === 0 &&
    result.siblingFailures.length > 0 &&
    result.siblingFailures.every((f) => f.kind === 'removed')
  )
}

export interface ProcessRowDeps {
  scanPostPort: ScanSkillBundleFn
  scanPrePort: ScanSkillBundleFn
  telemetry: RateLimitTelemetry
  /** SMI-6015: a callback, not a frozen headers object — see `retryPrimaryFetch`'s doc comment. */
  getHeaders: () => Promise<Record<string, string>>
  fetchRetryOptions?: FetchRetryOptions
}

/**
 * Process one row end-to-end: parse -> resolve branch -> fetch primary
 * (tier-1) -> content-drift check -> dual-scan (shared cached sibling
 * fetcher) -> tier-2 classification. Never throws for a data-shaped
 * condition (parse/fetch/drift/exhaustion failures all resolve to a terminal
 * `SimRowResult`); throws ONLY for the "simulator bug" case the design doc
 * calls out explicitly (a fetching generation with a missing
 * `smi5879_repo_branch` row — I-5 should have caught this at census time).
 */
export async function processRow(
  row: SimSnapshotRow,
  branchMap: BranchMap,
  deps: ProcessRowDeps
): Promise<SimRowResult> {
  const base = { id: row.id, cohort: row.cohort, author: row.author, name: row.name }
  const retryOptions = deps.fetchRetryOptions ?? DEFAULT_FETCH_RETRY_OPTIONS

  const parsed = parseSkillMdUrl(row.repo_url, row.skill_path)
  if (!parsed) {
    return {
      ...base,
      outcome: 'unfetchable',
      reason: `repo_url did not parse to a fetchable target (repo_url=${row.repo_url ?? '(null)'})`,
    }
  }

  let branch: string
  if (parsed.ref) {
    branch = parsed.ref
  } else {
    const info = branchMap.get(`${parsed.owner}/${parsed.repo}`)
    if (!info) {
      throw new Error(
        `SMI-5879 simulator bug: no smi5879_repo_branch row for ${parsed.owner}/${parsed.repo} ` +
          `(row id=${row.id}) — I-5 branch coverage should have refused the census before this ` +
          `generation could be sealed. Never silently falls back to 'main'.`
      )
    }
    if (info.resolution === 'not-found' || info.resolution === 'unparseable') {
      return {
        ...base,
        outcome: 'unfetchable',
        reason: `default_branch resolution=${info.resolution}`,
      }
    }
    if (info.resolution === 'transient') {
      return { ...base, outcome: 'unevaluable', reason: 'default_branch resolution=transient' }
    }
    branch = info.default_branch as string // resolution === 'resolved' — default_branch is NOT NULL (CHECK constraint)
  }

  const primaryOutcome = await retryPrimaryFetch(parsed, deps.getHeaders, retryOptions)
  if ('exhausted' in primaryOutcome) {
    return {
      ...base,
      outcome: 'unevaluable',
      reason: `primary fetch exhausted retries (lastStatus=${primaryOutcome.lastStatus ?? 'unknown'})`,
    }
  }
  if ('removed' in primaryOutcome) {
    // JUDGMENT CALL (documented in the implementation report): a primary
    // SKILL.md 404 has no dedicated bucket in the plan's closed vocabulary —
    // `unfetchable` is reserved for structurally-undecidable ROW SHAPES
    // determined without any network attempt; `bundle_absent` requires
    // "primary OK". Routed to `unevaluable` (the conservative, G-2-blocking
    // choice) because the post-port verdict is categorically unknowable with
    // no primary content to score, matching unevaluable's own definition.
    return {
      ...base,
      outcome: 'unevaluable',
      reason: 'primary SKILL.md confirmed absent (404) since the generation was sealed',
    }
  }
  const primaryContent = primaryOutcome.content

  if (row.content_hash) {
    const hash = await generateContentHash(primaryContent)
    if (hash !== row.content_hash) {
      return {
        ...base,
        outcome: 'content_drifted',
        reason: `content hash mismatch (snapshot=${row.content_hash}, fetched=${hash})`,
      }
    }
  }
  // row.content_hash === null (C2, never scanned before the snapshot): no
  // baseline to drift-check against — proceed to scan directly.

  const { fetchSiblingContent: cachingFetch, getExhausted } =
    makeCachingSiblingFetcher(retryOptions)

  const postPortResult = await deps.scanPostPort(
    parsed.owner,
    parsed.repo,
    branch,
    parsed.dir || undefined,
    primaryContent,
    deps.telemetry,
    { fetchSiblingContent: cachingFetch }
  )
  const prePortResult = await deps.scanPrePort(
    parsed.owner,
    parsed.repo,
    branch,
    parsed.dir || undefined,
    primaryContent,
    deps.telemetry,
    { fetchSiblingContent: cachingFetch }
  )

  const exhausted = getExhausted()
  if (exhausted.length > 0) {
    return {
      ...base,
      outcome: 'unevaluable',
      reason: `${exhausted.length} sibling(s) exhausted retries: ${exhausted.map((e) => e.relPath).join(', ')}`,
    }
  }

  const preVerdict = effectiveVerdict(prePortResult)
  const postVerdict = effectiveVerdict(postPortResult)

  if (isBundleAbsent(postPortResult)) {
    return {
      ...base,
      outcome: 'bundle_absent',
      reason: 'primary OK, all sibling targets confirmed 404 — bundle scope confirmed empty',
      prePortQuarantine: preVerdict.quarantine,
      postPortQuarantine: postVerdict.quarantine,
      prePortRiskScore: preVerdict.riskScore,
      postPortRiskScore: postVerdict.riskScore,
    }
  }

  return {
    ...base,
    outcome: classifyVerdictDelta(preVerdict.quarantine, postVerdict.quarantine),
    prePortQuarantine: preVerdict.quarantine,
    postPortQuarantine: postVerdict.quarantine,
    prePortRiskScore: preVerdict.riskScore,
    postPortRiskScore: postVerdict.riskScore,
  }
}

// ---------------------------------------------------------------------------
// Main pass (moved from smi5879-simulate-full.ts — 500-line budget)
// ---------------------------------------------------------------------------

/**
 * Run the main pass over every not-yet-attempted row (from the checkpoint, if
 * resuming), in concurrency-bounded batches, checkpointing after each batch.
 *
 * SMI-6015 (GPT-5.6-Sol review, 2026-08-14): uses `runCancellablePool`, not
 * the plain `pMapBounded` this originally shipped with — `pMapBounded` has no
 * shared cancellation check between its concurrent workers, so a
 * `PrimaryFetchAuthError` thrown by one worker rejects the outer await while
 * sibling workers already in flight keep fetching from GitHub in the
 * background regardless, silently defeating the point of aborting on a dead
 * credential. `runCancellablePool`'s workers check a shared abort flag both
 * before AND after each item, so an abort actually stops new work; whatever
 * partial progress a batch made before the abort is checkpointed via
 * `onBatchDone` BEFORE rethrowing (durable partial write, never data loss).
 */
export async function runMainPass(
  rows: SimSnapshotRow[],
  alreadyResults: Map<string, SimRowResult>,
  branchMap: BranchMap,
  scanDeps: {
    scanPostPort: ScanSkillBundleFn
    scanPrePort: ScanSkillBundleFn
    telemetry: RateLimitTelemetry
    // SMI-6015: a callback, not a frozen headers object — see ProcessRowDeps's
    // doc comment above. This run is multi-day; a token built once at startup
    // would go stale after GitHub's 1h App-token expiry, same root cause as
    // the census's own frozen-header bug.
    getHeaders: () => Promise<Record<string, string>>
  },
  onBatchDone: (results: Map<string, SimRowResult>) => Promise<void>
): Promise<void> {
  const pending = rows.filter((r) => !alreadyResults.has(r.id))
  for (let i = 0; i < pending.length; i += CHECKPOINT_BATCH_SIZE) {
    const batch = pending.slice(i, i + CHECKPOINT_BATCH_SIZE)
    const outcomes: SimRowResult[] = []
    const { abortedBy } = await runCancellablePool(
      batch,
      (row) => processRow(row, branchMap, scanDeps),
      (outcome) => {
        outcomes.push(outcome)
      },
      PROCESS_CONCURRENCY
    )
    for (const outcome of outcomes) alreadyResults.set(outcome.id, outcome)
    await onBatchDone(alreadyResults)
    if (abortedBy) throw abortedBy
  }
}
