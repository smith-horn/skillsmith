/**
 * SMI-616: Vitest Configuration for Integration Tests
 */

import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
import { sharedTestConfig } from '../../vitest.preset'

export default defineConfig({
  resolve: {
    alias: {
      '@skillsmith/core': resolve(__dirname, '../core/src/index.ts'),
    },
  },
  test: {
    ...sharedTestConfig,
    include: ['tests/integration/**/*.integration.test.ts'],
    testTimeout: 30000, // 30s timeout for integration tests (overrides preset 15s)
    hookTimeout: 30000, // 30s timeout for setup/teardown
    pool: 'forks', // Use forks for better isolation
    poolOptions: {
      forks: {
        singleFork: true, // Run tests sequentially to avoid DB conflicts
      },
    },
  },
})
