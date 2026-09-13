/**
 * @fileoverview Namespace pre-flight + mode gate for the install hot path
 *               (SMI-4588 Wave 2 Step 6, PR #3).
 * @module @skillsmith/mcp-server/tools/install.namespace-gate
 *
 * Encapsulates the three steps that bracket `service.install()` in the
 * MCP install tool:
 *
 *   1. Ledger replay — rewrite the candidate skill's identifier when a
 *      previously-recorded user rename matches.
 *   2. Pre-flight collision detection + suggestion-chain generation.
 *   3. Mode gate (`preventative` blocks; `power_user`/`governance` warn).
 *
 * Extracted from `install.ts` per Step 6's "unconditional extraction"
 * directive — keeps the hot-path file under the 500-LOC limit and keeps
 * the new logic independently testable.
 *
 * Edits applied (plan-review 2026-05-02):
 *   - Edit 2: pre-flight scanner failure is ALWAYS non-blocking. The
 *     `runInstallPreflight` module already degrades on detector throws;
 *     this gate additionally swallows ledger-read errors (including
 *     `namespace.ledger.version_unsupported`) so a downgraded ledger
 *     never bricks installs.
 *   - Edit 6: typed `version_unsupported` error caught here, not bubbled.
 *   - Edit 7: pre-flight returns `auditId` explicitly; this gate threads
 *     it into the `pendingCollision` envelope without re-deriving.
 */

import * as path from 'path'
import {
  runInstallPreflight,
  describeThrown,
  type CandidateSkill,
  type RunInstallPreflightResult,
} from '../audit/install-preflight.js'
import { newAuditId } from '../audit/audit-history.js'
import { readLedger } from '../audit/namespace-overrides.js'
import { applyLedgerReplay } from './install.ledger-replay.js'
import { scanLocalInventory } from '../utils/local-inventory.js'
import { isAuditMode, type AuditMode, type Tier } from '@skillsmith/core/config/audit-mode'
import type { InventoryEntry } from '../audit/collision-detector.types.js'

import { CLAUDE_SKILLS_DIR, type InstallResult } from './install.types.js'
import { FIELD_LIMITS } from './validate.types.js'

/**
 * SMI-6529 round 4: moved from install.ts to keep it under the 500-line CI
 * gate (pure move, no behavior change) — also breaks what would otherwise be
 * a circular import (install.ts already imports `runNamespaceGate` FROM this
 * file). `install.ts` re-exports this so its own external import path
 * (`from '../../src/tools/install.js'`, used directly by SMI-4737's tests)
 * is unaffected.
 *
 * Best-effort skill name extraction for conflict pre-check. Does not need to
 * be perfect — just needs to match manifest keys.
 *
 * SMI-4737: throws when the extracted segment exceeds `FIELD_LIMITS.token`
 * (128 chars). Adversarial `skillId` inputs that survive the Zod 512-char
 * boundary but produce an over-cap segment are rejected at the derivation
 * site so they cannot reach `sanitizeSegment`'s defensive 256-char floor
 * (SMI-4733). Caller sites must wrap in try/catch and surface a structured
 * tool-error envelope; the throw must not escape the MCP handler.
 */
export function extractSkillName(skillId: string): string {
  let name: string
  if (skillId.includes('/')) {
    const parts = skillId.split('/')
    name = parts[parts.length - 1]
  } else {
    name = skillId
  }
  if (name.length > FIELD_LIMITS.token) {
    throw new Error(
      `Extracted skill name exceeds ${FIELD_LIMITS.token} chars (got ${name.length}). ` +
        `skillId: ${skillId.slice(0, 64)}${skillId.length > 64 ? '...' : ''}`
    )
  }
  return name
}

/**
 * Build the `CandidateSkill` shape consumed by `runNamespaceGate`. The
 * pre-flight runs before any disk write, so the path is projected.
 *
 * `extractSkillName` mirrors the manifest-key derivation used elsewhere in
 * install.ts; the `skillId` is propagated when the input is a registry id
 * (`<author>/<name>`) so ledger lookups key on the canonical form.
 */
export function buildPreflightCandidate(skillId: string): CandidateSkill {
  const skillName = extractSkillName(skillId)
  const isRegistryId = skillId.includes('/') && !skillId.startsWith('https://')
  const author = isRegistryId ? skillId.split('/')[0] : null
  return {
    identifier: skillName,
    projectedSourcePath: path.join(CLAUDE_SKILLS_DIR, skillName),
    skillId: isRegistryId ? skillId : null,
    author,
  }
}

