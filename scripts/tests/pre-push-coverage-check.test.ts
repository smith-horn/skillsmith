/**
 * SMI-4772: pre-push hook must invoke vitest via root-level binary path,
 * not `npm --workspace=`. The latter resolves vitest through
 * packages/<pkg>/node_modules/.bin, a SMI-4381 symlink chain that dangles
 * under macOS Docker Desktop virtiofs and exits 234.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(__dirname, '..', 'pre-push-coverage-check.sh')

describe('pre-push-coverage-check.sh — SMI-4772', () => {
  const script = readFileSync(SCRIPT_PATH, 'utf8')

  it('does not reintroduce `npm test --workspace=` for the per-pkg step', () => {
    const lines = script.split('\n')
    const offending = lines.filter(
      (line) =>
        /run_cmd\s+npm\s+test\s+--workspace=/.test(line) ||
        /\$\(run_cmd\s+npm\s+test\s+--workspace=/.test(line)
    )
    expect(offending).toEqual([])
  })

  it('invokes vitest via the relative worktree-root node_modules/.bin path on the host route (USE_DOCKER=0)', () => {
    expect(script).toMatch(/VITEST_BIN="\.\.\/\.\.\/node_modules\/\.bin\/vitest"/)
    expect(script).toMatch(/VITEST_BIN_ROOT="\.\/node_modules\/\.bin\/vitest"/)
  })

  it('invokes vitest via the absolute /app node_modules/.bin path on the Docker route (USE_DOCKER=1) — SMI-5548 virtiofs symlink workaround', () => {
    expect(script).toMatch(/VITEST_BIN="\/app\/node_modules\/\.bin\/vitest"/)
    expect(script).toMatch(/VITEST_BIN_ROOT="\/app\/node_modules\/\.bin\/vitest"/)
  })

  it('preserves the SMI-3502 per-package iteration over WORKSPACES', () => {
    expect(script).toMatch(/WORKSPACES="core cli mcp-server enterprise"/)
    expect(script).toMatch(/for pkg in \$WORKSPACES/)
  })
})
