/**
 * Shared file classification patterns (SMI-3540, SMI-3541, SMI-4243).
 *
 * Single source of truth for what counts as "source" vs test vs docs.
 * Consumed by:
 *   - scripts/ci/verify-implementation.ts — `Verify Implementation Completeness` CI check
 *   - scripts/linear-hook.mjs — git post-commit hook that drives Linear status transitions
 *
 * Keep these lists exhaustive for the classification they represent. Drifting
 * these between consumers causes CI/hook divergence (the hook says "no source
 * changes, don't promote" while CI says "pass, has source" or vice versa).
 */

export const SOURCE_PATTERNS = [
  /^packages\/.*\.(ts|tsx|js|jsx)$/,
  /^supabase\/functions\/.*\.(ts|js)$/,
  /^scripts\/.*\.(ts|js|mjs)$/,
  // SMI-4243: root-level *.config.{ts,mjs,cjs,js} (vitest.config.ts, lint-staged.config.js, etc.)
  /^[^/]+\.config(\.[^./]+)?\.(ts|mjs|cjs|js)$/,
  // SMI-4243: GitHub Actions workflow YAML
  /^\.github\/workflows\/.*\.ya?ml$/,
]

export const TEST_PATTERNS = [/\.test\.(ts|tsx|js)$/, /\.spec\.(ts|tsx|js)$/]

export const DOCS_PATTERNS = [/\.md$/, /^\.claude\//, /^docs\//]
