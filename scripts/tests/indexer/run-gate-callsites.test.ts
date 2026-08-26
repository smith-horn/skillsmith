/**
 * SMI-5879 (8.3.3.5): The entry-point census.
 *
 * `scripts/indexer/` has three distinct executable-file shapes, and a
 * guard-only glob (round 5's approach) is structurally blind to two of them:
 *   - Shape 1: guarded direct entry (`import.meta.url === ...` guard).
 *   - Shape 2: unconditional top-level `main()` invocation, no guard at all
 *     (today, only `run.ts` — the exact writer every workflow-path run goes
 *     through, which a guard-only census would silently never check).
 *   - Shape 3: shebang-bearing file with NEITHER shape — an
 *     "executable-looking library" (today, only `recheck.ts`) that must be
 *     asserted to STAY that way, because the day it gains a `main()` call it
 *     becomes an ungated direct entry point to a production writer.
 *   - Shape 4 (SMI-5879 Wave 3 item 1, new; extended item 3): guarded direct
 *     entry that is deliberately NOT run-gated. `smi5879-census.ts` uses the
 *     identical Shape-1 guard (so `hasDirectEntryGuard` matches it too) but
 *     must NOT call `assertRunAllowed`/`assertFreezeMarkerClear` — it is a
 *     READER of `skills` (never a writer through the indexer's normal write
 *     path; its own `smi5879_snapshot_pre`/`smi5879_repo_branch` tables are
 *     independently guarded by `smi5879_snapshot_guard()`,
 *     `supabase/migrations/20260808000000_smi5879_snapshot_generations.sql`)
 *     and, more fundamentally, it is the tool the SMI-5879 change-window
 *     freeze exists to PROTECT, not one the freeze should block: design doc
 *     8.3.2.5.7's runbook runs it at T-3d/T-0 20:15 UTC while
 *     `INDEXER_RUN_ALLOWLIST=maintenance,recheck`/`none` is already engaged,
 *     so gating it on the same mechanism would be circular. Item 3's
 *     `smi5879-simulate-full.ts`/`smi5879-simulate-preflight-estimate.ts` are
 *     the identical shape for the identical reason: both are pure READERS
 *     (they never write to `skills`, only to their own report/checkpoint
 *     artifacts and their generation's own claim/heartbeat fields — see
 *     `smi5879-simulate-full.ts`'s own module doc), and both are designed to
 *     run concurrently with the live 00:00/03:00 crons over a multi-day
 *     window (plan §3a), so gating them on the same freeze mechanism they are
 *     explicitly meant to coexist with would be exactly as circular. Item 4's
 *     `smi5879-gate-check.ts` is the same shape for the same reason again: a
 *     pure READER of the census/simulator reports and the DB's own
 *     `smi5879_run`/`smi5879_snapshot_pre` state (plus, transiently, its own
 *     self-invoked structural-closure-test subprocess) — it never writes to
 *     `skills`, and it is itself the final merge-gate evaluator the freeze
 *     window's own runbook invokes at T-3d/T-0, so gating it on the same
 *     freeze mechanism it evaluates would be circular in the same way.
 *     SMI-5879 Wave 1's `smi5879-corroboration-generate.ts` is the same
 *     shape for a STRONGER reason than any of the above: it makes no
 *     database call of any kind (no `skills` write, no
 *     `smi5879_run`/`smi5879_snapshot_pre` read) — it only reads the
 *     fixture-corpus manifest and the local scanner source, and writes the
 *     two golden JSON files under `scripts/tests/indexer/`. It also refuses
 *     to run anywhere except a clean checkout of the pinned pre-port SHA
 *     (its own module doc's preconditions), which is a narrower, unrelated
 *     safety mechanism from the change-window freeze this census concerns
 *     itself with. SMI-6015 Wave 2's `smi5879-merge-shards.ts` is the same
 *     shape for the same reason as `smi5879-simulate-full.ts`/
 *     `smi5879-gate-check.ts` above: it is a pure READER (its
 *     `Smi5879MergeShardsDbDeps` is a structural `Pick` of
 *     `getRunSummary`/`verifyDigest`/`loadCohortRows` only — no claim,
 *     heartbeat, or write method — and it never touches `skills`; it writes
 *     only its own `--output` report file), and it runs strictly BETWEEN
 *     `smi5879-simulate-full.ts` and `smi5879-gate-check.ts` in the same
 *     T-3d/T-0 freeze-window pipeline those two already run inside — gating
 *     the merge step on the same freeze mechanism its neighbors on both
 *     sides are already exempted from would be exactly as circular. Pinned
 *     as its own explicit set (Shape 1's "exactly N" assertion below is
 *     `PINNED_SHAPE1 ∪ PINNED_SHAPE4_UNGATED_GUARD`) rather than silently
 *     absorbed, so a FUTURE guard-shaped file that SHOULD be gated cannot
 *     hide behind this exclusion.
 *
 * Each shape's set is pinned exactly (not just "at least") so a new file in
 * any shape fails this suite with a message naming the new file, rather than
 * being silently absorbed.
 */

import { describe, it, expect } from 'vitest'
import {
  listIndexerSourceFiles,
  readIndexerSource,
  hasDirectEntryGuard,
  hasShebang,
  parseIndexerSourceFile,
  hasTopLevelCallInvocation,
  importsNamedSymbolFrom,
} from './run-gate-ast-helpers.ts'

const PINNED_SHAPE1 = [
  'dequarantine-false-positives.ts',
  'purge-dead-quarantines.ts',
  'repair-latched-name-rows.ts',
  'revalidate-stale-quarantines.ts',
].sort()

const PINNED_SHAPE2 = ['run.ts']

