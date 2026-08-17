/**
 * SMI-6033 Wave 2 (Gap 8): extended scan-surface helpers for the Node indexer.
 *
 * Before this wave the indexer only ever read `SKILL.md` plus the 7 fixed
 * sibling filenames in `BUNDLED_SCAN_FILES` — it never opened `scripts/`,
 * `src/` or `bin/`, so a backdoor buried mid-function in otherwise-working
 * operational code (the ClawHavoc `better-polymarket` shape) was structurally
 * invisible to the scanner. This module adds the three pieces that close that:
 *
 *   1. `fetchRepoTreeEntries` — a budgeted, run-memoized wrapper over
 *      `fetchFullRepoTree` (trees-search.ts), giving the caller the repo's full
 *      blob list so file selection can happen without a fetch-per-guess.
 *   2. `enumerateExtendedSiblingTargets` — deterministic, prioritized, capped
 *      selection of executable-code files from that blob list.
 *   3. `computeScanCoverage` — the fail-open cause accounting, so a partially
 *      scanned skill is never silently recorded as fully scanned.
 *
 * Split out of `skill-processor.security.ts` (which was at 432/500 lines) to
 * stay under the repo's file-length gate, following the same small-sibling
 * extraction precedent as `security-scanner-edge.{compound,exec}.ts`.
 *
 * Parity with supabase/functions/indexer/skill-processor.security.tree.ts is
 * enforced by parity.test.ts.
 *
 * SHARED-STATE NOTE (per the plan's own Shared-State Audit): the memo map and
 * the budget counter below are module-level mutable state, deliberately. They
 * are RUN-scoped, not persisted and not shared across workers — the indexer
 * process is a single event loop and each batch run is a fresh process, so
 * there is no cross-run staleness class of bug here. `resetRepoTreeFetchState`
 * exists so tests (and any future long-lived host) can restore the initial
 * state explicitly rather than relying on module reload.
 */

import { fetchFullRepoTree, type TreeEntry } from './trees-search.ts'
import type { RateLimitTelemetry } from './_shared/rate-limit.ts'

/**
 * Extensions treated as operational code worth scanning. Deliberately a
 * closed list of interpreted/scripted formats an agent can be told to run —
 * not "every file", which would blow the fetch budget on assets and
 * lockfiles for no detection value.
 */
export const EXECUTABLE_CODE_EXTENSIONS = [
  '.sh',
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.rb',
  '.php',
  '.ps1',
  '.pl',
] as const

/** Directories searched for operational code, relative to the skill directory. */
export const EXTENDED_SCAN_DIRS = ['scripts', 'src', 'bin'] as const

/**
 * Max extended (non-fixed) files fetched+scanned per skill.
 *
 * COUNT-CAP DECOY-PADDING (known, surfaced residual — same shape already
 * documented in packages/core/src/services/bundled-sibling-scan.ts's header):
 * ranking then capping does NOT defeat decoy-padding outright. It does raise
 * the bar — to land past the cap an attacker must ALSO avoid referencing the
 * payload from SKILL.md and avoid entry-point naming, which cuts against the
 * payload actually being executed. Anything past the cap is reported in
 * `droppedForCount` and drives `scan_coverage_incomplete`; it is never a
 * silent drop.
 */
export const MAX_EXTENDED_SIBLING_FILES = 20

/** Basenames (extension-stripped, lowercased) that rank as entry points (tier 2). */
export const ENTRY_POINT_BASENAMES = new Set([
  'install',
  'setup',
  'main',
  'index',
  'run',
  'postinstall',
])

/**
 * Default per-run Trees API budget. Override with
 * `SKILLSMITH_MAX_TREE_FETCHES_PER_RUN`.
 *
 * Cost envelope: a discovery run pays at most `MAX_REPOS` extra metered calls
 * (<=100 default, <=500 backfill) against the GitHub App's 5,000/hr core
 * quota; maintenance/recheck runs pay only for skills that pass the existing
 * `repo_updated_at` skip-gate, so the cost is proportional to churn rather
 * than to corpus size.
 */
export const DEFAULT_MAX_TREE_FETCHES_PER_RUN = 300

