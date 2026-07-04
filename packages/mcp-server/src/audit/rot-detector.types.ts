/**
 * @fileoverview Type vocabulary for the rot detector (SMI-5536 Wave 2B —
 *               R0 rot detection).
 * @module @skillsmith/mcp-server/audit/rot-detector.types
 *
 * Mirrors `collision-detector.types.ts`'s shape: a flag/finding type plus
 * an options type for the detector entrypoint. Public surface re-exported
 * via `audit/index.ts` for Wave 2C+ consumers (report writer, CLI, tests).
 */

import type { InventoryEntry } from '../utils/local-inventory.types.js'

/**
 * The two user-facing rot signals.
 *
 * `stale-mtime` is deliberately ABSENT from this union: a bare "file
 * hasn't changed in N days" is not evidence of rot on its own (a stable,
 * finished skill looks identical to an abandoned one by mtime alone) and
 * would surface false positives that erode trust in the audit's other,
 * higher-confidence findings. `mtime` is not read by the detector at all
 * (as of SMI-5536 Wave 2B's determinism fix) — findings are ordered by
 * `source_path` then `signal` for reproducibility, never by recency. See
 * `rot-detector.ts`'s header.
 */
export type RotSignal = 'version-drift' | 'dead-ref'

/**
 * A single rot finding for one inventory entry. One finding per
 * (entry, signal) pair — an entry with both a dead reference AND (once
 * implemented) a version-drift signal produces two findings, mirroring
 * how the collision detector emits one flag per pass rather than merging
 * unrelated signals into one record.
 */
export interface RotFinding {
  kind: 'rot'
  /** Stable per-finding id — sha256(auditId:source_path:signal).slice(0,16). */
  rotId: string
  entry: InventoryEntry
  /**
   * `dead-ref` is always `'warning'` (actionable now). `'info'` is
   * reserved for a future lower-confidence signal; nothing emits it yet.
   */
  severity: 'warning' | 'info'
  signal: RotSignal
  /** Honest, human-readable label — never "old"/"stale". */
  reason: string
}

/** Input for {@link detectRot}. */
export interface DetectRotOptions {
  /**
   * Audit id to fold into each finding's `rotId` derivation. When the
   * caller omits it (standalone/unit-test invocation), findings are still
   * deterministic per inventory snapshot — just scoped under a fixed
   * `'unscoped'` namespace instead of a real audit run.
   */
  auditId?: string
}
