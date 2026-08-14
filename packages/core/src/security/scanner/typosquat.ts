/**
 * Typosquat / impersonation detector for skill names
 * @module @skillsmith/core/security/scanner/typosquat
 *
 * SMI-595: no Levenshtein-distance / character-substitution / homoglyph
 * name-comparison detector against a popular-skill-name list existed
 * anywhere in this codebase prior to this module — content-based scanning
 * (`SecurityScanner`) cannot catch a name-only impersonation attempt where
 * the skill's actual content is benign (e.g. `anthopic/claude-helper` or
 * `аnthropic/skill` with a Cyrillic `а`).
 *
 * Three independent checks, deliberately NOT conflated:
 *
 *  1. **Exact-skeleton impersonation** — fires ONLY on exact confusable-folded
 *     equality to a reference name, never on substring/affix match. This is a
 *     deliberately narrow rule: `anthropic-community-mcp`, `unofficial-claude-
 *     tools`, `awesome-gemini-skills` are normal, non-malicious community
 *     naming conventions that happen to contain a brand token and must NOT be
 *     blocked by this rule.
 *  2. **Levenshtein edit-distance ≤2** — catches near-miss variants
 *     (`anthropc`, `anthropic1`, `anthropci`) that don't fold to an exact
 *     skeleton match but are still suspiciously close to a reference name.
 *  3. **Authority-claiming affix** — INDEPENDENT of #1: a candidate containing
 *     a reference brand token PLUS an affix that claims official status
 *     (`-official`, `-verified`, `-authentic`, `-genuine`) is flagged
 *     regardless of whether it passes the exact-skeleton check, because the
 *     affix itself is the impersonation vector. Benign functional affixes
 *     (`-mcp`, `-tools`, `-community`) do NOT trigger this — they simply
 *     aren't in the curated affix list.
 *
 * Consumer-surface decision (Wave 1 Step 6): the install-time scanner path
 * (risk-score wiring — see types.ts/weights.ts/SecurityScanner.helpers.ts) is
 * the primary *enforcement* surface (blocks/warns before a skill lands on
 * disk). `skill_audit` (existing MCP tool) is the recommended primary
 * *consumer-facing* surface for on-demand querying of typosquat status on an
 * already-installed skill — live-wiring that tool to this detector is
 * deferred to a filed follow-up (SMI-5711), out of this wave's scope.
 *
 * Integration note: `SecurityScanner.scan()` takes `content` only, not a
 * skill name/author — this wave does NOT change that signature or thread a
 * live reference list through `scripts/skill-scanner/scanner.ts`'s scan
 * pipeline (that would require sourcing real HIGH_TRUST_OWNERS-published
 * skill data and real install-count data, which is a live-data/infra
 * integration, not a detector-design concern). This module is a
 * self-contained, fully-tested unit ready to be wired into that pipeline as a
 * follow-up.
 */

import type { SecurityFinding, TyposquatEnforcementMode } from './types.js'
import { confusableSkeleton } from './confusables.js'

export type { TyposquatEnforcementMode }

// ============================================================================
// Brand aliases (§3)
// ============================================================================

/**
 * Brand names that are NOT derivable from `HIGH_TRUST_OWNERS`' GitHub owner
 * slugs (`signal-of-intent.ts`) or from the installed-skill corpus at all —
 * the product/brand a typosquat would actually target (`anthropic`, `claude`,
 * `gemini`) differs from the GitHub org slug that publishes it (`anthropics`,
 * `google-gemini`). Folded into the reference list
 * (`typosquat-reference-list.ts`) as bare-brand reference entries, and also
 * used as the curated "brand token" corpus for the authority-claiming-affix
 * check below (§1 rule 3) — a narrower, independent check from the
 * exact-skeleton rule (§1 rule 1).
 *
 * Values cross-checked against `HIGH_TRUST_OWNERS`
 * (`packages/core/src/scripts/github-import/signal-of-intent.ts`) — kept in
 * sync manually, same convention as that file's own documented
 * cross-boundary-import constraint.
 */
