/**
 * Typosquat finding builder for the Node indexer's non-discovery scan paths
 * (SMI-6033 Wave 1, Gap 7 — cross-model review follow-up).
 * @module scripts/indexer/typosquat-findings
 *
 * `scanSkillBundle` (`skill-processor.security.ts`) builds typosquat findings
 * inline on the discovery path. That file is under a whole-file byte-identity
 * parity pin against its Deno twin (`parity.test.ts`, "security.ts twins are
 * byte-identical modulo …"), so it is deliberately NOT refactored to import
 * this helper — the Deno twin has no equivalent of the recheck path this file
 * serves (`revalidate-stale-quarantines.*` exists only in `scripts/indexer/`),
 * so a shared module would have to be duplicated into the Deno tree purely to
 * satisfy the pin.
 *
 * Instead, the two implementations are kept honest by an EXECUTABLE guard, not
 * a comment: `scripts/tests/indexer/typosquat-findings.parity.test.ts` runs the
 * same (name, referenceNames) pair through `scanSkillBundle` and through this
 * helper and asserts the resulting finding arrays are deep-equal. Any drift in
 * either copy fails that test.
 */

import type { SecurityFinding } from './_shared/security-scanner-edge.ts'
import {
  detectTyposquat,
  resolveTyposquatEnforcementMode,
} from '../../packages/core/src/security/scanner/index.js'

/**
 * Run the typosquat detector for one candidate skill name against a
 * run-scoped reference set, in warn mode (SMI-595 default — severity capped at
 * medium, never quarantine-driving on its own).
 *
 * Returns `[]` when there is no reference set, the set is empty, or the
 * candidate name is blank — so an unreachable/failed reference-list query
 * degrades to "no typosquat check", never to a throw.
 *
 * core's `SecurityFinding.type` union is a strict superset of the edge-twin
 * union used by `mergeSiblingScans`, and core's finding carries a `category`
 * field the edge shape doesn't declare — mapped explicitly into the local
 * shape (category folded into the message) rather than passed through, so this
 * stays a real structural match, not an unsafe cast. This mapping MUST stay
 * identical to `scanSkillBundle`'s inline copy (see the module header).
 */
export function buildTyposquatFindings(
  candidateName: string | null | undefined,
  referenceNames: ReadonlySet<string> | undefined
): SecurityFinding[] {
  if (!candidateName || !candidateName.trim()) return []
  if (!referenceNames || referenceNames.size === 0) return []

  return detectTyposquat(
    candidateName,
    referenceNames,
    resolveTyposquatEnforcementMode('warn')
  ).map(
    (f): SecurityFinding => ({
      type: 'typosquat',
      severity: f.severity,
      confidence: f.confidence,
      message: f.category ? `[${f.category}] ${f.message}` : f.message,
      location: f.location,
    })
  )
}
