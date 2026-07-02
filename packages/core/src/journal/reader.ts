/**
 * @fileoverview Change-journal reader — hash-chain verification
 *               (SMI-5456 Wave 1 Step 3 / SMI-5470).
 * @module @skillsmith/core/journal/reader
 *
 * Never throws. The journal exists to be evidence (PRD §7 / §10 exclusion
 * 1); a reader that raises on the first bad byte can't produce that
 * evidence when it matters most (after a tamper or a crash mid-write). A
 * missing file is a valid, empty chain. A corrupt or tampered line is
 * reported via `breakAt` — the caller (e.g. `undo_apply`, or a future audit
 * surface) decides what to do with a break, but the reader never decides
 * for them by throwing.
 */

import { readFile } from 'node:fs/promises'

import { getJournalFilePath } from './path.js'
import { computeRecordHash } from './writer.js'
import { JOURNAL_GENESIS_HASH } from './hash.js'
import type { JournalRecord } from './types.js'

export interface ChainVerificationResult {
  /** `true` iff every line parsed, chained, and hash-verified cleanly. */
  valid: boolean
  /** Records verified so far — the full chain when `valid` is `true`, or
   * every record BEFORE the break when `valid` is `false`. */
  records: JournalRecord[]
  /** 0-based line index of the first unparseable / malformed / tampered
   * record. Present iff `valid` is `false`. */
  breakAt?: number
}

/** Narrow an arbitrary parsed JSON value down to the `JournalRecord` shape. */
function isJournalRecordShape(value: unknown): value is JournalRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return (
    typeof r.schema === 'number' &&
    typeof r.ts === 'number' &&
    typeof r.session_id === 'string' &&
    typeof r.tool === 'string' &&
    (r.action === 'apply' || r.action === 'error' || r.action === 'undo') &&
    (r.suggestion_id === null || typeof r.suggestion_id === 'string') &&
    (r.target_path === null || typeof r.target_path === 'string') &&
    (r.before_hash === null || typeof r.before_hash === 'string') &&
    (r.after_hash === null || typeof r.after_hash === 'string') &&
    (r.approval === null || typeof r.approval === 'string') &&
    (r.backup_ref === null || typeof r.backup_ref === 'string') &&
    (r.detail === null || typeof r.detail === 'string') &&
    typeof r.prev_hash === 'string' &&
    typeof r.record_hash === 'string'
  )
}

/**
 * Verify the journal's hash chain line-by-line: each record's `prev_hash`
 * must equal the previous record's `record_hash` (or `JOURNAL_GENESIS_HASH`
 * for the first line), and each record's own `record_hash` must match a
 * fresh recomputation from its other fields (SMI-5456 §7 tamper signal).
 *
 * @param filePath - Override for tests; defaults to the resolved journal path.
 */
export async function verifyJournalChain(filePath?: string): Promise<ChainVerificationResult> {
  const path = filePath ?? getJournalFilePath()

  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    // Missing file (never written yet) — a valid, empty chain.
    return { valid: true, records: [] }
  }

  const lines = raw.split('\n').filter((line) => line.trim().length > 0)
  const records: JournalRecord[] = []
  let expectedPrevHash = JOURNAL_GENESIS_HASH

  for (let i = 0; i < lines.length; i++) {
    let parsed: unknown
    try {
      parsed = JSON.parse(lines[i]!)
    } catch {
      // Corrupt/torn line (e.g. a crash mid-append) — report, don't throw.
      return { valid: false, records, breakAt: i }
    }

    if (!isJournalRecordShape(parsed)) {
      return { valid: false, records, breakAt: i }
    }

    if (parsed.prev_hash !== expectedPrevHash) {
      // Chain discontinuity — a record was deleted, reordered, or its
      // neighbor was tampered.
      return { valid: false, records, breakAt: i }
    }

    const { record_hash, ...rest } = parsed
    if (computeRecordHash(rest) !== record_hash) {
      // The record's own content was edited after the fact.
      return { valid: false, records, breakAt: i }
    }

    records.push(parsed)
    expectedPrevHash = record_hash
  }

  return { valid: true, records }
}

/** Convenience wrapper: the verified records, or as many as verified before
 * a break. Callers that need the break position should use
 * `verifyJournalChain` directly. */
export async function readJournalRecords(filePath?: string): Promise<JournalRecord[]> {
  const result = await verifyJournalChain(filePath)
  return result.records
}
