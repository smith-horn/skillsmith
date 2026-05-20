/**
 * SMI-4462: dedicated vitest config for the @e2e-usage-counter suite.
 *
 * The root vitest.config.ts excludes `tests/e2e/**` from `npm run preflight`
 * (SMI-1312 — E2E tests need staging credentials and seeded fixtures, not
 * present in the unit-test CI matrix). This file flips the include/exclude
 * so the dedicated `npm run test:e2e:usage-counter` script — and the matching
 * GitHub Actions job — can run the suite explicitly.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { sharedTestConfig } from './vitest.preset'

// SMI-4972: project is "type": "module" (ESM); __dirname is not native.
const here = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    ...sharedTestConfig,
    // E2E tests provision real staging users and wait on RPC commits — give
    // them more headroom than the unit-test default.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: [
      'tests/e2e/cli/**/*.e2e.test.ts',
      'tests/e2e/mcp/**/*.e2e.test.ts',
      'tests/e2e/website/**/*.e2e.test.ts',
      'tests/e2e/api/**/*.e2e.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Each spec provisions its own user; sequential keeps staging tidy and
    // avoids racing the auth.users insert quota.
    fileParallelism: false,
  },
  // SMI-4972: route @skillsmith/<pkg> imports to the WORKTREE's built dist,
  // not main's via the node_modules symlink (SMI-4377). Without this, E2E
  // from a worktree silently exercises main's package code while claiming
  // to verify worktree edits. dist/ not src/ because consumers import the
  // built artifact; alias short-circuits vitest's transform pipeline so
  // src/ access would require a relative import.
  //
  // Explicit per-package map (NOT regex + $1 — plan-review E-1):
  // Rollup/Vite alias's string `replacement` does not interpolate regex
  // capture groups. Only the three packages with `main: ./dist/src/index.js`
  // need aliasing. cli/website/vscode-extension/doc-retrieval-mcp are NOT
  // imported as `@skillsmith/<pkg>` by any E2E test (confirmed by
  // `grep -rn "from '@skillsmith/" tests/e2e/`).
  //
  // Subpath exports (`@skillsmith/core/errors`) do NOT match these keys
  // and fall through to node_modules resolution — i.e., to main's dist.
  // Today zero such imports exist in tests/e2e/ (plan-review E-4). If
  // future E2E tests add them, this map must be extended.
  resolve: {
    alias: {
      '@skillsmith/core': path.resolve(here, 'packages/core/dist/src/index.js'),
      '@skillsmith/mcp-server': path.resolve(here, 'packages/mcp-server/dist/src/index.js'),
      '@skillsmith/enterprise': path.resolve(here, 'packages/enterprise/dist/src/index.js'),
    },
  },
})
