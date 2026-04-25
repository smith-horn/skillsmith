/**
 * SMI-4462: dedicated vitest config for the @e2e-usage-counter suite.
 *
 * The root vitest.config.ts excludes `tests/e2e/**` from `npm run preflight`
 * (SMI-1312 — E2E tests need staging credentials and seeded fixtures, not
 * present in the unit-test CI matrix). This file flips the include/exclude
 * so the dedicated `npm run test:e2e:usage-counter` script — and the matching
 * GitHub Actions job — can run the suite explicitly.
 */

import { defineConfig } from 'vitest/config'
import { sharedTestConfig } from './vitest.preset'

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
})