/**
 * Outcome of a budgeted repo-tree fetch.
 *
 * `entries: null` means "no tree available" for either reason the caller must
 * distinguish downstream: the fetch failed (`fetchFailed`) or the per-run
 * budget was already spent (`budgetExhausted`). Both are fail-OPEN — the skill
 * is still scanned with the 7 fixed files — and both are surfaced through
 * `computeScanCoverage` so the persisted record says so.
 */
export interface RepoTreeFetchResult {
  entries: TreeEntry[] | null
  truncated: boolean
  fetchFailed: boolean
  budgetExhausted: boolean
}

/** Run-scoped memo: one Trees API call per `(owner, repo, branch)` per run. */
const repoTreeCache = new Map<string, Promise<RepoTreeFetchResult>>()

/** Run-scoped count of Trees API calls actually issued by this module. */
let repoTreeFetchCount = 0

/**
 * Resolve the per-run budget. Read per call (not captured at module load) so a
 * test or operator can change it without reloading the module. A missing,
 * non-numeric or negative value falls back to the default rather than
 * silently disabling the extended scan.
 */
export function resolveMaxTreeFetchesPerRun(): number {
  const raw = process.env.SKILLSMITH_MAX_TREE_FETCHES_PER_RUN
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_TREE_FETCHES_PER_RUN
}

/** Trees API calls issued so far this run (observability + audit-log meta). */
export function getRepoTreeFetchCount(): number {
  return repoTreeFetchCount
}

/** Clear the run-scoped memo and budget counter. Tests and run boundaries only. */
export function resetRepoTreeFetchState(): void {
  repoTreeCache.clear()
  repoTreeFetchCount = 0
}

/**
 * Budgeted, run-memoized full-tree fetch.
 *
 * Two things this adds over `fetchFullRepoTree` itself:
 *
 *   - MEMOIZATION per `(owner, repo, branch)`. Many high-trust authors host
 *     several skills in one repo; without this the same tree would be fetched
 *     once per skill. The memo stores the in-flight PROMISE, and nothing is
 *     awaited between the cache miss and the `set`, so concurrent callers for
 *     the same repo share one call rather than racing to issue two.
 *   - BUDGET. `MAX_TREE_FETCHES_PER_RUN` bounds the metered `api.github.com`
 *     cost of this feature. Only NEW repos consume budget; a memo hit is free.
 *
 * Failures are memoized too, deliberately: without that, N skills in one
 * broken/private repo would each burn a budget slot and a real API call to
 * rediscover the same failure.
 */
export async function fetchRepoTreeEntries(
  owner: string,
  repo: string,
  branch: string,
  telemetry: RateLimitTelemetry
): Promise<RepoTreeFetchResult> {
  const key = `${owner}/${repo}/${branch}`
  const memoized = repoTreeCache.get(key)
  if (memoized !== undefined) return memoized

  if (repoTreeFetchCount >= resolveMaxTreeFetchesPerRun()) {
    // Deliberately NOT memoized: budget exhaustion is a property of the run,
    // not of this repo, and caching it would pin the repo to "exhausted" even
    // if the budget were raised mid-run.
    return { entries: null, truncated: false, fetchFailed: false, budgetExhausted: true }
  }

  repoTreeFetchCount++
  const pending = fetchFullRepoTree(owner, repo, branch, telemetry).then(
    (result): RepoTreeFetchResult => ({
      entries: result.fetchFailed ? null : result.entries,
      truncated: result.truncated,
      fetchFailed: result.fetchFailed,
      budgetExhausted: false,
    })
  )
  repoTreeCache.set(key, pending)
  return pending
}

/** Selection outcome for one skill's extended (operational-code) scan targets. */
export interface ExtendedSiblingTargets {
  /** Repo-relative paths to fetch+scan, in ranked order (already capped). */
  targets: string[]
  /** Ranked-but-past-the-cap paths. Surfaced, never silently dropped. */
  droppedForCount: string[]
  /** Paths skipped on the tree's own `size` field, before any fetch. */
  droppedForSize: string[]
}

/** One ranking candidate: the path plus its precomputed, tier-ordered sort keys. */
interface RankedCandidate {
  path: string
  /** Tier 1: the path is referenced literally in SKILL.md. */
  referenced: boolean
  /** Tier 2: entry-point/manifest basename. */
  entryPoint: boolean
  /** Tier 3: path depth (fewer segments first). */
  depth: number
}

