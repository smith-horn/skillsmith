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
import type { RateLimitTelemetry } from './_shared/rate-limit.ts'
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
 */
export async function retryPrimaryFetch(
  parsed: ParsedSkillUrl,
  headers: Record<string, string>,
  options: FetchRetryOptions = DEFAULT_FETCH_RETRY_OPTIONS
): Promise<ReturnType<typeof withFetchRetry>> {
  let lastStatus: number | null = null
  return withFetchRetry(
    async () => {
      const result = await fetchSkillMd(parsed, headers, 0)
      if (result.kind === 'content') return { content: result.content }
      if (result.kind === 'not-found') return { removed: true }
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
  headers: Record<string, string>
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

  const primaryOutcome = await retryPrimaryFetch(parsed, deps.headers, retryOptions)
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