export const BRAND_ALIASES: Readonly<Record<string, string>> = {
  anthropic: 'anthropics',
  claude: 'anthropics',
  gemini: 'google-gemini',
  copilot: 'microsoft',
  vercel: 'vercel-labs',
  salesforce: 'SalesforceCommerceCloud',
}

// ============================================================================
// Authority-claiming affixes (§1 rule 3 / Change #5)
// ============================================================================

/**
 * A small, curated "claims official status" affix list. Deliberately narrow —
 * benign functional affixes (`mcp`, `tools`, `community`, `helper`, ...)
 * simply aren't in this list, so they never trigger this check.
 *
 * SMI-6033 Wave 1 (Gap 6): exported (was module-private) so the decoy/
 * misdirection detector (`SecurityScanner.decoy.ts`, Wave 4) can reuse the
 * same curated affix corpus rather than duplicating it.
 */
export const AUTHORITY_CLAIMING_AFFIXES: ReadonlySet<string> = new Set([
  'official',
  'verified',
  'authentic',
  'genuine',
])

/** Minimum reference-name length considered for the Levenshtein check (§1 rule 2).
 *  Guards against noisy false positives on very short brand tokens where an
 *  edit distance of 2 covers a large fraction of unrelated short words. */
const MIN_LEVENSHTEIN_REFERENCE_LENGTH = 6

/** Maximum Levenshtein edit distance considered a typosquat variant. */
const MAX_LEVENSHTEIN_DISTANCE = 2

// ============================================================================
// Folding / tokenization helpers
// ============================================================================

/**
 * Fold a candidate/reference name through the confusable-skeleton map, then
 * NFKC, then lowercase — the comparison key used by the exact-skeleton and
 * Levenshtein checks (§1 rules 1 and 2).
 */
function foldSkillName(raw: string): string {
  return confusableSkeleton(raw).normalize('NFKC').toLowerCase()
}

/** Split a name into lowercase alphanumeric tokens on any separator. */
function tokenize(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length > 0)
}

// ============================================================================
// Levenshtein distance
// ============================================================================

/**
 * Standard iterative-DP Levenshtein edit distance (insertion/deletion/
 * substitution). Inputs here are short skill-name strings, so an O(n*m) table
 * is more than fast enough — no early-exit optimization needed.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0
  const aLen = a.length
  const bLen = b.length
  if (aLen === 0) return bLen
  if (bLen === 0) return aLen

  let prevRow = new Array<number>(bLen + 1)
  let currRow = new Array<number>(bLen + 1)
  for (let j = 0; j <= bLen; j++) prevRow[j] = j

  for (let i = 1; i <= aLen; i++) {
    currRow[0] = i
    for (let j = 1; j <= bLen; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      currRow[j] = Math.min(
        prevRow[j] + 1, // deletion
        currRow[j - 1] + 1, // insertion
        prevRow[j - 1] + cost // substitution
      )
    }
    ;[prevRow, currRow] = [currRow, prevRow]
  }

  return prevRow[bLen]
}

// ============================================================================
// Detector
// ============================================================================

/**
 * Run all three checks against a single candidate skill name/id. Returns
 * RAW findings (uncapped severity) — callers apply
 * `applyTyposquatEnforcementMode()` before surfacing them, per the
 * `typosquatEnforcementMode` rollout config (§6).
 *
 * `referenceNames` should already be lowercase (as produced by
 * `buildTyposquatReferenceList()` in `typosquat-reference-list.ts`).
 */
