// SMI-3503: Shared vitest preset for consistent settings across all configs.
// Named exports only — no default export to avoid Vitest auto-discovery.
//
// Timeout tiers:
//   - Unit/workspace (this preset): 15s (SMI-3500 contention margin)
//   - Integration (mcp-server): 30s (DB setup/teardown)
//   - E2E: 60s (external services)

export const sharedTestConfig = {
  globals: true,
  environment: 'node' as const,
  testTimeout: 15_000,
  hookTimeout: 15_000,
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
