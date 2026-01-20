import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/src/**/*.spec.ts',
      'packages/*/tests/**/*.test.ts',
      'packages/*/tests/**/*.spec.ts',
      'tests/**/*.test.ts',
      // Supabase Edge Functions tests
      'supabase/functions/**/*.test.ts',
      // Script tests
      'scripts/tests/**/*.test.ts',
      // E2E tests excluded from main run - they run in dedicated e2e-tests.yml workflow
      // See SMI-1312: E2E tests require test repos and seeded DB not available in CI
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // SMI-1312: E2E and integration tests require external services (API, DB, test repos)
      // These run in dedicated workflows: e2e-tests.yml
      'tests/e2e/**',
      'tests/api/**',
      '**/*.e2e.test.ts',
      // Website tests require Astro tsconfig which isn't resolvable from root
      // These should run via `npm test -w packages/website` if needed
      'packages/website/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        // Build artifacts and dependencies
        '**/node_modules/**',
        '**/dist/**',

        // Test files
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/tests/**',
        '**/__tests__/**',

        // Configuration files
        '**/vitest.config.ts',
        '**/vitest.config.*.ts',
        '**/eslint.config.js',

        // Type definitions (no runtime logic)
        '**/types.ts',
        '**/types/**',

        // Barrel/re-export files (no testable logic)
        '**/index.ts',

        // Mock data files
        '**/mock*.ts',
        '**/data/**',

        // VS Code extension (requires @vscode/test-electron, not vitest)
        'packages/vscode-extension/**',

        // CLI (tested via integration, not unit)
        'packages/cli/**',

        // Scripts and utilities (not core library code)
        'scripts/**',
        '.claude/**',

        // Supabase Edge Functions (Deno runtime, requires deno test)
        'supabase/**',

        // MCP server utilities (shims, loggers)
        '**/core-shim.ts',
        '**/logger.ts',

        // MCP tools requiring integration tests
        '**/tools/install.ts',
        '**/tools/uninstall.ts',
        '**/webhooks/webhook-endpoint.ts',

        // Core modules requiring complex mocking
        '**/search/hybrid.ts',
        '**/benchmarks/MatrixBenchmark.ts',
        '**/benchmarks/SearchBenchmark.ts',

        // Integration test setup
        '**/setup.ts',
      ],
      thresholds: {
        // SMI-1602 follow-up: Coverage thresholds
        // Current branch coverage: 67.21% - add tests before increasing to 72%
        // See docs/execution/ci-improvement-hive-mind-waves.md for Wave 1 test plan
        lines: 75,
        functions: 75,
        branches: 67,
        statements: 75,
      },
    },
  },
})
