/**
 * SMI-6033 Wave 4 (Gap 6): shared brand/authority-claim data for the edge scanner
 * @module scripts/indexer/_shared/security-scanner-edge.brand-data (Node port)
 *
 * Extracted out of `supabase/functions/indexer/typosquat.ts` (the Deno
 * indexer's own typosquat port), which previously declared `BRAND_ALIASES`
 * and `AUTHORITY_CLAIMING_AFFIXES` locally — the ONLY consumer at the time
 * was the indexer's own skill-NAME-scanning pipeline
 * (`skill-processor.security.ts`), wired directly to that file, not through
 * this general `_shared/` content-scanning module (see
 * `indexer/typosquat.ts`'s own header for that history). SMI-6033 Wave 4's
 * new `decoy_misdirection` detector (`security-scanner-edge.decoy.ts`) is a
 * CONTENT scanner wired into `scanSkillContent()`'s general orchestration
 * (like `archive_evasion`/`paste_host_fetch`), so it needs to live in
 * `_shared/` — and `_shared/` must never import FROM a specific function's
 * own directory (`indexer/`) the way `indexer/typosquat.ts` previously
 * declared this data locally (the correct import direction is the reverse:
 * `indexer/typosquat.ts` already imports `SecurityFinding` FROM
 * `../_shared/security-scanner-edge.ts`). This module is now the single
 * source of truth both consumers import from — no duplicate copy, closing
 * the same class of drift Wave 1 already fixed once for
 * `CODE_EXECUTION_PATTERNS` (see `security-scanner-edge.patterns.ts`'s header).
 *
 * Kept in sync with `packages/core/src/security/scanner/typosquat.ts`'s
 * `BRAND_ALIASES` / `AUTHORITY_CLAIMING_AFFIXES` exports (parity enforced by
 * behavioral fixture parity, not byte-identity — the two files necessarily
 * differ, same reasoning as `supabase/functions/indexer/typosquat.ts`'s own
 * header). Byte-identical body across BOTH `_shared` twins (Deno-deployed +
 * Node-runnable mirror) — parity test enforces; only the `@module` header
 * line above differs.
 */

/** Kept in sync with `packages/core/src/security/scanner/typosquat.ts`'s `BRAND_ALIASES`. */
export const BRAND_ALIASES: Readonly<Record<string, string>> = {
  anthropic: 'anthropics',
  claude: 'anthropics',
  gemini: 'google-gemini',
  copilot: 'microsoft',
  vercel: 'vercel-labs',
  salesforce: 'SalesforceCommerceCloud',
}

/** Kept in sync with core's `AUTHORITY_CLAIMING_AFFIXES`. */
export const AUTHORITY_CLAIMING_AFFIXES: ReadonlySet<string> = new Set([
  'official',
  'verified',
  'authentic',
  'genuine',
])
