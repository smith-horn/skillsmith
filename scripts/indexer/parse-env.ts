/**
 * Environment parsing for the Node indexer entrypoint
 * @module scripts/indexer/parse-env
 *
 * SMI-4852: Pure function — testable in isolation. Decisions:
 *   - `CONCURRENCY_KILL_SWITCH=1` forces concurrency=1 regardless of
 *     `CONCURRENCY` (or D-3 default of 2). Hard Rule 1 (retro 2026-05-10).
 *   - Required vars throw at parse time so the entrypoint fails fast.
 *   - All numeric vars default cleanly if absent.
 */

// SMI-4870: reuse the canonical DiscoveryPhase type from the orchestrator so
// the interface and the runDiscovery call site share one source of truth.
import type { DiscoveryPhase } from './discovery-orchestrator.phase-split.ts'

export interface IndexerEnv {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  CRON_SLOT: number | null
  MAX_PAGES: number
  MAX_REPOS: number
  CODE_SEARCH_MAX_PAGES: number
  DRY_RUN: boolean
  RUN_TYPE: 'discovery' | 'maintenance' | 'recheck'
  STALE_DAYS: number
  RECHECK_THRESHOLD_DAYS: number
  RECHECK_MAX_CANDIDATES: number
  RECHECK_BATCH: number
  RECHECK_DRY_RUN: boolean
  concurrency: number
  kill_switch_engaged: boolean
  /** SMI-4870: per-phase cron sub-slot (1/2/3); undefined = legacy all-phases path. */
  DISCOVERY_PHASE: DiscoveryPhase | undefined
  /**
   * SMI-5286 Wave 1b (§#2): out-of-band backfill mode. When true the discovery
   * run drops the 7-day freshness window (un-windowed scan) and skips the
   * Phase-6 stale sweep so a partial crawl can't quarantine real skills. Bare
   * name (no prefix) per the parse-env convention.
   */
  BACKFILL_MODE: boolean
  /**
   * SMI-5286 1c (C-5): when set, the backfill facet crawl is restricted to this
   * single `path:` prefix (the one-ecosystem DRY_RUN / targeted-recovery mode).
   * Empty/unset → the broad `filename:SKILL.md` query (subsumes root + subdirs).
   */
  BACKFILL_PATH_PREFIX: string | undefined
  /**
   * SMI-5286 1c: per-dispatch budget — the facet driver stops after this many
   * size (sub)ranges so a dispatch fits inside the GHA cap, writes a checkpoint,
   * and the operator re-dispatches with `resume_from=latest`.
   */
  BACKFILL_MAX_RANGES: number
  /**
   * SMI-5319 W4: minimum file size (bytes) for the backfill crawl's FRESH START.
   * When > 0, the facet driver begins at the first facet whose `hi >=
   * BACKFILL_MIN_SIZE_BYTES` instead of facet 0, skipping the low-byte noise band
   * (0-1023B facets are GitHub-tokenized stubs that admit zero real skills).
   * Default 0 = all facets. Only applied on a fresh start — RESUMES carry their
   * own facet_index from the checkpoint cursor and are unaffected.
   */
  BACKFILL_MIN_SIZE_BYTES: number
}

function getRequired(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required environment variable: ${name}`)
  return v
}

function getInt(name: string, defaultValue: number): number {
  const raw = process.env[name]
  if (raw == null || raw === '') return defaultValue
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer for ${name}: ${raw}`)
  }
  return parsed
}

function getBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]
  if (raw == null || raw === '') return defaultValue
  return raw === '1' || raw === 'true' || raw === 'True' || raw === 'TRUE'
}

