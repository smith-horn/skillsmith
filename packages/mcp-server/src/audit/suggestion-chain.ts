/**
 * @fileoverview 3-tier rename fall-through chain (SMI-4588 Wave 2 Step 2, PR #2).
 * @module @skillsmith/mcp-server/audit/suggestion-chain
 *
 * Generates up to 3 ordered rename candidates per decision #11:
 *
 *   1. `${author}-${token}`                            (e.g. `anthropic-ship`)
 *   2. `${author}-${packDomain}-${token}`              (e.g. `anthropic-codehelper-ship`)
 *   3. `${author}-${packDomain}-${token}-${shortHash}` (e.g. `anthropic-codehelper-ship-a4f9`)
 *
 * Each candidate is checked against the supplied `existingInventory` — when
 * a candidate collides with another entry's identifier (case-insensitive),
 * the chain advances to the next tier. If all 3 collide, `exhausted: true`
 * and the caller surfaces the chain to the user via `customName`.
 *
 * Inventory contract (plan §1 Edit 7): `existingInventory` is the
 * snapshot **before** the candidate skill is appended. Otherwise the
 * candidate self-collides at tier 1 and cascades unnecessarily. The install
 * pre-flight maintains two inventory views — `existingInventory` for
 * suggestion generation, `augmentedInventory` for `detectCollisions`.
 *
 * `shortHash` derivation: first 4 hex chars of
 *   sha256(`${authorPath}/${token}/${packDomain}`)
 *
 * Birthday-bound collision-free for inventories <10k entries (Wave 0 spike
 * §4 — measured 0% on 36-skill fixture, theoretical bound holds).
 *
 * Plan: docs/internal/implementation/smi-4588-rename-engine-ledger-install.md §1.
 */

import * as crypto from 'node:crypto'

import type { InventoryEntry } from './collision-detector.types.js'
import type { SuggestionChain } from './rename-engine.types.js'

/**
 * Compute the deterministic 4-char `shortHash` suffix used at chain tier 3.
 * Exported for tests; in normal flow callers use `generateSuggestionChain`.
 */
export function computeShortHash(
  authorPath: string,
  token: string,
  packDomain: string | null
): string {
  const input = `${authorPath}/${token}/${packDomain ?? ''}`
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 4)
}

/**
 * Sanitize an author / tag / token segment for safe use in an identifier.
 * Lowercases, replaces non-`[a-z0-9]` runs with `-`, trims, and dedupes
 * consecutive separators. Mirrors the rule in plan §1 step 1.
 */
export function sanitizeSegment(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
}

/**
 * `existingInventory` collides with `candidate` when ANY entry has an
 * identifier that case-insensitively equals `candidate`. The check is
 * O(n) per candidate; chain depth is capped at 3 so worst case is O(3n).
 */
function collides(candidate: string, inventory: ReadonlyArray<InventoryEntry>): boolean {
  const needle = candidate.toLowerCase()
  for (const entry of inventory) {
    if (entry.identifier.toLowerCase() === needle) {
      return true
    }
  }
  return false
}

export interface GenerateSuggestionChainInput {
  /**
   * The colliding entry's base token (e.g. `ship` for `/ship`,
   * `code-helper` for a skill named `code-helper`). Already stripped of
   * any leading `/` for commands; the chain produces a token-only result
   * — formatting back to `/foo` is the apply-path's job.
   */
  token: string
  /**
   * Author segment from manifest. Sanitized inside; pass raw. When
   * `null`/`''`, tier 1 falls through to using the supplied `tagFallback`.
   */
  author: string | null
  /**
   * Pack-domain segment (e.g. `codehelper`). Sanitized inside. When
   * `null`, tier 2 is skipped and tier 3 omits the pack-domain segment.
   */
  packDomain: string | null
  /**
   * Tag fallback when `author` is unavailable. Already-sanitized values
   * are accepted; the function re-sanitizes idempotently.
   */
  tagFallback?: string | null
  /**
   * Repo-relative path used to derive `shortHash` at tier 3. Plan §1 calls
   * for the entry's `source_path` resolved repo-relative; the caller is
   * responsible for the resolution since the rename engine has no concept
   * of "repo root".
   */
  authorPath: string
  /**
   * Pre-candidate inventory snapshot (Edit 7). MUST NOT contain the
   * candidate skill — the chain generator self-collides at tier 1
   * otherwise.
   */
  existingInventory: ReadonlyArray<InventoryEntry>
}

/**
 * Walk the 3-tier rename fall-through chain (decision #11). Returns up to
 * 3 ordered candidates and an `exhausted` flag. The caller picks the first
 * non-colliding candidate as the recommended rename.
 *
 * Returns an empty `candidates` array iff `token` itself sanitizes to an
 * empty string (defensive — pathological inputs).
 */
export function generateSuggestionChain(input: GenerateSuggestionChainInput): SuggestionChain {
  const token = sanitizeSegment(input.token)
  if (token.length === 0) {
    return { candidates: [], exhausted: true }
  }

  const sanitizedAuthor = input.author ? sanitizeSegment(input.author) : ''
  const sanitizedTag = input.tagFallback ? sanitizeSegment(input.tagFallback) : ''
  const prefix = sanitizedAuthor.length > 0 ? sanitizedAuthor : sanitizedTag

  // No usable author OR tag fallback → emit a `local-` prefix at tier 1
  // (matches plan §1's third resolution path). Tiers 2 + 3 also fall back
  // to `local-` since neither author nor packDomain can be derived.
  const tierPrefix = prefix.length > 0 ? prefix : 'local'

  const sanitizedPack = input.packDomain ? sanitizeSegment(input.packDomain) : ''
  const shortHash = computeShortHash(input.authorPath, token, sanitizedPack || null)

  // Tier 1: `${prefix}-${token}`
  const tier1 = `${tierPrefix}-${token}`

  // Tier 2: `${prefix}-${packDomain}-${token}` (skipped when packDomain absent)
  const tier2 = sanitizedPack.length > 0 ? `${tierPrefix}-${sanitizedPack}-${token}` : null

  // Tier 3: `${prefix}-${packDomain}-${token}-${shortHash}`
  // packDomain segment is included only when available.
  const tier3 =
    sanitizedPack.length > 0
      ? `${tierPrefix}-${sanitizedPack}-${token}-${shortHash}`
      : `${tierPrefix}-${token}-${shortHash}`

  // Build the candidate list, dropping any null tier and de-duplicating
  // (tier 2 and tier 3 are identical when packDomain is absent — the dedup
  // ensures the agent doesn't see two equal candidates).
  const rawCandidates = [tier1, tier2, tier3].filter((c): c is string => c !== null)
  const candidates: string[] = []
  for (const c of rawCandidates) {
    if (!candidates.includes(c)) {
      candidates.push(c)
    }
  }

  // Walk the chain — first non-collider wins; if all collide, the chain is
  // exhausted and the agent must escalate via `customName`.
  const exhausted = candidates.every((c) => collides(c, input.existingInventory))

  return { candidates, exhausted }
}
