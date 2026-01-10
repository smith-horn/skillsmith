import { defineConfig } from 'vitest/config'

/**
 * E2E Test Configuration
 *
 * This config is used by the E2E test runners (run-cli-tests.ts, run-mcp-tests.ts)
 * to avoid the main vitest.config.ts exclude patterns that block *.e2e.test.ts files.
 *
 * SMI-1315: Fix E2E test discovery in CI workflow
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      // Root E2E tests (MCP tools tests)
      'tests/e2e/**/*.test.ts',
      // CLI E2E tests
      'packages/cli/tests/e2e/**/*.test.ts',
      'packages/cli/tests/e2e/**/*.e2e.test.ts',
      // MCP server E2E tests
      'packages/mcp-server/tests/e2e/**/*.test.ts',
      'packages/mcp-server/tests/e2e/**/*.e2e.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 60000,
  },
})