export function parseEnv(env: NodeJS.ProcessEnv = process.env): IndexerEnv {
  const prev = process.env
  // Allow injection-of-env for tests; restore after read.
  if (env !== process.env) {
    process.env = env as NodeJS.ProcessEnv
  }
  try {
    const SUPABASE_URL = getRequired('SUPABASE_URL')
    const SUPABASE_SERVICE_ROLE_KEY = getRequired('SUPABASE_SERVICE_ROLE_KEY')
    const cronRaw = process.env.CRON_SLOT
    const CRON_SLOT =
      cronRaw == null || cronRaw === ''
        ? null
        : (() => {
            const parsed = Number(cronRaw)
            if (!Number.isFinite(parsed)) {
              throw new Error(`Invalid CRON_SLOT: ${cronRaw}`)
            }
            return parsed
          })()

    // SMI-5286 Wave 1b: backfill mode (bare name; default off). Parsed before the
    // caps so 1c (§#3, C-5) can raise their DEFAULTS in backfill mode while the
    // cron defaults stay untouched. (The backfill workflow also sets the caps
    // explicitly; these defaults are the safety net if it doesn't.)
    const BACKFILL_MODE = getBool('BACKFILL_MODE', false)
    const MAX_PAGES = getInt('MAX_PAGES', BACKFILL_MODE ? 10 : 5)
    const MAX_REPOS = getInt('MAX_REPOS', BACKFILL_MODE ? 500 : 100)
    const CODE_SEARCH_MAX_PAGES = getInt('CODE_SEARCH_MAX_PAGES', BACKFILL_MODE ? 10 : 1)
    const DRY_RUN = getBool('DRY_RUN', false)
    const RUN_TYPE_RAW = process.env.RUN_TYPE ?? 'discovery'
    if (
      RUN_TYPE_RAW !== 'discovery' &&
      RUN_TYPE_RAW !== 'maintenance' &&
      RUN_TYPE_RAW !== 'recheck'
    ) {
      throw new Error(`Invalid RUN_TYPE: ${RUN_TYPE_RAW} (expected discovery|maintenance|recheck)`)
    }
    const RUN_TYPE = RUN_TYPE_RAW
    const STALE_DAYS = getInt('STALE_DAYS', RUN_TYPE === 'maintenance' ? 7 : 30)

    // SMI-5166: recheck run-type configuration.
    // Defaults: threshold=5d, max candidates=2000, batch=5, dry-run=true.
    // RECHECK_DRY_RUN defaults true so a scheduled cron (which has no workflow
    // dry_run input) lands in dry-run on first fire (SMI-5166 E6). Clamping is
    // done downstream in runRecheck, mirroring how STALE_DAYS is parsed here.
    const RECHECK_THRESHOLD_DAYS = getInt('RECHECK_THRESHOLD_DAYS', 5)
    const RECHECK_MAX_CANDIDATES = getInt('RECHECK_MAX_CANDIDATES', 2000)
    const RECHECK_BATCH = getInt('RECHECK_BATCH', 5)
    const RECHECK_DRY_RUN = getBool('RECHECK_DRY_RUN', true)

    // SMI-4870: parse DISCOVERY_PHASE — empty/unset → undefined; '1'/'2'/'3' →
    // numeric literal; any other non-empty value → hard error (mirrors RUN_TYPE
    // validation style above).
    const discoveryPhaseRaw = process.env.DISCOVERY_PHASE
    let DISCOVERY_PHASE: DiscoveryPhase | undefined
    if (discoveryPhaseRaw != null && discoveryPhaseRaw !== '') {
      if (discoveryPhaseRaw !== '1' && discoveryPhaseRaw !== '2' && discoveryPhaseRaw !== '3') {
        throw new Error(`Invalid DISCOVERY_PHASE: ${discoveryPhaseRaw} (expected 1|2|3)`)
      }
      DISCOVERY_PHASE = Number(discoveryPhaseRaw) as DiscoveryPhase
    }

    // SMI-5286 1c: single-prefix restriction for the backfill facet crawl. Empty
    // string → undefined (the broad query). BACKFILL_MAX_RANGES = per-dispatch
    // (sub)range budget so a run fits the GHA cap (default 150).
    const backfillPathPrefixRaw = process.env.BACKFILL_PATH_PREFIX
    const BACKFILL_PATH_PREFIX =
      backfillPathPrefixRaw == null || backfillPathPrefixRaw === ''
        ? undefined
        : backfillPathPrefixRaw
    const BACKFILL_MAX_RANGES = getInt('BACKFILL_MAX_RANGES', 150)
    // SMI-5319 W4: fresh-start facet skip — skip the 0-1023B noise band on a
    // cold-start dispatch. Default 0 = all facets (no skip). Only applied on the
    // fresh-start path; RESUMES carry their own facet_index from the checkpoint
    // cursor and are unaffected.
    const BACKFILL_MIN_SIZE_BYTES = getInt('BACKFILL_MIN_SIZE_BYTES', 0)

    // Concurrency: kill-switch (env=1) forces 1, else CONCURRENCY env or D-3 default of 2.
    const kill_switch_engaged = getBool('CONCURRENCY_KILL_SWITCH', false)
    const concurrencyRequest = getInt('CONCURRENCY', 2)
    const concurrency = kill_switch_engaged ? 1 : Math.max(1, concurrencyRequest)

    return {
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      CRON_SLOT,
      MAX_PAGES,
      MAX_REPOS,
      CODE_SEARCH_MAX_PAGES,
      DRY_RUN,
      RUN_TYPE,
      STALE_DAYS,
      RECHECK_THRESHOLD_DAYS,
      RECHECK_MAX_CANDIDATES,
      RECHECK_BATCH,
      RECHECK_DRY_RUN,
      concurrency,
      kill_switch_engaged,
      DISCOVERY_PHASE,
      BACKFILL_MODE,
      BACKFILL_PATH_PREFIX,
      BACKFILL_MAX_RANGES,
      BACKFILL_MIN_SIZE_BYTES,
    }
  } finally {
    process.env = prev
  }
}