/**
 * SMI-6529 round 4: moved from install.ts (pure move). Resolve the caller's
 * subscription tier for the audit-mode resolver. Reads `SKILLSMITH_TIER` env
 * var; falls through to `'community'` (the resolver's fail-safe default)
 * when unset or invalid. The MCP subprocess has no JWT context, so env var
 * is the only signal available without cross-cutting changes (Wave 4 will
 * revisit if richer tier resolution becomes load-bearing).
 */
export function resolveCallerTier(): Tier {
  const raw = process.env['SKILLSMITH_TIER']
  if (raw === 'community' || raw === 'individual' || raw === 'team' || raw === 'enterprise') {
    return raw
  }
  return 'community'
}

/**
 * SMI-6529 round 4: moved from install.ts (pure move). Read the optional
 * `SKILLSMITH_AUDIT_MODE` override. Invalid values fall through to `null` so
 * the resolver applies the tier default.
 */
export function readAuditModeOverride() {
  const raw = process.env['SKILLSMITH_AUDIT_MODE']
  return isAuditMode(raw) ? raw : null
}

export interface NamespaceGateInput {
  /** Synthesized candidate for the skill being installed. */
  candidate: CandidateSkill
  /** Resolved audit mode (caller resolves via `resolveAuditMode`). */
  mode: AuditMode
  /** Subscription tier (passed through to detector for telemetry consistency). */
  tier: Tier
}

export interface NamespaceGateOutcome {
  /**
   * `'block'` only fires when `mode === 'preventative'` AND a candidate-
   * involved collision was detected. Caller short-circuits the install
   * with the `pendingCollision` envelope.
   */
  decision: 'block' | 'proceed'
  /**
   * The (possibly ledger-replayed) candidate. Caller MAY use this for
   * post-install side effects, but Wave 2 PR #3 does not yet wire
   * post-install rename — the ledger-replay rewrites the candidate in
   * place at the pre-flight boundary so the surfaced suggestions match.
   */
  candidate: CandidateSkill
  /** Always present — populated by `runInstallPreflight`. */
  preflight: RunInstallPreflightResult
  /**
   * `InstallResult` payload to merge into the caller's return value.
   * Populated for both `block` and `proceed` paths so the install hot
   * path has a single shape to splat.
   */
  resultPatch: Pick<InstallResult, 'installComplete' | 'pendingCollision' | 'warnings'>
  /**
   * SMI-6588: non-fatal problems this gate hit, for the caller to surface
   * through `tips`. Empty means the gate ran; a non-empty entry means it
   * did NOT run and says which step failed.
   *
   * This is deliberately NOT folded into `resultPatch.warnings`: that field
   * is `NamespaceWarning[]` (a structured collision record), and a gate that
   * never ran has no collision to report — it has a reason. Conflating the
   * two is what made "found nothing" and "never looked" identical here.
   *
   * Non-optional on purpose. An optional field that is sometimes `undefined`
   * reintroduces the exact ambiguity this issue exists to remove.
   */
  problems: string[]
}

/**
 * Run the namespace pre-flight + apply the mode gate. Returns a decision
 * the install hot path branches on. Never throws — all failure paths
 * degrade to `decision: 'proceed'` with a logged warning (Edit 2).
 */
