// SMI-3503: Shared vitest preset for consistent settings across all configs.
// Named exports only — no default export to avoid Vitest auto-discovery.
//
// Timeout tiers:
//   - Unit/workspace (this preset): 15s (SMI-3500 contention margin)
//   - Integration (mcp-server): 30s (DB setup/teardown)
//   - E2E: 60s (external services)

import { fileURLToPath } from 'node:url'

// SMI-6343 Wave 1: `vitest.setup.ts` sandboxes $HOME for the whole run so a
// host (non-Docker) test run can never write into the real
// ~/.skillsmith/manifest.json. It lives HERE, in the shared preset, and not
// only in the root vitest.config.ts, because the root config is not the only
// entry point: `packages/mcp-server/vitest.config.integration.ts` is the ONLY
// config (and `test-mcp-server-integration` the only CI job) that runs the two
// files whose leak caused SMI-6343 — and it declared no `setupFiles` at all.
// Eight further configs (colocated, root-tests, vscode, core, cli, enterprise,
// doc-retrieval-mcp, website) were likewise unguarded. Every one of them
// spreads `sharedTestConfig`, so declaring it once here is the only placement
// that actually closes the leak everywhere.
//
// The path MUST be absolute. `setupFiles` resolves relative to each config's
// own `root`, and the per-package configs have different roots — a relative
// './vitest.setup.ts' would resolve to a non-existent
// packages/<pkg>/vitest.setup.ts and silently fail to sandbox anything.
const VITEST_SETUP_FILE = fileURLToPath(new URL('./vitest.setup.ts', import.meta.url))

export const sharedTestConfig = {
  environment: 'node' as const,
  // Cast keeps the outer `as const` from narrowing this to a readonly tuple,
  // which Vitest's `setupFiles?: string | string[]` would reject.
  setupFiles: [VITEST_SETUP_FILE] as string[],
  testTimeout: 15_000,
  hookTimeout: 15_000,
  // SMI-5548: retry ONLY infra/timing errors (matched against the error
  // message) — a timed-out worker, refused/EADDRINUSE port, or a dropped
  // spawn is environmental noise, not a real bug, and the Docker-by-default
  // pre-push route (SMI-5548) made these more visible under container I/O
  // contention. Assertion failures ("expected X to be Y") never match this
  // pattern, so a real bug still fails immediately on the first attempt —
  // this is NOT a blanket retry-everything knob. Applies globally, including
  // CI, since sharedTestConfig is spread by every vitest config.
  retry: {
    count: 1,
    condition: /timed out|timeout|ETIMEDOUT|ECONNREFUSED|EADDRINUSE|EPIPE|spawn/i,
  },
} as const

export const coverageDefaults = {
  provider: 'v8' as const,
  reporter: ['text', 'json', 'html'] as const,
} as const

// Coverage thresholds for per-workspace runs.
// Matches root aggregate thresholds (SMI-1785).
// Individual packages may override if justified.
export const coverageThresholds = {
  lines: 75,
  functions: 75,
  branches: 67,
  statements: 75,
} as const

// Coverage exclude patterns shared across package configs.
// Prevents benchmarks, tree-sitter, telemetry etc. from skewing per-package thresholds.
export const coverageExcludeDefaults = [
  '**/node_modules/**',
  '**/dist/**',
  '**/*.test.ts',
  '**/*.spec.ts',
  '**/tests/**',
  '**/__tests__/**',
  '**/vitest.config.ts',
  '**/vitest.config.*.ts',
  '**/eslint.config.js',
  '**/types.ts',
  '**/types/**',
  '**/index.ts',
  '**/mock*.ts',
  '**/data/**',
  '**/*-types.ts',
  '**/*.types.ts',
  '**/setup.ts',
] as const
