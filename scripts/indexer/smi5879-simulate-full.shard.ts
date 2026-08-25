/**
 * Row-sharding partition function for smi5879-simulate-full.ts (SMI-6015
 * Wave 1). Split into its own module rather than added to
 * smi5879-simulate-full.helpers.ts, which was already at CLAUDE.md's
 * 500-line-per-file budget before this addition.
 * @module scripts/indexer/smi5879-simulate-full.shard
 *
 * Plan: docs/internal/implementation/smi-6015-pat-sharded-fetch-plan.md
 *       ("### 1. `--shard-index`/`--shard-count` CLI flags")
 */

/**
 * FNV-1a 32-bit hash. Pure integer arithmetic (`Math.imul` for the
 * multiply-with-overflow step) so the result is identical across
 * processes/platforms/Node versions — required since N independently
 * dispatched shard processes must agree on partition boundaries without
 * coordinating. Not a security-sensitive hash; only used for shard
 * assignment.
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5 // FNV offset basis (32-bit)
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) // FNV prime (32-bit)
  }
  return hash >>> 0 // coerce to unsigned 32-bit before any modulo below
}

/**
 * Deterministic, stable partition function: the same `rowId` always maps to
 * the same shard, independent of row-loading order, process, or invocation
 * — the property N genuinely-parallel shard processes rely on to agree on
 * partition boundaries without coordinating (plan §1). `hash` is coerced to
 * unsigned 32-bit by {@link fnv1a} before the modulo, so the result is
 * always in `[0, shardCount)` — JavaScript's `%` returns a negative result
 * for a negative left operand, which an unsigned hash avoids entirely.
 */
export function shardOf(rowId: string, shardCount: number): number {
  return fnv1a(rowId) % shardCount
}