export async function runNamespaceGate(input: NamespaceGateInput): Promise<NamespaceGateOutcome> {
  const { mode, tier } = input

  // Step 1 — ledger replay. Read the ledger; on failure (including
  // `version_unsupported`), degrade to "no replay, no preflight" because
  // we cannot trust the candidate's effective identifier without it.
  let candidate: CandidateSkill = input.candidate
  try {
    const ledger = await readLedger()
    const replay = applyLedgerReplay(input.candidate, ledger)
    candidate = replay.candidate
  } catch (err) {
    // Edit 6: typed version_unsupported (or any other ledger error)
    // surfaces here. Pre-flight is non-blocking; degrade.
    const cause = describeThrown(err)
    console.warn(`[install.namespace-gate] ledger read failed (${cause}); skipping pre-flight`)
    return degradedProceed(candidate, 'the rename ledger could not be read', cause)
  }

  // Step 2 — scan local inventory + run pre-flight. The scanner runs
  // synchronously per call (Wave 1 plumbing). Errors here also degrade.
  let existingInventory: ReadonlyArray<InventoryEntry>
  try {
    const scan = await scanLocalInventory()
    existingInventory = scan.entries
  } catch (err) {
    const cause = describeThrown(err)
    console.warn(
      `[install.namespace-gate] scanLocalInventory failed (${cause}); skipping pre-flight`
    )
    return degradedProceed(candidate, 'the local skill inventory could not be scanned', cause)
  }

  let preflight: RunInstallPreflightResult
  try {
    preflight = await runInstallPreflight({
      existingInventory,
      candidate,
      mode,
      tier,
    })
  } catch (err) {
    // `runInstallPreflight` itself already catches detector throws and
    // degrades, but a defensive outer catch keeps the install hot path
    // bulletproof against any future regression.
    const cause = describeThrown(err)
    console.warn(
      `[install.namespace-gate] runInstallPreflight threw (${cause}); proceeding non-blocking`
    )
    return degradedProceed(candidate, 'the collision detector threw', cause)
  }

  // SMI-6588 cross-model review: the outer catch above is a backstop that in
  // practice cannot fire for a detector failure — `runInstallPreflight` has
  // its own catch and degrades first, returning a shape identical to a clean
  // run. The real detector-failure report therefore comes from `problem`, not
  // from this file's catch. Keeping both is deliberate: the catch still
  // covers anything that throws outside `runInstallPreflight`'s own try.
  const preflightProblems = preflight.problem === null ? [] : [preflight.problem]

  // Step 3 — mode gate.
  const hasCollision = preflight.pendingCollision !== null

  if (mode === 'preventative' && hasCollision) {
    return {
      decision: 'block',
      candidate,
      preflight,
      resultPatch: {
        installComplete: false,
        pendingCollision: preflight.pendingCollision ?? undefined,
        warnings: preflight.warnings.length > 0 ? preflight.warnings : undefined,
      },
      problems: preflightProblems,
    }
  }

  // power_user / governance / preventative-without-collision all proceed.
  return {
    decision: 'proceed',
    candidate,
    preflight,
    resultPatch: {
      installComplete: true,
      warnings: preflight.warnings.length > 0 ? preflight.warnings : undefined,
    },
    problems: preflightProblems,
  }
}

/**
 * SMI-6588 cross-model review: the gate runs early in `installSkillImpl`, but
 * its problems were merged only at the final return. Every exit between the
 * two dropped them — a scope error, a target-guard refusal, or a conflict
 * early return would report its own failure while silently discarding the
 * fact that the namespace pre-flight never ran.
 *
 * Lives here rather than in `install.ts` because that file sits at the
 * 500-line CI gate.
 */
export function attachGateProblems<T extends { tips?: string[] }>(
  result: T,
  problems: string[]
): T {
  if (problems.length === 0) return result
  return { ...result, tips: [...(result.tips ?? []), ...problems] }
}

/**
 * Degraded-proceed shape used when ledger read, inventory scan, or
 * pre-flight throws.
 *
 * SMI-6588: degrading to `proceed` is correct — the namespace pre-flight is
 * advisory and must never block an install on its own failure. Reporting
 * NOTHING was not. `step` names which part failed and `cause` why, so the
 * caller can tell "no collision was found" from "nothing ever looked."
 *
 * `auditId` is allocated via `newAuditId()` even on the degraded path so
 * the `AuditId` brand invariant holds for any defensive consumer that
 * reads `preflight.auditId` without checking `decision` first.
 */
function degradedProceed(
  candidate: CandidateSkill,
  step: string,
  cause: string
): NamespaceGateOutcome {
  return {
    decision: 'proceed',
    candidate,
    preflight: {
      warnings: [],
      pendingCollision: null,
      auditId: newAuditId(),
      // The pre-flight never ran at all on this path, so this synthetic
      // result must say so rather than mimic a clean one.
      problem: `${step}: ${cause}`,
    },
    resultPatch: {
      installComplete: true,
    },
    problems: [
      `the namespace pre-flight did not run (${step} failed: ${cause}); the install ` +
        `proceeded, but this skill was NOT checked for a name collision with your ` +
        `already-installed skills.`,
    ],
  }
}
