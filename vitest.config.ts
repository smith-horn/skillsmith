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
        // SMI-718: Realistic thresholds for well-tested core code
        lines: 75,
        functions: 75,
        branches: 70,
        statements: 75,
      },
    },
  },
})
