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
  // SMI-4446: .astro / .mdx are first-class implementation surfaces (Astro pages, content collections)
  /^packages\/.*\.(ts|tsx|js|jsx|astro|mdx)$/,
  /^supabase\/functions\/.*\.(ts|js)$/,
  /^scripts\/.*\.(ts|js|mjs)$/,
  // SMI-4243: root-level *.config.{ts,mjs,cjs,js} (vitest.config.ts, lint-staged.config.js, etc.)
  /^[^/]+\.config(\.[^./]+)?\.(ts|mjs|cjs|js)$/,
  // SMI-4243: GitHub Actions workflow YAML
  /^\.github\/workflows\/.*\.ya?ml$/,
  // SMI-4446: narrow .md surfaces — must be specific (broad .md is in DOCS_PATTERNS).
  // Scoped to user-facing/shipping surfaces: package READMEs, skill bodies, root README.
  // Other .md (docs/internal, retros, ADRs) stay classified as docs.
  /^packages\/[^/]+\/README\.md$/,
  /^packages\/mcp-server\/src\/assets\/skills\/.*\/SKILL\.md$/,
  /^README\.md$/,
]

export const TEST_PATTERNS = [/\.test\.(ts|tsx|js)$/, /\.spec\.(ts|tsx|js)$/]

export const DOCS_PATTERNS = [/\.md$/, /^\.claude\//, /^docs\//]