/** True when `path`'s final extension is in {@link EXECUTABLE_CODE_EXTENSIONS}. */
function hasExecutableCodeExtension(path: string): boolean {
  const lower = path.toLowerCase()
  return (EXECUTABLE_CODE_EXTENSIONS as readonly string[]).some((ext) => lower.endsWith(ext))
}

/** Lowercased basename with its final extension removed (`Setup.SH` -> `setup`). */
function entryPointKey(path: string): string {
  const base = (path.split('/').pop() ?? path).toLowerCase()
  const dotIdx = base.lastIndexOf('.')
  return dotIdx > 0 ? base.slice(0, dotIdx) : base
}

/**
 * Select the operational-code files to scan for one skill, from the repo's
 * full tree.
 *
 * SCOPE: top-level files of the skill directory, plus DIRECT children of its
 * `scripts/`, `src/` and `bin/` subdirectories. Deliberately shallow — the
 * same depth `bundled-sibling-scan.ts`'s local `.sh` glob already uses, so
 * the registry path and the local `skill_rescan` path cover the same shape.
 * A full recursive walk is out of scope for this wave (it multiplies the
 * fetch budget without a corresponding rise in payload likelihood).
 *
 * RANKING (four tiers, applied in order):
 *   1. referenced literally in SKILL.md
 *   2. entry-point basename (install/setup/main/index/run/postinstall)
 *   3. shallower path first
 *   4. lexicographic
 *
 * DETERMINISM is a required property, not an incidental one (the plan's Wave 2
 * gate pins it with a 25-candidate fixture): the same tree must always yield
 * the same 20 targets in the same order. Three things make that structural
 * rather than accidental — the comparator's final tier is a TOTAL order over
 * unique tree paths (so the result never depends on `Array.prototype.sort`
 * being stable), the lexicographic compare uses raw `<`/`>` rather than
 * `localeCompare` (whose collation is ICU/locale dependent and can differ
 * between Node and Deno), and nothing here reads iteration order of any
 * attacker-influenced `Set`/object.
 *
 * @param skillDir      skill directory, repo-relative ('' for a root skill)
 * @param treeEntries   full repo blob list, or null when unavailable
 * @param primaryContent SKILL.md text, for the tier-1 reference check
 * @param maxFileBytes  per-file byte ceiling, checked against the tree's own
 *   `size` so oversized files are dropped BEFORE any fetch is attempted
 */
export function enumerateExtendedSiblingTargets(
  skillDir: string,
  treeEntries: TreeEntry[] | null,
  primaryContent: string,
  maxFileBytes: number
): ExtendedSiblingTargets {
  if (treeEntries === null) {
    return { targets: [], droppedForCount: [], droppedForSize: [] }
  }

  const prefix = skillDir ? `${skillDir}/` : ''
  const scanDirs = EXTENDED_SCAN_DIRS as readonly string[]
  const droppedForSize: string[] = []
  const candidates: RankedCandidate[] = []
  const seen = new Set<string>()

  for (const entry of treeEntries) {
    if (entry.type !== 'blob') continue
    if (prefix !== '' && !entry.path.startsWith(prefix)) continue

    const rel = entry.path.slice(prefix.length)
    if (rel === '') continue

    const slashIdx = rel.indexOf('/')
    if (slashIdx >= 0) {
      // Only DIRECT children of the three scan dirs — no deeper nesting.
      if (!scanDirs.includes(rel.slice(0, slashIdx))) continue
      if (rel.indexOf('/', slashIdx + 1) >= 0) continue
    }

    if (!hasExecutableCodeExtension(rel)) continue
    if (seen.has(entry.path)) continue
    seen.add(entry.path)

    // Size pre-filter: the tree already told us how big this blob is, so an
    // oversized file costs zero fetches to exclude. A missing `size` (GitHub
    // omits it for some entry kinds) is treated as in-range — the post-fetch
    // Content-Length / streamed byte cap in fetchSiblingContent still applies.
    if (typeof entry.size === 'number' && entry.size > maxFileBytes) {
      droppedForSize.push(entry.path)
      continue
    }

    candidates.push({
      path: entry.path,
      referenced: primaryContent.includes(rel),
      entryPoint: ENTRY_POINT_BASENAMES.has(entryPointKey(rel)),
      depth: rel.split('/').length,
    })
  }

  candidates.sort(compareRankedCandidates)

  return {
    targets: candidates.slice(0, MAX_EXTENDED_SIBLING_FILES).map((c) => c.path),
    droppedForCount: candidates.slice(MAX_EXTENDED_SIBLING_FILES).map((c) => c.path),
    droppedForSize,
  }
}

