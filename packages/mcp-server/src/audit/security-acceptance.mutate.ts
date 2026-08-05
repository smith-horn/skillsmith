/**
 * @fileoverview Atomic mutation (accept / revoke) for the security-acceptance
 *               store. (SMI-5883 Wave 2, split from security-acceptance.ts
 *               per the 500-line file gate.)
 * @module @skillsmith/mcp-server/audit/security-acceptance.mutate
 *
 * Every write goes through the shared two-level `acquireOwnedLock` primitive
 * (`@skillsmith/core/config/owned-lock`) -- the SAME mechanism
 * `acquireConfigLock` now wraps -- so the read-modify-write here is one
 * atomic critical section, cross-process. No shortcuts, no age-based
 * staleness, no skipping the reclaim lock's re-validation step.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { SCANNER_RULESET_VERSION } from '@skillsmith/core'
import { acquireOwnedLock } from '@skillsmith/core/config/owned-lock'
import { atomicWriteFile } from '@skillsmith/core/config/atomic-write'

import { computeStoreDigest, loadAcceptanceStore } from './security-acceptance.js'
import { ACCEPTANCE_STORE_VERSION, MAX_RECORDS } from './security-acceptance.types.js'
import type {
  AcceptanceRecord,
  AcceptanceStore,
  AcceptanceWarning,
} from './security-acceptance.types.js'

/**
 * @internal Test seam (H-9, SMI-5883 §9). Sleeps SYNCHRONOUSLY inside the
 * critical section, between the locked load and the write, deterministically
 * guaranteeing two concurrent mutators overlap rather than relying on
 * scheduling luck. Never set in production. Registered in
 * `docs/internal/process/guards-and-opt-outs.md`.
 */
function testDelayIfConfigured(): void {
  const ms = Number(process.env['SKILLSMITH_ACCEPT_LOCK_TEST_DELAY_MS'] ?? '0')
  if (!Number.isFinite(ms) || ms <= 0) return
  const view = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(view, 0, 0, ms)
}

function gcExpiredRecords(records: AcceptanceRecord[]): {
  records: AcceptanceRecord[]
  expiredCount: number
} {
  const kept = records.filter((r) => r.rulesetVersion === SCANNER_RULESET_VERSION)
  return { records: kept, expiredCount: records.length - kept.length }
}

interface MutateOutcome {
  ok: boolean
  notFound?: boolean
  warnings: AcceptanceWarning[]
}

/**
 * Shared locked read-modify-write. `mutate` receives the freshly-loaded
 * (validated, capped) records and returns the NEXT records array, or `null`
 * to signal "not found" (revoke's stale-key case) without writing anything.
 *
 * @param onBeforePreReadCommitted - @internal test seam. Fires immediately
 * after the unlocked pre-read, before the lock is acquired -- used only by
 * security-acceptance.test.ts to inject a foreign (lock-bypassing) write
 * into the narrow gap this function's own revision comparison exists to
 * detect. Never set in production.
 */
