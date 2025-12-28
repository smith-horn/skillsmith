/**
 * SMI-631: E2E Test Configuration
 *
 * Separate configuration for E2E tests that require:
 * - Longer timeouts for full workflow testing
 * - Real database and filesystem operations
 * - Network mocking for external APIs
 *
 * Run with: npm run test:e2e
 */

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/tests/e2e/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // E2E tests may take longer
    testTimeout: 30000,
    hookTimeout: 15000,
    // Run tests sequentially to avoid resource conflicts
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Retry failed tests once
    retry: 1,
    // Setup files for E2E environment
    setupFiles: [],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/vitest.config.ts',
        '**/vitest.e2e.config.ts',
      ],
    },
  },
})
