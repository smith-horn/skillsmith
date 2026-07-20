/**
 * Shared file classification patterns (SMI-3540, SMI-3541, SMI-4243).
 *
 * Single source of truth for what counts as "source" vs test vs docs.
 * Consumed by:
 *   - scripts/ci/verify-implementation.ts — the `PR Validation (Node)` CI check (SMI-4924)
 *   - scripts/linear-hook.mjs — git post-commit hook that drives Linear status transitions
 *
 * Keep these lists exhaustive for the classification they represent. Drifting
 * these between consumers causes CI/hook divergence (the hook says "no source
 * changes, don't promote" while CI says "pass, has source" or vice versa).
 */

export const SOURCE_PATTERNS = [
  // SMI-4446: .astro / .mdx are first-class implementation surfaces (Astro pages, content collections)
  // SMI-5767: mjs|cjs added — packages/**/*.config.mjs (e.g. astro.config.mjs) and other
  // ESM/CJS-extension source files were previously misclassified as "no source changes"
  /^packages\/.*\.(ts|tsx|js|jsx|mjs|cjs|astro|mdx)$/,
  // SMI-5603: apps/ (e.g. apps/api-proxy) is a first-class implementation surface
  // SMI-5767: mjs|cjs added for parity with packages/ above (no live apps/ files affected
  // today, but the same misclassification risk applies the moment one is added)
  /^apps\/.*\.(ts|tsx|js|jsx|mjs|cjs)$/,
  /^supabase\/functions\/.*\.(ts|js)$/,
  /^scripts\/.*\.(ts|js|mjs|sh)$/,
  // SMI-5627: extensionless git-hook files under .husky/ (post-merge,
  // pre-commit, pre-push, …) are first-class implementation surfaces.
  // `[^/.]+` deliberately rejects subdirectories (.husky/_/** generated
  // wrappers) and any file WITH an extension.
  /^\.husky\/[^/.]+$/,
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

// SMI-5767: mjs|cjs added alongside SOURCE_PATTERNS' mjs|cjs support above — without this,
// a *.test.mjs/*.spec.cjs file would match SOURCE_PATTERNS as "source" and NOT match here as
// "test", so EXCLUDED_FROM_SOURCE (verify-implementation.ts) wouldn't exclude it: a test-only
// change would misclassify as a real source change.
export const TEST_PATTERNS = [/\.test\.(ts|tsx|js|mjs|cjs)$/, /\.spec\.(ts|tsx|js|mjs|cjs)$/]

export const DOCS_PATTERNS = [/\.md$/, /^\.claude\//, /^docs\//]
