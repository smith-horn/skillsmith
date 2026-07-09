/**
 * SMI-5615: Unit tests for `correlationIdStorage` / `runWithCorrelationId` /
 * `getCorrelationId`. Mirrors the pattern of the `markerStorage` coverage in
 * `packages/core/src/telemetry/wrap.marker.test.ts` — a module-scoped
 * `AsyncLocalStorage` instance, installed per-call via a `runWith*` function,
 * read live via `.getStore()`.
 *
 * These are direct, in-isolation tests of the primitive itself; the
 * `withTelemetry` install-site contract (mint-if-absent, whole-`wrappedFn`-
 * body scope) is covered separately in
 * `packages/core/src/telemetry/wrap.correlation.test.ts`.
 */

import { describe, it, expect } from 'vitest'
import { correlationIdStorage, runWithCorrelationId, getCorrelationId } from './context.js'

describe('getCorrelationId', () => {
  it('returns undefined outside any runWithCorrelationId scope', () => {
    expect(getCorrelationId()).toBeUndefined()
  })
})

describe('runWithCorrelationId', () => {
  it('installs the ID for the duration of the callback', async () => {
    let observed: string | undefined
    await runWithCorrelationId('id-1', async () => {
      observed = getCorrelationId()
    })
    expect(observed).toBe('id-1')
  })

  it('auto-unwinds after the callback resolves', async () => {
    await runWithCorrelationId('id-2', async () => {
      // no-op
    })
    expect(getCorrelationId()).toBeUndefined()
  })

  it('auto-unwinds after the callback rejects', async () => {
    await expect(
      runWithCorrelationId('id-3', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(getCorrelationId()).toBeUndefined()
  })

  it('returns the callback resolved value', async () => {
    const result = await runWithCorrelationId('id-4', async () => 42)
    expect(result).toBe(42)
  })

  it('nested scopes — inner ID shadows the outer ID inside its own callback', async () => {
    const seen: string[] = []
    await runWithCorrelationId('outer', async () => {
      seen.push(getCorrelationId()!)
      await runWithCorrelationId('inner', async () => {
        seen.push(getCorrelationId()!) // 'inner' — shadows the outer ID
      })
      // Outer scope resumes after the inner one unwinds — back to 'outer'.
      seen.push(getCorrelationId()!)
    })
    expect(seen).toEqual(['outer', 'inner', 'outer'])
  })

  it('concurrent, overlapping scopes each observe only their own ID (P-5 invariant)', async () => {
    let releaseA!: () => void
    let releaseB!: () => void
    const blockA = new Promise<void>((r) => (releaseA = r))
    const blockB = new Promise<void>((r) => (releaseB = r))

    const observedA: string[] = []
    const observedB: string[] = []

    const callA = runWithCorrelationId('id-a', async () => {
      observedA.push(getCorrelationId()!)
      await blockA
      observedA.push(getCorrelationId()!)
    })
    const callB = runWithCorrelationId('id-b', async () => {
      observedB.push(getCorrelationId()!)
      await blockB
      observedB.push(getCorrelationId()!)
    })

    // A completes first while B is still awaiting; B must never observe A's ID.
    releaseA()
    await callA
    releaseB()
    await callB

    expect(observedA).toEqual(['id-a', 'id-a'])
    expect(observedB).toEqual(['id-b', 'id-b'])
  })

  it('the exported correlationIdStorage is the same instance read.write path', async () => {
    // Sanity: getCorrelationId is a thin wrapper over correlationIdStorage.getStore().
    await correlationIdStorage.run('direct-id', async () => {
      expect(getCorrelationId()).toBe('direct-id')
    })
  })
})
