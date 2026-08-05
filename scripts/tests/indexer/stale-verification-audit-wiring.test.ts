/**
 * SMI-5551 follow-up (SMI-5926): structural guards for the Node-side
 * `staleVerification` wiring through `maintenance-helpers.ts` and
 * `discovery-orchestrator.(phase-split.)ts`.
 *
 * reconcileStaleSkills() computed verifiedLive/transientSkipped/
 * maliciousQuarantined all along (SMI-5551), but every caller dropped them
 * before reaching writeIndexerAuditLog — audit_logs.stale persisted while
 * the verification-outcome breakdown silently vanished. The Deno twins have
 * runtime-adjacent source-regex guards for the same class of bug
 * (indexer-audit-log.test.ts, maintenance-helpers.test.ts,
 * discovery-orchestrator.test.ts); this file is the Node-side equivalent,
 * matching the established source-regex-guard pattern for functions that
 * Deno.serve-style side effects (or, here, the LOC-split across
 * discovery-orchestrator.ts / .phase-split.ts) make awkward to unit-invoke
 * directly.
 *
 * runStaleReconciliationPhase's own forwarding contract is covered by
 * stale-reconciliation-skip.test.ts; writeIndexerAuditLog's persistence is
 * covered by audit-log-persistence.test.ts. This file covers the remaining
 * "glue" in between: the object-literal construction in
 * maintenance-helpers.ts, and the DiscoveryAuditLogInput pass-through +
 * scope-surviving local-variable threading in discovery-orchestrator.ts.
 */

import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const INDEXER_DIR = resolve(__dirname, '../../indexer')

async function readSource(file: string): Promise<string> {
  return readFile(resolve(INDEXER_DIR, file), 'utf8')
}

describe('SMI-5551 follow-up: maintenance-helpers.ts staleVerification wiring', () => {
  it('audit log forwards staleVerification built from staleResult', async () => {
    const source = await readSource('maintenance-helpers.ts')
    expect(source, 'staleVerification field missing from writeIndexerAuditLog call').toMatch(
      /staleVerification:\s*\{/
    )
    expect(source, 'verifiedLive not sourced from staleResult').toMatch(
      /verifiedLive:\s*staleResult\.verifiedLive/
    )
    expect(source, 'transientSkipped not sourced from staleResult').toMatch(
      /transientSkipped:\s*staleResult\.transientSkipped/
    )
    expect(source, 'maliciousQuarantined not sourced from staleResult').toMatch(
      /maliciousQuarantined:\s*staleResult\.maliciousQuarantined/
    )
    expect(source, 'errors count not sourced from staleResult.errors.length').toMatch(
      /errors:\s*staleResult\.errors\.length/
    )
  })
})

describe('SMI-5551 follow-up: discovery-orchestrator.phase-split.ts staleVerification wiring', () => {
  it('runStaleReconciliationPhase return type includes staleVerification', async () => {
    const source = await readSource('discovery-orchestrator.phase-split.ts')
    expect(source, 'runStaleReconciliationPhase return type missing staleVerification').toMatch(
      /Promise<\{\s*stale:\s*number;\s*staleVerification:\s*StaleVerificationCounters/
    )
  })

  it('DiscoveryAuditLogInput declares staleVerification and writeDiscoveryAuditLog forwards it', async () => {
    const source = await readSource('discovery-orchestrator.phase-split.ts')
    expect(source, 'DiscoveryAuditLogInput.staleVerification field missing').toMatch(
      /staleVerification:\s*StaleVerificationCounters/
    )
    expect(
      source,
      'writeDiscoveryAuditLog does not forward input.staleVerification to writeIndexerAuditLog'
    ).toMatch(/staleVerification:\s*input\.staleVerification/)
  })
})

describe('SMI-5551 follow-up: discovery-orchestrator.phase-split.ts buildInitialDiscoveryResult', () => {
  it('zero-initializes staleVerification on the result object (extracted to keep the 500-line gate)', async () => {
    const source = await readSource('discovery-orchestrator.phase-split.ts')
    expect(source, 'buildInitialDiscoveryResult export missing').toMatch(
      /export function buildInitialDiscoveryResult/
    )
    expect(source, 'staleVerification not zero-initialized in buildInitialDiscoveryResult').toMatch(
      /staleVerification:\s*ZERO_STALE_VERIFICATION/
    )
  })
})

describe('SMI-5551 follow-up: discovery-orchestrator.ts staleVerification wiring', () => {
  it('builds result via buildInitialDiscoveryResult, assigns from staleResult, and forwards result.staleVerification into writeDiscoveryAuditLog', async () => {
    const source = await readSource('discovery-orchestrator.ts')
    expect(
      source,
      'result is not built via the extracted buildInitialDiscoveryResult helper'
    ).toMatch(/const result: IndexerResult = buildInitialDiscoveryResult\(dryRun\)/)
    expect(
      source,
      'result.staleVerification not assigned from runStaleReconciliationPhase result'
    ).toMatch(/result\.staleVerification = staleResult\.staleVerification/)
    // Confirms Phase 7 reads the same `result.staleVerification` the Phase 6
    // branch assigned (mirrors the pre-existing `stale: result.stale` pattern
    // this field piggybacks on), not a fresh zeroed default re-derived at the
    // call site.
    expect(source, 'writeDiscoveryAuditLog call does not pass result.staleVerification').toMatch(
      /stale:\s*result\.stale,\s*\n\s*staleVerification:\s*result\.staleVerification,/
    )
  })
})
