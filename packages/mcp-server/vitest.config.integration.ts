/**
 * SMI-616: Vitest Configuration for Integration Tests
 */

import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@skillsmith/core': resolve(__dirname, '../core/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.integration.test.ts'],
    testTimeout: 30000, // 30s timeout for integration tests
    hookTimeout: 30000, // 30s timeout for setup/teardown
    pool: 'forks', // Use forks for better isolation
    poolOptions: {
      forks: {
        singleFork: true, // Run tests sequentially to avoid DB conflicts
      },
    },
  },
});