function mutateStoreUnderLock(
  acceptancePath: string,
  mutate: (records: AcceptanceRecord[]) => AcceptanceRecord[] | null,
  onBeforePreReadCommitted?: () => void
): MutateOutcome {
  // Unlocked pre-read purely to capture a revision for the foreign-writer
  // detector below -- readers never need the lock (N8); the AUTHORITATIVE
  // read happens again below, inside the critical section.
  const { store: preRead } = loadAcceptanceStore(acceptancePath)
  onBeforePreReadCommitted?.()

  const release = acquireOwnedLock(`${acceptancePath}`, {
    timeoutMs: 5_000,
    label: 'acceptance store',
  })
  try {
    const { store: loaded, warnings } = loadAcceptanceStore(acceptancePath)
    if (loaded.revision !== preRead.revision) {
      warnings.push({
        code: 'acceptance_store_foreign_revision',
        message:
          'The acceptance store changed between an earlier read and this write -- another process (or a lock-bypassing hand-edit) touched it concurrently. This write still proceeds against the CURRENT contents (no data is lost), but investigate if this recurs.',
      })
    }

    testDelayIfConfigured()

    const mutated = mutate(loaded.records)
    if (mutated === null) {
      return { ok: false, notFound: true, warnings }
    }

    const gc = gcExpiredRecords(mutated)
    if (gc.expiredCount > 0) {
      warnings.push({
        code: 'acceptance_records_ruleset_expired',
        count: gc.expiredCount,
        message: `${gc.expiredCount} acceptance record(s) were for a retired scanner ruleset version and can never match again -- removed.`,
      })
    }

    // Code-review round 2 finding: `loaded.records` is already <= MAX_RECORDS
    // (loadAcceptanceStore's own load-time trim), but appending a genuinely
    // NEW acceptance (not a re-accept of an existing key) when the store was
    // already AT the cap produces MAX_RECORDS + 1 records here -- the
    // load-time trim alone does not stop this WRITE from landing one record
    // over, contradicting the "<=500 by construction" invariant the CLI
    // documents. Enforced here too, at write time, with the SAME
    // newest-first policy loadAcceptanceStore uses, so the file on disk is
    // never over capacity even for the instant between this write and the
    // next load.
    let capped = gc.records
    if (capped.length > MAX_RECORDS) {
      const overCapacity = capped.length - MAX_RECORDS
      capped = [...capped]
        .sort((a, b) => (a.acceptedAt < b.acceptedAt ? 1 : a.acceptedAt > b.acceptedAt ? -1 : 0))
        .slice(0, MAX_RECORDS)
      warnings.push({
        code: 'acceptance_records_over_capacity',
        count: overCapacity,
        message: `${overCapacity} acceptance record(s) beyond the ${MAX_RECORDS}-record limit were dropped (oldest first) to make room for this write -- those findings will re-appear. Revoke stale acceptances with 'sklx audit security --revoke <key>'.`,
      })
    }

    const next: Omit<AcceptanceStore, 'storeDigest'> = {
      version: ACCEPTANCE_STORE_VERSION,
      revision: loaded.revision + 1,
      records: capped,
    }
    const full: AcceptanceStore = { ...next, storeDigest: computeStoreDigest(next) }

    try {
      fs.mkdirSync(path.dirname(acceptancePath), { recursive: true, mode: 0o700 })
      atomicWriteFile(acceptancePath, JSON.stringify(full, null, 2), 0o600)
    } catch (err) {
      warnings.push({
        code: 'acceptance_store_write_failed',
        message: `Failed to write the acceptance store: ${err instanceof Error ? err.message : String(err)}`,
      })
      return { ok: false, warnings }
    }
    return { ok: true, warnings }
  } finally {
    release()
  }
}

export interface AcceptOutcome {
  ok: boolean
  warnings: AcceptanceWarning[]
}

/**
 * Insert `record` into the store (a NEW acceptance). Assumes the caller
 * already validated the key resolves against the current audit's candidate
 * index. `_onBeforeLock` is an @internal test seam (see
 * `mutateStoreUnderLock`) -- never set in production.
 */
export function acceptFinding(
  acceptancePath: string,
  record: AcceptanceRecord,
  _onBeforeLock?: () => void
): AcceptOutcome {
  const result = mutateStoreUnderLock(
    acceptancePath,
    (records) => [
      ...records.filter((r) => r.acceptKey !== record.acceptKey), // idempotent re-accept overwrites, never duplicates
      record,
    ],
    _onBeforeLock
  )
  return { ok: result.ok, warnings: result.warnings }
}

export interface RevokeOutcome {
  ok: boolean
  code?: 'key_not_found'
  warnings: AcceptanceWarning[]
}

/** Remove the record matching `acceptKey`, if present. Resolves against the STORE, not the candidate index (D-9) -- a record worth revoking is often one whose content already changed, so it no longer matches any current candidate. */
export function revokeAcceptance(acceptancePath: string, acceptKey: string): RevokeOutcome {
  const result = mutateStoreUnderLock(acceptancePath, (records) => {
    if (!records.some((r) => r.acceptKey === acceptKey)) return null
    return records.filter((r) => r.acceptKey !== acceptKey)
  })
  if (result.notFound) return { ok: false, code: 'key_not_found', warnings: result.warnings }
  return { ok: result.ok, warnings: result.warnings }
}
