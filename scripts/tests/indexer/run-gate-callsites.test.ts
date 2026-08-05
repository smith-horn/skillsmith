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
  'revalidate-stale-quarantines.ts',
].sort()

const PINNED_SHAPE2 = ['run.ts']

const PINNED_SHEBANG_FILES = [
  'dequarantine-false-positives.ts',
  'purge-dead-quarantines.ts',
  'recheck.ts',
  'revalidate-stale-quarantines.ts',
  'run.ts',
].sort()

describe('Shape 1 — guarded direct-entry census', () => {
  const files = listIndexerSourceFiles()
  const shape1Files = files.filter((f) => hasDirectEntryGuard(readIndexerSource(f))).sort()

  it('is EXACTLY the pinned set of three files', () => {
    expect(shape1Files).toEqual(PINNED_SHAPE1)
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