/** The four-tier comparator described on {@link enumerateExtendedSiblingTargets}. */
function compareRankedCandidates(a: RankedCandidate, b: RankedCandidate): number {
  if (a.referenced !== b.referenced) return a.referenced ? -1 : 1
  if (a.entryPoint !== b.entryPoint) return a.entryPoint ? -1 : 1
  if (a.depth !== b.depth) return a.depth - b.depth
  if (a.path === b.path) return 0
  return a.path < b.path ? -1 : 1
}

/**
 * Every reason one skill's scan can be less than complete.
 *
 * A clean 404 (`SiblingFailure.kind === 'removed'`) is deliberately NOT a
 * cause: a file confirmed absent from the repo is complete coverage of a
 * smaller surface, not incomplete coverage.
 */
export type ScanCoverageCause =
  | 'count_cap'
  | 'size_cap'
  | 'sibling_fetch_transient'
  | 'tree_fetch_failed'
  | 'tree_truncated'
  | 'tree_budget_exhausted'

/**
 * The union's declared order. `computeScanCoverage` emits causes in THIS
 * order, never in detection order, so the persisted note is a stable string
 * for a given set of causes.
 */
export const SCAN_COVERAGE_CAUSE_ORDER = [
  'count_cap',
  'size_cap',
  'sibling_fetch_transient',
  'tree_fetch_failed',
  'tree_truncated',
  'tree_budget_exhausted',
] as const satisfies readonly ScanCoverageCause[]

/**
 * Wire format for each cause in `scan_coverage_note`.
 *
 * Values are token-identical to the cause names on purpose: the note column is
 * a machine-readable, greppable token list (the plan pins
 * `scan_coverage_note = 'tree_budget_exhausted'` literally), and the
 * human-facing phrasing — "partial scan — N files not analyzed" — is built at
 * the API layer from these tokens, not stored. The map exists so the wire
 * format is declared in one place and can change without touching the type.
 */
export const SCAN_COVERAGE_CAUSE_LABELS: Record<ScanCoverageCause, string> = {
  count_cap: 'count_cap',
  size_cap: 'size_cap',
  sibling_fetch_transient: 'sibling_fetch_transient',
  tree_fetch_failed: 'tree_fetch_failed',
  tree_truncated: 'tree_truncated',
  tree_budget_exhausted: 'tree_budget_exhausted',
}

/** Observed signals from one `scanSkillBundle` run. */
export interface ScanCoverageSignals {
  droppedForCount: readonly string[]
  droppedForSize: readonly string[]
  /** True when at least one sibling fetch failed transiently (429/network/oversize). */
  hasTransientSiblingFailure: boolean
  treeFetchFailed: boolean
  treeTruncated: boolean
  treeBudgetExhausted: boolean
}

/** The persisted coverage verdict for one skill. */
export interface ScanCoverage {
  incomplete: boolean
  /** `'; '`-joined cause tokens in {@link SCAN_COVERAGE_CAUSE_ORDER}, or null. */
  note: string | null
}

/**
 * Pure fold from observed signals to the persisted coverage verdict. No I/O,
 * no clock, no randomness — same signals always produce the same note.
 */
export function computeScanCoverage(signals: ScanCoverageSignals): ScanCoverage {
  const fired: Record<ScanCoverageCause, boolean> = {
    count_cap: signals.droppedForCount.length > 0,
    size_cap: signals.droppedForSize.length > 0,
    sibling_fetch_transient: signals.hasTransientSiblingFailure,
    tree_fetch_failed: signals.treeFetchFailed,
    tree_truncated: signals.treeTruncated,
    tree_budget_exhausted: signals.treeBudgetExhausted,
  }

  const causes = SCAN_COVERAGE_CAUSE_ORDER.filter((cause) => fired[cause])
  if (causes.length === 0) return { incomplete: false, note: null }
  return {
    incomplete: true,
    note: causes.map((cause) => SCAN_COVERAGE_CAUSE_LABELS[cause]).join('; '),
  }
}
