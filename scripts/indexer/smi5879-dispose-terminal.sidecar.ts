/**
 * SMI-6444's `.sample.json` sidecar: the resumable, independently-locked
 * record of one sampling run — creation, the full resume-validation list, and
 * a handle that checkpoints every recorded result atomically while holding
 * the sidecar's own lock for the whole run.
 * @module scripts/indexer/smi5879-dispose-terminal.sidecar
 *
 * Plan: docs/internal/implementation/smi-6444-g1-bulk-disposition-plan.md
 *   Item 8. The sidecar lock is DELIBERATELY NOT the ledger lock: a live
 *   re-fetch run can take hours, and holding the ledger lock that long would
 *   block staging/sign-off/add-manual for every other batch and outcome class
 *   the whole time. A second invocation targeting the SAME sidecar fails fast
 *   with `StuckLockError`; a different batch (a different sidecar path)
 *   proceeds concurrently with no contention.
 */

import {
  acquireWithContext,
  defaultFileIoDeps,
  writeFileAtomically,
  type FileIoDeps,
  type LockRelease,
} from './smi5879-dispose-terminal.io.ts'
import {
  deriveSampleSelection,
  parseSampleSidecar,
} from './smi5879-dispose-terminal.sidecar.derive.ts'
import { validateSidecarForResume } from './smi5879-dispose-terminal.sidecar.validation.ts'
import type { StratumObservation } from './smi5879-dispose-terminal.stats.types.ts'
import {
  SIDECAR_KIND,
  SIDECAR_LOCK_LABEL,
  SIDECAR_SCHEMA_VERSION,
  refuseSidecar,
  type DerivedSampleSelection,
  type SampleCandidate,
  type SampleResultValue,
  type SampleRunIdentity,
  type SampleSidecar,
  type SidecarRefusal,
} from './smi5879-dispose-terminal.sidecar.types.ts'

export * from './smi5879-dispose-terminal.sidecar.types.ts'
export {
  computeCandidateIdsDigest,
  deriveSampleSelection,
  parseSampleSidecar,
} from './smi5879-dispose-terminal.sidecar.derive.ts'
export { validateSidecarForResume } from './smi5879-dispose-terminal.sidecar.validation.ts'

/** The one line of context added to a propagating `StuckLockError`. */
export const SIDECAR_LOCK_CONTEXT_LINE =
  'Context: another sampling run holds this sidecar lock; wait for it to finish or resume that run. A different batch (a different .sample.json path) is unaffected.'

/** The sidecar's I/O surface is the shared {@link FileIoDeps}, holding a
 *  different lock from the ledger's. */
export type SidecarIoDeps = FileIoDeps

export const defaultSidecarIoDeps: SidecarIoDeps = defaultFileIoDeps

function byBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function serializeSidecar(sidecar: SampleSidecar): string {
  return `${JSON.stringify(sidecar, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// The locked, checkpointing run handle
// ---------------------------------------------------------------------------

/** One stratum's final id lists, frozen at staging time. */
export interface FrozenSampleStratum {
  stratum_key: string
  population_count: number
  selected_ids: string[]
  mismatched_ids: string[]
  unavailable_ids: string[]
  verified_count: number
}

export interface FrozenSample {
  strata: FrozenSampleStratum[]
  total_selected: number
  total_verified: number
  total_mismatched: number
  total_unavailable: number
}

export interface SampleRunHandle {
  readonly sidecarPath: string
  /** True when an existing sidecar was resumed rather than created. */
  readonly resumed: boolean
  /** The derivation this run was created or validated against. */
  readonly derived: DerivedSampleSelection
  /** Current in-memory sidecar; every mutation is checkpointed to disk first. */
  sidecar(): SampleSidecar
  /** Selected rows still needing an attempt: unrecorded, plus `'unavailable'`
   *  (retryable, never terminal). Sorted. */
  pendingIds(): string[]
  /** Record one row's outcome and atomically checkpoint the sidecar. */
  recordResult(id: string, value: SampleResultValue): void
  /** Per-stratum observations for `evaluateAcceptance`; an UNRECORDED row is
   *  counted as unavailable, exactly like an explicitly-unavailable one. */
  observations(): StratumObservation[]
  /** Final per-stratum id lists for the batch's `strata` records. */
  freeze(): FrozenSample
  /** Release the sidecar lock. Idempotent. */
  release(): void
}

function newSidecar(params: {
  identity: SampleRunIdentity
  derived: DerivedSampleSelection
  now: string
}): SampleSidecar {
  const { identity, derived, now } = params
  return {
    sidecar_kind: SIDECAR_KIND,
    schema_version: SIDECAR_SCHEMA_VERSION,
    run_id: identity.run_id,
    outcome_class: identity.outcome_class,
    batch_id: identity.batch_id,
    candidate_ids_digest: derived.candidate_ids_digest,
    sampling_seed: identity.sampling_seed,
    confidence_pct: identity.policy.confidencePct,
    mismatch_threshold_bp: identity.policy.mismatchThresholdBp,
    stratum_threshold_bp: identity.policy.stratumThresholdBp,
    design_point_bad_draws_per_stratum: identity.policy.designPointBadDrawsPerStratum,
    allocation: identity.allocation,
    strata: derived.strata,
    selected: derived.selected,
    results: {},
    tool_commit: identity.tool_commit,
    tool_source_digest: identity.tool_source_digest,
    created_at: now,
    updated_at: now,
  }
}

function buildHandle(params: {
  sidecarPath: string
  initial: SampleSidecar
  derived: DerivedSampleSelection
  resumed: boolean
  deps: SidecarIoDeps
  clock: () => string
  release: LockRelease
}): SampleRunHandle {
  const { sidecarPath, derived, resumed, deps, clock } = params
  let current = params.initial
  let released = false
  const stratumById = new Map(current.selected.map((row) => [row.id, row.stratum_key]))

  const checkpoint = (next: SampleSidecar): void => {
    writeFileAtomically(deps, sidecarPath, serializeSidecar(next))
    current = next
  }

  const countsByStratum = (): Map<string, FrozenSampleStratum> => {
    const map = new Map<string, FrozenSampleStratum>()
    for (const stratum of current.strata) {
      map.set(stratum.stratum_key, {
        stratum_key: stratum.stratum_key,
        population_count: stratum.population_count,
        selected_ids: [],
        mismatched_ids: [],
        unavailable_ids: [],
        verified_count: 0,
      })
    }
    for (const row of current.selected) {
      const bucket = map.get(row.stratum_key)
      /* c8 ignore next -- unreachable: every selected row's stratum is in `strata`. */
      if (bucket === undefined) continue
      bucket.selected_ids.push(row.id)
      const result = current.results[row.id]
      if (result === 'verified') bucket.verified_count += 1
      else if (result === 'mismatched') bucket.mismatched_ids.push(row.id)
      else bucket.unavailable_ids.push(row.id)
    }
    for (const bucket of map.values()) {
      bucket.selected_ids.sort(byBytes)
      bucket.mismatched_ids.sort(byBytes)
      bucket.unavailable_ids.sort(byBytes)
    }
    return map
  }

  return {
    sidecarPath,
    resumed,
    derived,
    sidecar: () => current,
    pendingIds: () =>
      current.selected
        .map((row) => row.id)
        .filter((id) => {
          const result = current.results[id]
          return result === undefined || result === 'unavailable'
        })
        .sort(byBytes),
    recordResult: (id, value) => {
      if (!stratumById.has(id)) {
        throw new RangeError(
          `recordResult: id "${id}" is not in this sample's selection — the sample membership was fixed at selection time and is never adaptively extended`
        )
      }
      const existing = current.results[id]
      if (existing === 'verified' || existing === 'mismatched') {
        throw new RangeError(
          `recordResult: id "${id}" already has the terminal result "${existing}" — only "unavailable" and unrecorded rows are re-attempted`
        )
      }
      checkpoint({ ...current, results: { ...current.results, [id]: value }, updated_at: clock() })
    },
    observations: () =>
      [...countsByStratum().values()].map((bucket) => ({
        stratumKey: bucket.stratum_key,
        populationCount: bucket.population_count,
        selectedCount: bucket.selected_ids.length,
        mismatchedCount: bucket.mismatched_ids.length,
        unavailableCount: bucket.unavailable_ids.length,
      })),
    freeze: () => {
      const strata = [...countsByStratum().values()].sort((a, b) =>
        byBytes(a.stratum_key, b.stratum_key)
      )
      return {
        strata,
        total_selected: strata.reduce((n, s) => n + s.selected_ids.length, 0),
        total_verified: strata.reduce((n, s) => n + s.verified_count, 0),
        total_mismatched: strata.reduce((n, s) => n + s.mismatched_ids.length, 0),
        total_unavailable: strata.reduce((n, s) => n + s.unavailable_ids.length, 0),
      }
    },
    release: () => {
      if (released) return
      released = true
      params.release()
    },
  }
}

