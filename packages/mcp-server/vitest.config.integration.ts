/**
 * SMI-616: Vitest Configuration for Integration Tests
 */

import { defineConfig } from 'vitest/config'
import { sharedTestConfig } from '../../vitest.preset'

// SMI-5260: no `resolve.alias` for `@skillsmith/core`. The alias pointed at
// `../core/src/index.ts`, which (a) broke collection (`npm run test:integration`
// errored treating the `.ts` as a directory) and (b) split the service and its
// mocked `.io`/install subpaths into two module instances, so `vi.mock` never
// intercepted the service's direct imports. Core resolves through
// `node_modules/@skillsmith/core` → built dist, the same instance the service
// loads, so subpath mocks intercept correctly. Mirrors the working unit
// `vitest.config.ts`, which has no such alias.
// SMI-6343 Wave 1 — THIS FILE IS THE REGRESSION SITE.
//
// `tests/integration/shutdown-persistence.integration.test.ts` and
// `tests/integration/install.execution.integration.test.ts` are the two files
// whose unmocked manifest path historically wrote fixture rows into a real
// user's ~/.skillsmith/manifest.json (before ADR-139/SMI-6274 Wave 4, #2634,
// merged 2026-08-30, added the `manifestPath` override those tests now use —
// two days before this fix, so those two specific files were already
// isolated by the time this investigation started; see
// `scripts/tests/audit-manifest-hygiene.test.ts`'s header for the full
// timeline). This config is the ONLY one that runs them (the root config's
// `exclude` and packages/mcp-server/vitest.config.ts both skip
// `*.integration.test.ts`), and `test-mcp-server-integration` is the only CI
// job that loads it — so a HOME sandbox declared anywhere else does not
// protect them, and it remains the regression site for defense-in-depth
// purposes even though the originally-named leak vector has since closed.
//
// The `...sharedTestConfig` spread below is therefore load-bearing, not
// cosmetic: it is what pulls in `setupFiles` (vitest.preset.ts) and with it
// the $HOME sandbox. Do not replace the spread with hand-copied keys, and do
// not add a local `setupFiles` key — a second declaration overrides the
// inherited one rather than merging, which is precisely how this config ended
// up with no sandbox at all.
export default defineConfig({
  test: {
    ...sharedTestConfig,
    include: ['tests/integration/**/*.integration.test.ts'],
    testTimeout: 30000, // 30s timeout for integration tests (overrides preset 15s)
    hookTimeout: 30000, // 30s timeout for setup/teardown
    pool: 'forks', // Use forks for better isolation
    // SMI-5260: Vitest 4 removed `test.poolOptions`. `maxWorkers: 1` is the
    // migration analog of the prior `poolOptions.forks.singleFork: true` — a
    // single fork runs the suite sequentially, avoiding the in-memory-DB
    // conflicts these integration tests rely on. (Under Vitest 4 the old
    // `singleFork` key was silently ignored, so this restores the intended
    // serialization, not just clears the deprecation warning.)
    maxWorkers: 1,
  },
})