const PINNED_SHAPE4_UNGATED_GUARD = [
  'smi5879-census.ts',
  'smi5879-simulate-full.ts',
  'smi5879-simulate-preflight-estimate.ts',
  'smi5879-gate-check.ts',
  'smi5879-corroboration-generate.ts',
  'smi5879-merge-shards.ts',
].sort()

const PINNED_SHEBANG_FILES = [
  'dequarantine-false-positives.ts',
  'purge-dead-quarantines.ts',
  'recheck.ts',
  'repair-latched-name-rows.ts',
  'revalidate-stale-quarantines.ts',
  'run.ts',
].sort()

describe('Shape 1 — guarded direct-entry census', () => {
  const files = listIndexerSourceFiles()
  const shape1Files = files.filter((f) => hasDirectEntryGuard(readIndexerSource(f))).sort()

  it('is EXACTLY the pinned Shape-1 (gated) set plus the Shape-4 (deliberately ungated) set', () => {
    expect(shape1Files).toEqual([...PINNED_SHAPE1, ...PINNED_SHAPE4_UNGATED_GUARD].sort())
  })

  it.each(PINNED_SHAPE1)(
    '%s imports and calls assertRunAllowed AND assertFreezeMarkerClear',
    (file) => {
      const sourceFile = parseIndexerSourceFile(file)
      expect(importsNamedSymbolFrom(sourceFile, 'run-gate.ts', 'assertRunAllowed')).toBe(true)
      expect(importsNamedSymbolFrom(sourceFile, 'run-gate.ts', 'assertFreezeMarkerClear')).toBe(
        true
      )

      const source = readIndexerSource(file)
      expect(source).toMatch(/\bassertRunAllowed\s*\(/)
      expect(source).toMatch(/\bassertFreezeMarkerClear\s*\(/)
    }
  )
})

describe('Shape 4 — guarded direct entry that is deliberately NOT an indexer writer', () => {
  it('is EXACTLY the pinned set {smi5879-census.ts, smi5879-simulate-full.ts, smi5879-simulate-preflight-estimate.ts, smi5879-gate-check.ts, smi5879-corroboration-generate.ts, smi5879-merge-shards.ts}', () => {
    const files = listIndexerSourceFiles()
    const shape4Files = files
      .filter(
        (f) => hasDirectEntryGuard(readIndexerSource(f)) && !PINNED_SHAPE1.includes(f) // excludes the real writers
      )
      .sort()
    expect(shape4Files).toEqual(PINNED_SHAPE4_UNGATED_GUARD)
  })

  it.each(PINNED_SHAPE4_UNGATED_GUARD)(
    '%s does NOT call assertRunAllowed/assertFreezeMarkerClear — it is the tool the change-window freeze runs INSIDE, not one the freeze blocks',
    (file) => {
      const source = readIndexerSource(file)
      expect(source).not.toMatch(/\bassertRunAllowed\s*\(/)
      expect(source).not.toMatch(/\bassertFreezeMarkerClear\s*\(/)
    }
  )
})

describe('Shape 2 — run.ts is named explicitly, not discovered', () => {
  // run.ts has NO import.meta.url guard — it invokes main() unconditionally
  // at the bottom of the file (main().catch(...)). A guard-based glob cannot
  // find it, which is exactly the gap round 5's census had.
  const sourceFile = parseIndexerSourceFile('run.ts')

  it('contains a top-level main() invocation', () => {
    expect(hasTopLevelCallInvocation(sourceFile, 'main')).toBe(true)
  })

  it('imports assertRunAllowed from ./run-gate.ts', () => {
    expect(importsNamedSymbolFrom(sourceFile, 'run-gate.ts', 'assertRunAllowed')).toBe(true)
  })

  it('calls assertRunAllowed(env.RUN_TYPE) inside main()', () => {
    const source = readIndexerSource('run.ts')
    expect(source).toMatch(/assertRunAllowed\s*\(\s*env\.RUN_TYPE\s*\)/)
  })

  it('does NOT call assertFreezeMarkerClear — the CI-only path adds no adversarial strength from the DB marker (8.3.3.2)', () => {
    const source = readIndexerSource('run.ts')
    expect(source).not.toMatch(/assertFreezeMarkerClear/)
  })
})

describe('Shape 2 is a closed set', () => {
  it('exactly {run.ts} has a top-level main() invocation', () => {
    const files = listIndexerSourceFiles()
    const shape2Files = files
      .filter((f) => hasTopLevelCallInvocation(parseIndexerSourceFile(f), 'main'))
      .sort()
    expect(shape2Files).toEqual(PINNED_SHAPE2)
  })
})

describe('Shape 3 — no executable-looking library gains an entry point', () => {
  it('the shebang-bearing file set is exactly the pinned five', () => {
    const files = listIndexerSourceFiles()
    const shebangFiles = files.filter((f) => hasShebang(readIndexerSource(f))).sort()
    expect(shebangFiles).toEqual(PINNED_SHEBANG_FILES)
  })

  it('shebangFiles \\ (shape1 ∪ shape2) is exactly {recheck.ts}', () => {
    const files = listIndexerSourceFiles()
    const shebangFiles = new Set(files.filter((f) => hasShebang(readIndexerSource(f))))
    const shape1 = new Set(files.filter((f) => hasDirectEntryGuard(readIndexerSource(f))))
    const shape2 = new Set(
      files.filter((f) => hasTopLevelCallInvocation(parseIndexerSourceFile(f), 'main'))
    )

    const remainder = [...shebangFiles].filter((f) => !shape1.has(f) && !shape2.has(f)).sort()
    expect(remainder).toEqual(['recheck.ts'])
  })
})
