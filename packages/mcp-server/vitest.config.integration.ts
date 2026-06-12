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
