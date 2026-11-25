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
const RUNNER_PATH = join(__dirname, '..', 'lib', 'pre-push-suite-runner.sh')
const HOOK_PATH = join(__dirname, '..', '..', '.husky', 'pre-push')
const PKG_PATH = join(__dirname, '..', '..', 'package.json')

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
  })

  it('invokes vitest via the absolute /app node_modules/.bin path on the Docker route (USE_DOCKER=1) — SMI-5548 virtiofs symlink workaround', () => {
    expect(script).toMatch(/VITEST_BIN="\/app\/node_modules\/\.bin\/vitest"/)
  })

  it('preserves the SMI-3502 per-package iteration over WORKSPACES', () => {
    expect(script).toMatch(/WORKSPACES="core cli mcp-server enterprise"/)
    expect(script).toMatch(/for pkg in \$WORKSPACES/)
  })

  it('SMI-7218: the root suite is no longer run in pre-push (no root vitest invocation, no VITEST_BIN_ROOT)', () => {
    const code = script.split('\n').filter((l) => !l.trim().startsWith('#'))
    expect(code.filter((l) => /vitest\.config\.root-tests\.ts/.test(l))).toEqual([])
    expect(code.filter((l) => /VITEST_BIN_ROOT/.test(l))).toEqual([])
    // the replacement notice points at the opt-in command
    expect(script).toMatch(/npm run test:root/)
  })
})

describe('pre-push suite runner — SMI-7218 static checks', () => {
  const script = readFileSync(SCRIPT_PATH, 'utf8')
  const lib = readFileSync(RUNNER_PATH, 'utf8')
  const hook = readFileSync(HOOK_PATH, 'utf8')
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8')) as { scripts: Record<string, string> }

  it('the inner timeout --kill-after sits inside the set -m backgrounded job', () => {
    const setM = lib.indexOf('set -m')
    const job = lib.indexOf('( exec "$4" --kill-after=')
    const wait = lib.indexOf('wait "$_vp"')
    expect(setM).toBeGreaterThan(-1)
    expect(job).toBeGreaterThan(setM)
    expect(wait).toBeGreaterThan(job)
    // the job line is backgrounded
    expect(lib).toMatch(/\( exec "\$4" --kill-after="\$\{3\}s" "\$2" bash -c "\$1" \) &/)
  })

  it('the coverage script sources the runner and uses run_suite_timed for the package loop', () => {
    expect(script).toMatch(/pre-push-suite-runner\.sh/)
    expect(script).toMatch(/run_suite_timed "\$pkg"/)
  })

  it('defines the four per-suite budgets', () => {
    expect(budgets()).toEqual({ core: 540, cli: 90, 'mcp-server': 120, enterprise: 60 })
  })

  it('package.json has the opt-in test:root script', () => {
    expect(pkg.scripts['test:root']).toBe('vitest run --config vitest.config.root-tests.ts')
  })

  it('the host backstop covers every budget plus its kill-after, with a startup margin (parsed)', () => {
    const m = hook.match(/COVERAGE_BACKSTOP_SECS=(\d+)\n/)
    expect(m).not.toBeNull()
    const backstop = Number(m![1])
    const killAfter = Number(/SUITE_KILL_AFTER=(\d+)/.exec(lib)![1])
    const b = Object.values(budgets())
    const worst = b.reduce((a, x) => a + x + killAfter, 0)
    // At least 30 s left for docker exec startup and the hook's own work.
    expect(backstop - worst).toBeGreaterThanOrEqual(30)
    expect(b.length).toBe(4)
    expect(hook).toMatch(/timeout "\$COVERAGE_BACKSTOP_SECS" bash/)
    expect(hook).toMatch(/gtimeout "\$COVERAGE_BACKSTOP_SECS" bash/)
  })

  it('the backstop message no longer claims a coverage check or a frozen Docker', () => {
    expect(hook).not.toMatch(/Coverage check timed out/)
    expect(hook).not.toMatch(/Docker is frozen/)
    expect(hook).toMatch(/Test check exceeded its overall/)
    expect(hook).toMatch(/\{\n[\s\S]*?\} \|\| COVERAGE_STATUS=\$\?/)
  })

  function budgets(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const m of lib.matchAll(/^\s+([a-z-]+)\) echo (\d+) ;;$/gm)) out[m[1]] = Number(m[2])
    return out
  }
})
