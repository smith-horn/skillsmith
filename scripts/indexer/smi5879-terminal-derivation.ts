/**
 * Shared derivation of the `unfetchable` subtype from digest-verified
 * population data — the single implementation consumed by both the bulk
 * disposition producer's own re-derivation and the gate-side ground-truth
 * re-derivation check, so the two can never compute a different answer for
 * the same row.
 * @module scripts/indexer/smi5879-terminal-derivation
 *
 * Plan: docs/internal/implementation/smi-6444-g1-bulk-disposition-plan.md
 *       Item 2 ("`unfetchable` ground-truth re-derivation") and Item 6
 *       ("`unfetchable` verification: two subtypes, not one uniform
 *       re-check").
 *
 * Mirrors `processRow`'s own `unfetchable` classification exactly
 * (`smi5879-simulate-full.helpers.ts`'s two `unfetchable` return sites) so a
 * row that classified as `unfetchable` at simulation time re-derives
 * identically here, against the same digest-verified inputs — never against
 * a report's self-reported `outcome`/`unfetchable_subtype` field, which is
 * exactly what this function exists to cross-check.
 */

import { parseSkillMdUrl } from './_shared/skill-md-fetch.ts'
import type { BranchMap, SimSnapshotRow } from './smi5879-simulate-full.types.ts'

/**
 * Re-derive which `unfetchable` subtype a population row belongs to, purely
 * from digest-verified data (the sealed population row plus the sealed
 * branch-resolution map) — never from a report's self-reported fields.
 *
 * - `parseSkillMdUrl(row.repo_url, row.skill_path)` returning `null` means
 *   the row's `repo_url` never resolved to a fetchable target at all →
 *   `'url_parse'` (mirrors `processRow`'s first `unfetchable` return site).
 * - Otherwise, a `branchMap` resolution of `'not-found'`/`'unparseable'` for
 *   the row's `(owner, repo)` means the census already confirmed the repo
 *   itself is gone or its branch-resolution response was structurally
 *   unusable → `'branch_resolution'` (mirrors `processRow`'s second
 *   `unfetchable` return site).
 * - Otherwise the row does not independently re-derive as `unfetchable` at
 *   all → `null`.
 */
export function deriveUnfetchableSubtype(
  row: SimSnapshotRow,
  branchMap: BranchMap
): 'url_parse' | 'branch_resolution' | null {
  const parsed = parseSkillMdUrl(row.repo_url, row.skill_path)
  if (!parsed) return 'url_parse'

  const info = branchMap.get(`${parsed.owner}/${parsed.repo}`)
  if (info && (info.resolution === 'not-found' || info.resolution === 'unparseable')) {
    return 'branch_resolution'
  }

  return null
}