export function scanTyposquat(
  candidateName: string,
  referenceNames: ReadonlySet<string>
): SecurityFinding[] {
  const findings: SecurityFinding[] = []
  const candidateLower = candidateName.toLowerCase()
  const foldedCandidate = foldSkillName(candidateName)

  // ---- Rule 1: exact-skeleton impersonation --------------------------------
  // Fires ONLY when folding changed something meaningful (a confusable
  // substitution / fullwidth / math-alphanumeric fold occurred) AND the
  // folded form exactly equals a reference name. A candidate whose lowercase
  // form already equals the reference (pure case difference, or the
  // candidate IS the reference) is not an impersonation attempt.
  for (const reference of referenceNames) {
    if (foldedCandidate === reference && candidateLower !== reference) {
      findings.push({
        type: 'typosquat',
        severity: 'critical',
        confidence: 'high',
        message: `Skill name folds to the same confusable-skeleton as a well-known reference name ("${reference}") but is not byte-identical to it.`,
        location: candidateName,
        category: 'typosquat:impersonation-exact-skeleton',
      })
      break
    }
  }

  // ---- Rule 2: Levenshtein edit-distance <= 2 ------------------------------
  // Skipped once rule 1 already fired for this candidate (distance 0 in
  // folded space is rule 1's job, not rule 2's — no double-counting).
  if (findings.length === 0) {
    for (const reference of referenceNames) {
      if (reference.length < MIN_LEVENSHTEIN_REFERENCE_LENGTH) continue
      // Cheap length-delta pre-filter before the O(n*m) DP.
      if (Math.abs(foldedCandidate.length - reference.length) > MAX_LEVENSHTEIN_DISTANCE) continue
      const distance = levenshteinDistance(foldedCandidate, reference)
      if (distance > 0 && distance <= MAX_LEVENSHTEIN_DISTANCE) {
        findings.push({
          type: 'typosquat',
          severity: 'high',
          confidence: 'medium',
          message: `Skill name is an edit-distance-${distance} variant of a well-known reference name ("${reference}").`,
          location: candidateName,
          category: 'typosquat:levenshtein',
        })
        break
      }
    }
  }

  // ---- Rule 3: authority-claiming affix (independent of rule 1) -----------
  const tokens = tokenize(candidateName)
  const hasBrandToken = tokens.some((t) => Object.prototype.hasOwnProperty.call(BRAND_ALIASES, t))
  const hasAuthorityAffix = tokens.some((t) => AUTHORITY_CLAIMING_AFFIXES.has(t))
  if (hasBrandToken && hasAuthorityAffix) {
    findings.push({
      type: 'typosquat',
      severity: 'critical',
      confidence: 'high',
      message: `Skill name combines a known brand token with an affix that claims official/verified status.`,
      location: candidateName,
      category: 'typosquat:authority-affix',
    })
  }

  return findings
}

// ============================================================================
// Enforcement mode (§6)
// ============================================================================

/** SMI-595: default rollout mode — shadow mode, matching the
 *  `concurrency-audit-pr.yml` precedent (shadow for a period, then promote). */
export const DEFAULT_TYPOSQUAT_ENFORCEMENT_MODE: TyposquatEnforcementMode = 'warn'

/** Resolve the effective enforcement mode, applying the default when unset. */
export function resolveTyposquatEnforcementMode(
  mode?: TyposquatEnforcementMode
): TyposquatEnforcementMode {
  return mode ?? DEFAULT_TYPOSQUAT_ENFORCEMENT_MODE
}

const DOWNGRADE_TO_MEDIUM: ReadonlySet<SecurityFinding['severity']> = new Set(['high', 'critical'])

/**
 * Apply the rollout mode to raw typosquat findings:
 * - `off`   — discard all findings.
 * - `warn`  — cap severity at `medium` regardless of the raw detector's
 *   confidence (confidence is left untouched — only severity is capped).
 * - `block` — pass findings through at their raw severity.
 */
export function applyTyposquatEnforcementMode(
  findings: SecurityFinding[],
  mode: TyposquatEnforcementMode = DEFAULT_TYPOSQUAT_ENFORCEMENT_MODE
): SecurityFinding[] {
  if (mode === 'off') return []
  if (mode === 'warn') {
    return findings.map((finding) =>
      DOWNGRADE_TO_MEDIUM.has(finding.severity) ? { ...finding, severity: 'medium' } : finding
    )
  }
  return findings
}

/**
 * Convenience one-shot: detect + apply the enforcement mode in a single call.
 */
export function detectTyposquat(
  candidateName: string,
  referenceNames: ReadonlySet<string>,
  mode: TyposquatEnforcementMode = DEFAULT_TYPOSQUAT_ENFORCEMENT_MODE
): SecurityFinding[] {
  return applyTyposquatEnforcementMode(scanTyposquat(candidateName, referenceNames), mode)
}
