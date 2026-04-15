// SMI-3502: Config for tests that aren't in any workspace's vitest.config.ts.
// Used by pre-push hook to run root-level tests and colocated src/ tests
// without re-running workspace tests/ directories.
// Colocated src/ tests are here (not in package configs) because adding them
// to core's config caused CI OOM (147 files vs 120 with memory benchmarks).
import { existsSync, readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import { sharedTestConfig } from './vitest.preset'

// SMI-4221: Detect git-crypt lock state at config load. If a known-encrypted
// sentinel file starts with the git-crypt magic header (\x00GITCRYPT), the
// working tree is locked here — typical of a vanilla CI checkout without the
// git-crypt key (e.g. post-merge-verify.yml). Skip encrypted test paths in
// that case. Pre-push and ci.yml PR matrix both unlock first, so those paths
// still run there. Ref: SMI-4221, SMI-2672.
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
    include: [
      // Root-level tests
      'scripts/tests/**/*.test.ts',
      'supabase/functions/**/*.test.ts',
      // Colocated package tests (src/**/*.test.ts, src/**/*.spec.ts)
      // These are in root config but not in per-package configs
      'packages/*/src/**/*.test.ts',
      'packages/*/src/**/*.spec.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'supabase/functions/indexer/**',
      // In locked CI checkouts, supabase/** is git-crypt ciphertext.
      // Pre-push and ci.yml matrix decrypt. Refs: SMI-4221, SMI-2672.
      ...encryptedPathsExcluded,
      // Website tests require Astro tsconfig
      'packages/website/**',
      // VS Code integration tests require the `vscode` module — run via @vscode/test-electron
      'packages/vscode-extension/src/__tests__/integration/**',
    ],
  },
})
