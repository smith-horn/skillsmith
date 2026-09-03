import { existsSync, readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import { sharedTestConfig, coverageDefaults, coverageThresholds } from './vitest.preset'

// SMI-5617: Detect git-crypt lock state at config load, mirroring the
// gitCryptLocked() sentinel check in vitest.config.root-tests.ts (SMI-4221)
// and the independent reimplementation in scripts/audit-standards.mjs Check
// 47 predicate 5 ("Sentinel pattern mirrors vitest.config.root-tests.ts:
// gitCryptLocked"). dependabot/fork PRs never receive secrets.GIT_CRYPT_KEY
// (SMI-2159), so the `Test (root)` ci.yml job's "Unlock git-crypt" step is
// skipped and supabase/functions/** remains \x00GITCRYPT ciphertext at test
// time. THIS is the config that job (and publish.yml's identical
// `npx vitest run scripts/tests supabase/functions` invocation) loads
// implicitly with no --config flag — vitest.config.root-tests.ts's existing
// guard does not protect either of them. Skip encrypted test paths when
// locked; pre-push and the ci.yml PR matrix's own git-crypt unlock steps run
// first in trusted contexts, so those paths still run there.
function gitCryptLocked(): boolean {
  const sentinel = 'supabase/functions/_shared/cors.ts'
  if (!existsSync(sentinel)) return false
  try {
    const head = readFileSync(sentinel).subarray(0, 9).toString('binary')
    return head.startsWith('\x00GITCRYPT')
  } catch {
    return false
  }
}

const encryptedPathsExcluded = gitCryptLocked() ? ['supabase/functions/**'] : []

export default defineConfig({
  test: {
    ...sharedTestConfig,
    // SMI-6343 Wave 1: `setupFiles` is deliberately NOT redeclared here. It
    // now comes from `sharedTestConfig` (vitest.preset.ts) as an absolute
    // path, so every config inherits the $HOME sandbox. A second declaration
    // at this level would silently OVERRIDE the inherited value rather than
    // merge with it, recreating the exact single-config blind spot SMI-6343
    // was filed for.
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
      // SMI-4777: git worktrees carry their own (potentially encrypted, possibly
      // half-rebased) test trees. They run vitest from inside the worktree, not
      // the main repo. Both the canonical dot-prefix `.worktrees/` and the
      // ad-hoc no-dot `worktrees/` (parallel sessions) are excluded here,
      // mirroring the .prettierignore + ESLint fix from the same wave.
      '.worktrees/**',
      'worktrees/**',
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
      // SMI-4958: the `supabase/functions/indexer/**` exclude was removed —
      // the indexer edge-function tests are vitest-native and now run in the
      // `Test (root)` CI job (git-crypt unlocked, Docker). See ci-reference.md.
      ...encryptedPathsExcluded,
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
