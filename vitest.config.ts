import { defineConfig } from 'vitest/config'
import { sharedTestConfig, coverageDefaults, coverageThresholds } from './vitest.preset'

export default defineConfig({
  test: {
    ...sharedTestConfig,
    setupFiles: ['./vitest.setup.ts'],
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
      // Integration tests (*.int.test.ts) run via @vscode/test-electron on host
      // (SMI-4194). ADR-109: vitest.config.ts is an infra trigger path; this change
      // was covered by the implementation plan at docs/internal/implementation/vscode-mcp-parity.md.
      // See packages/vscode-extension/README.md Testing section.
      '**/*.int.test.ts',
      // Website tests require Astro tsconfig which isn't resolvable from root
      // These should run via `npm test -w packages/website` if needed
      'packages/website/**',
      // Indexer edge function tests require Deno runtime + git-crypt unlocked.
      // Source files (e.g. high-trust-authors.ts) are git-crypt encrypted —
      // esbuild cannot transform encrypted binary blobs in CI without keys.
      // Run locally with git-crypt unlocked, or via deno test.
      'supabase/functions/indexer/**',
    ],
    coverage: {
      ...coverageDefaults,
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

        // Benchmark harnesses (require runtime setup, not unit-testable)
        '**/benchmarks/IndexBenchmark.ts',
        '**/benchmarks/SearchBenchmark.ts',
        '**/benchmarks/embeddingBenchmark.ts',
        '**/benchmarks/cacheBenchmark.ts',
        '**/benchmarks/BenchmarkRunner.ts',
        '**/benchmarks/MemoryProfiler.ts',
        '**/benchmarks/cli.ts',
        '**/benchmarks/memory/**',

        // Telemetry exporter (requires Prometheus infrastructure)
        '**/telemetry/prometheus.ts',

        // VS Code activation (requires VS Code API)
        'packages/core/src/activation/ActivationManager.ts',

        // Tree-sitter manager (still WASM-load-dependent; not unit-covered).
        // SMI-4293: pythonIncremental / pythonExtractor / queries/python.ts
        // are covered by dedicated tests and are intentionally NOT excluded.
        '**/analysis/tree-sitter/manager.ts',

        // Barrel re-export directories (no testable logic, verified pure re-exports)
        '**/exports/**',

        // Type-only files (no runtime logic, just TypeScript interfaces/types)
        '**/*-types.ts',
        '**/*.types.ts',

        // Integration test setup
        '**/setup.ts',
      ],
      thresholds: {
        ...coverageThresholds,
      },
    },
  },
})
