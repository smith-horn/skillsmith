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

  it('invokes vitest via the worktree-root node_modules/.bin path', () => {
    expect(script).toMatch(/\.\.\/\.\.\/node_modules\/\.bin\/vitest\s+run/)
  })

  it('preserves the SMI-3502 per-package iteration over WORKSPACES', () => {
    expect(script).toMatch(/WORKSPACES="core cli mcp-server enterprise"/)
    expect(script).toMatch(/for pkg in \$WORKSPACES/)
  })
})
