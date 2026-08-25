/**
 * SMI-6015 PAT-sharded fetch plan Wave 1 Step 1: `shardOf()` partition
 * function — even distribution, stability, and the `shardCount=1`
 * degenerate case (plan's own test spec for this step).
 * @module scripts/tests/indexer/smi5879-simulate-full.shard
 */

import { describe, it, expect } from 'vitest'
import { shardOf } from '../../indexer/smi5879-simulate-full.shard.ts'

describe('shardOf', () => {
  it('always returns a value in [0, shardCount)', () => {
    for (let i = 0; i < 10_000; i++) {
      const shard = shardOf(`row-${i}`, 5)
      expect(shard).toBeGreaterThanOrEqual(0)
      expect(shard).toBeLessThan(5)
      expect(Number.isInteger(shard)).toBe(true)
    }
  })

  it('is stable: the same rowId always maps to the same shard', () => {
    const id = 'skill-abc123-def456'
    const first = shardOf(id, 7)
    for (let i = 0; i < 100; i++) {
      expect(shardOf(id, 7)).toBe(first)
    }
  })

  it('is independent of call order / batching', () => {
    const ids = Array.from({ length: 500 }, (_, i) => `row-${i}`)
    const inOrder = ids.map((id) => shardOf(id, 3))
    const shuffled = [...ids].reverse()
    const reversedOrder = shuffled.map((id) => shardOf(id, 3))
    // Same rowId -> same shard, regardless of the order shardOf was called in.
    for (let i = 0; i < ids.length; i++) {
      expect(inOrder[i]).toBe(shardOf(ids[i], 3))
    }
    expect(reversedOrder[0]).toBe(inOrder[ids.length - 1])
  })

  it('the shardCount=1 degenerate case always returns shard 0 (no-op single-shard run)', () => {
    for (let i = 0; i < 1000; i++) {
      expect(shardOf(`row-${i}`, 1)).toBe(0)
    }
  })

  it('distributes a 10k-row synthetic sample roughly evenly across 5 shards', () => {
    const shardCount = 5
    const counts = new Array(shardCount).fill(0)
    for (let i = 0; i < 10_000; i++) {
      counts[shardOf(`skill-${i}-${Math.random().toString(36).slice(2)}`, shardCount)]++
    }
    // Expected ~2000/shard. A simple bucket-count-within-tolerance check
    // (not a formal chi-square test) — generous tolerance since this is a
    // correctness smoke test, not a statistical distribution proof.
    for (const count of counts) {
      expect(count).toBeGreaterThan(1500)
      expect(count).toBeLessThan(2500)
    }
  })

  it('different shardCount values for the same rowId can (and generally do) land in different shards', () => {
    // Not a strict correctness requirement (shardOf has no obligation to
    // preserve any relationship across different shardCount values) — this
    // just documents that the function doesn't degenerate to a constant.
    const id = 'skill-xyz'
    const results = new Set([shardOf(id, 2), shardOf(id, 3), shardOf(id, 5), shardOf(id, 7)])
    expect(results.size).toBeGreaterThan(1)
  })
})
