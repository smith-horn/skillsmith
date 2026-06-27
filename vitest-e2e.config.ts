import { defineConfig } from 'vitest/config'
import { sharedTestConfig } from './vitest.preset'

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
    ...sharedTestConfig,
    include: [
      // Root E2E tests (MCP tools tests)
      'tests/e2e/**/*.test.ts',
      // CLI E2E tests
      'packages/cli/tests/e2e/**/*.test.ts',
      'packages/cli/tests/e2e/**/*.e2e.test.ts',
      // MCP server E2E tests
      'packages/mcp-server/tests/e2e/**/*.test.ts',
      'packages/mcp-server/tests/e2e/**/*.e2e.test.ts',
      // SMI-5360: core E2E security suite (SSRF / DNS-rebinding). Run only by the
      // `test:e2e:security` script, which scopes via a positional path. The CLI/
      // MCP runners pass their own dir positional (CLI_TESTS_DIR / MCP_TESTS_DIR),
      // so this entry never widens their runs.
      'packages/core/tests/e2e/**/*.e2e.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 60000, // 60s for E2E (overrides preset 15s)
  },
})