export interface OpenSampleRunParams {
  sidecarPath: string
  identity: SampleRunIdentity
  /** Live candidate rows of this outcome class, from the verified population. */
  candidates: readonly SampleCandidate[]
  timeoutMs?: number
  deps?: Partial<SidecarIoDeps>
  /** ISO 8601 source for `created_at`/`updated_at`; injected for determinism. */
  clock?: () => string
}

/**
 * Acquire this sidecar's own lock (held for the WHOLE sampling run, released
 * only by `handle.release()`), then either create a fresh sidecar from the
 * derivation or validate an existing one for resume.
 *
 * A refusal releases the lock before returning, so a rejected resume never
 * strands the sidecar. A `StuckLockError` — a second invocation targeting the
 * SAME sidecar — propagates with one added line of context.
 */
export function openSampleRun(
  params: OpenSampleRunParams
): { ok: true; handle: SampleRunHandle } | SidecarRefusal {
  const deps: SidecarIoDeps = { ...defaultSidecarIoDeps, ...params.deps }
  const clock = params.clock ?? ((): string => new Date().toISOString())
  const { sidecarPath, identity } = params
  const derived = deriveSampleSelection({
    candidates: params.candidates,
    policy: identity.policy,
    seed: identity.sampling_seed,
  })

  const release = acquireWithContext(
    () =>
      deps.acquireLock(sidecarPath, {
        ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
        label: SIDECAR_LOCK_LABEL,
      }),
    SIDECAR_LOCK_CONTEXT_LINE
  )

  let handedOff = false
  try {
    if (!deps.fileExists(sidecarPath)) {
      const created = newSidecar({ identity, derived, now: clock() })
      writeFileAtomically(deps, sidecarPath, serializeSidecar(created))
      handedOff = true
      return {
        ok: true,
        handle: buildHandle({
          sidecarPath,
          initial: created,
          derived,
          resumed: false,
          deps,
          clock,
          release,
        }),
      }
    }

    let raw: unknown
    try {
      raw = JSON.parse(deps.readFile(sidecarPath))
    } catch (error) {
      return refuseSidecar(
        'sidecar_unreadable',
        `refusing to resume: ${sidecarPath} could not be read as JSON (${String(error)}).`,
        sidecarPath
      )
    }
    const parsed = parseSampleSidecar(raw)
    if (!parsed.ok) {
      return refuseSidecar(
        'sidecar_invalid_shape',
        `refusing to resume: ${sidecarPath} failed shape validation (${parsed.reason}).`,
        sidecarPath
      )
    }
    const check = validateSidecarForResume({
      sidecar: parsed.value,
      identity,
      derived,
      sidecarPath,
    })
    if (!check.ok) return check

    handedOff = true
    return {
      ok: true,
      handle: buildHandle({
        sidecarPath,
        initial: parsed.value,
        derived,
        resumed: true,
        deps,
        clock,
        release,
      }),
    }
  } finally {
    if (!handedOff) release()
  }
}
