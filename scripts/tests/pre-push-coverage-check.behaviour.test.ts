/**
 * SMI-7218: behaviour tests for scripts/lib/pre-push-suite-runner.sh using stub
 * suites (never real vitest). Runs the HOST route (USE_DOCKER=0, run_cmd runs
 * locally), which needs GNU `timeout` (or `gtimeout`) on the test machine.
 * SKILLSMITH_PRE_PUSH_KILL_AFTER_SECS is a test-only knob shortening the
 * TERM->KILL grace so each case stays fast.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RUNNER = join(__dirname, '..', 'lib', 'pre-push-suite-runner.sh')

const hasTimeout = ['timeout', 'gtimeout'].some(
  (b) => spawnSync('sh', ['-c', `command -v ${b}`]).status === 0
)

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) {
    // best-effort cleanup of any stragglers a failing test left behind
    for (const f of existsSync(d) ? readdirSync(d) : []) {
      if (f.endsWith('.pids')) {
        for (const pid of readFileSync(join(d, f), 'utf8').split(/\s+/).filter(Boolean)) {
          try {
            process.kill(Number(pid), 'SIGKILL')
          } catch {
            /* already gone */
          }
        }
      }
    }
    rmSync(d, { recursive: true, force: true })
  }
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    // a zombie is dead for our purposes
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z'
  } catch {
    return true
  }
}

function pidsOf(file: string): number[] {
  return existsSync(file) ? readFileSync(file, 'utf8').split(/\s+/).filter(Boolean).map(Number) : []
}

interface Run {
  status: number | null
  out: string
  wallMs: number
  pidFile: string
  failed: string
}

/** Drives run_suite_timed for one stub; `stub` may reference $PIDFILE. */
function runStub(stub: string, env: Record<string, string> = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), 'prepush-suite-'))
  dirs.push(dir)
  const pidFile = join(dir, 'a.pids')
  const driver = join(dir, 'driver.sh')
  writeFileSync(
    driver,
    `#!/usr/bin/env bash
USE_DOCKER=0
run_cmd() { "$@"; }
. "${RUNNER}"
FAILED_PACKAGES=""
init_suite_budgets
run_suite_timed stubpkg "$STUB"
echo "RC=$?"
echo "FAILED=[$FAILED_PACKAGES]"
echo "TIMED=[$TIMED_OUT_PACKAGES]"
echo "SUGGESTED=$SUITE_SUGGESTED_BUDGET"
`
  )
  const t0 = Date.now()
  const r = spawnSync('bash', [driver], {
    encoding: 'utf8',
    env: { ...process.env, STUB: stub, PIDFILE: pidFile, ...env },
    timeout: 60_000,
  })
  const out = `${r.stdout}${r.stderr}`
  return {
    status: r.status,
    out,
    wallMs: Date.now() - t0,
    pidFile,
    failed: /FAILED=\[(.*)\]/.exec(out)?.[1] ?? '',
  }
}

const FAST = { SKILLSMITH_PRE_PUSH_KILL_AFTER_SECS: '1' }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!hasTimeout)('pre-push suite runner — SMI-7218 behaviour (host route)', () => {
  it('a: a fast passing suite passes and prints elapsed seconds', () => {
    const r = runStub('exit 0', FAST)
    expect(r.out).toMatch(/✓ packages\/stubpkg passed \(\d+s\)/)
    expect(r.out).toContain('RC=0')
    expect(r.failed).toBe('')
  })

  it('b: a failing suite is a failure, not a timeout, and its output is shown', () => {
    const r = runStub('echo SUITE-OUTPUT-MARKER; exit 1', FAST)
    expect(r.out).toContain('RC=1')
    expect(r.out).toMatch(/✗ packages\/stubpkg failed \(exit 1/)
    expect(r.out).toContain('SUITE-OUTPUT-MARKER')
    expect(r.out).not.toMatch(/exceeded its/)
    // A real failure must not suggest a bigger budget.
    expect(r.out).not.toMatch(/SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS=\d+ git push/)
    expect(r.out).toContain('TIMED=[]')
    expect(r.failed).toBe(' stubpkg')
  })

  it('c: a suite sleeping past its budget times out, fails, and leaves zero survivors', async () => {
    const r = runStub('echo $$ >> "$PIDFILE"; sleep 60 & echo $! >> "$PIDFILE"; wait', {
      ...FAST,
      SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS: '2',
    })
    expect(r.out).toMatch(/⏱ {2}packages\/stubpkg exceeded its 2s budget \(timed out; killed\)/)
    // SMI-7218 done-when: a timeout names a cause and an escape narrower than
    // --no-verify, and the escape is valid and actually raises the budget.
    expect(r.out).toMatch(
      /^ {5}Cause: the suite hung, or the machine is busy enough to slow it past the budget\.$/m
    )
    const hint = /^ {7}SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS=(\d+) git push$/m.exec(r.out)
    expect(hint).not.toBeNull()
    const suggested = Number(hint![1])
    expect(suggested).toBeGreaterThan(2) // the 2 s budget that timed out
    expect(suggested).toBeLessThanOrEqual(99999)
    expect(r.out).toContain(`SUGGESTED=${suggested}`)
    expect(r.out).toContain('TIMED=[ stubpkg]')
    expect(r.out).not.toMatch(/--no-verify/)
    expect(r.out).not.toMatch(/✗ packages\/stubpkg failed/)
    expect(r.failed).toBe(' stubpkg')
    expect(r.wallMs).toBeLessThan(8_000)
    await sleep(300)
    const pids = pidsOf(r.pidFile)
    expect(pids.length).toBe(2)
    expect(pids.filter(alive)).toEqual([])
  })

  it('d: a TERM-ignoring child is killed by --kill-after within budget + kill-after + 2s', async () => {
    const r = runStub(
      `trap '' TERM; echo $$ >> "$PIDFILE"; ( trap '' TERM; echo $BASHPID >> "$PIDFILE"; exec sleep 60 ) & wait`,
      { ...FAST, SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS: '2' }
    )
    expect(r.out).toMatch(/exceeded its 2s budget/)
    expect(r.wallMs).toBeLessThan((2 + 1 + 2) * 1000 + 3_000)
    await sleep(300)
    const pids = pidsOf(r.pidFile)
    expect(pids.length).toBe(2)
    expect(pids.filter(alive)).toEqual([])
  })

  it('e: a grandchild that outlives its parent on a normal exit is swept by the group kill', async () => {
    const r = runStub('sleep 60 >/dev/null 2>&1 & echo $! >> "$PIDFILE"; exit 0', FAST)
    expect(r.out).toContain('RC=0')
    expect(r.out).toMatch(/✓ packages\/stubpkg passed/)
    await sleep(300)
    const pids = pidsOf(r.pidFile)
    expect(pids.length).toBe(1)
    expect(pids.filter(alive)).toEqual([])
  })

  it('f: an invalid budget override warns and the defaults are used', () => {
    const r = runStub('exit 0', { ...FAST, SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS: 'abc' })
    expect(r.out).toMatch(/SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS='abc' is not a positive integer/)
    expect(r.out).not.toMatch(/gets a \d+s budget/)
    expect(r.out).toContain('RC=0')
  })

  it('g: a valid override is applied and announced once', () => {
    const r = runStub('exit 0', { ...FAST, SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS: '2' })
    const hits = r.out.match(/every suite gets a 2s budget/g) ?? []
    expect(hits.length).toBe(1)
    expect(r.out).toContain('RC=0')
  })

  it('h: zero and negative overrides are rejected as invalid', () => {
    for (const bad of ['0', '-5', '1.5', '', '100000', '999999999999999999999']) {
      const r = runStub('exit 0', { ...FAST, SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS: bad })
      expect(r.out).not.toMatch(/every suite gets a/)
      if (bad !== '') expect(r.out).toMatch(/is not a positive integer of at most 5 digits/)
    }
  })

  it('i: SKILLSMITH_PRE_PUSH_NO_PG_SWEEP=1 is a plain invocation with no inner timeout', () => {
    const r = runStub('sleep 3; exit 0', {
      ...FAST,
      SKILLSMITH_PRE_PUSH_NO_PG_SWEEP: '1',
      SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS: '1',
    })
    // a 1s budget would have timed the 3s stub out if a timeout wrapped it
    expect(r.out).toContain('RC=0')
    expect(r.out).not.toMatch(/exceeded its/)
    expect(r.out).toMatch(/NO_PG_SWEEP=1: suites run plainly/)
    expect(r.out).not.toMatch(/SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS=\d+ git push/)
  })

  it('l: a suite that exits 124 on its own, well inside its budget, is a failure with no budget hint', () => {
    const r = runStub('exit 124', FAST)
    expect(r.out).toContain('RC=124')
    expect(r.out).toMatch(/✗ packages\/stubpkg failed \(exit 124/)
    expect(r.out).not.toMatch(/exceeded its/)
    expect(r.out).not.toMatch(/SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS=\d+ git push/)
    expect(r.out).toContain('TIMED=[]')
    expect(r.out).toContain('SUGGESTED=0')
  })

  it('m: suggest_budget doubles, caps at 99999, and prints nothing when it cannot raise the budget', () => {
    const run = (b: string) =>
      spawnSync('bash', ['-c', `. "${RUNNER}"; suggest_budget ${b}`], { encoding: 'utf8' }).stdout
    expect(run('2')).toBe('4\n')
    expect(run('540')).toBe('1080\n')
    expect(run('49999')).toBe('99998\n')
    expect(run('50000')).toBe('99999\n')
    expect(run('99998')).toBe('99999\n')
    expect(run('99999')).toBe('')
  })

  it('n: the failure summary names timed-out suites and puts the override before --no-verify', () => {
    const summary = (failed: string, timed: string, suggested: string) =>
      spawnSync(
        'bash',
        [
          '-c',
          `. "${RUNNER}"; FAILED_PACKAGES="${failed}"; TIMED_OUT_PACKAGES="${timed}"; SUITE_SUGGESTED_BUDGET=${suggested}; print_failure_summary "P " V`,
        ],
        { encoding: 'utf8' }
      ).stdout
    const mixed = summary(' core cli', ' cli', '180').split('\n')
    expect(mixed).toEqual([
      '❌ Tests failed in packages/core!',
      '   Run: P bash -c "cd packages/core && V run"',
      '⏱  packages/cli timed out (budget exceeded)',
      '   Run: P bash -c "cd packages/cli && V run"',
      '',
      '   If a timed-out suite is only slow: SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS=180 git push',
      '   Last resort, skipping every pre-push check: git push --no-verify',
      '',
    ])
    const plain = summary(' core', '', '0')
    expect(plain).not.toMatch(/SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS/)
    expect(plain).toContain('   Bypass: git push --no-verify')
    // A timeout with no useful suggestion (budget already at the cap) names no override.
    expect(summary(' core', ' core', '0')).not.toMatch(/SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS/)
  })

  it('o: the hook backstop message, executed under sh: cause, a valid larger override, then last resort', () => {
    const hook = readFileSync(join(__dirname, '..', '..', '.husky', 'pre-push'), 'utf8')
    const block = /# >>> backstop-message[^\n]*\n([\s\S]*?)# <<< backstop-message/.exec(hook)
    expect(block).not.toBeNull()
    const msg = (status: number, override?: string) => {
      const env: Record<string, string> = { PATH: process.env['PATH'] ?? '/usr/bin:/bin' }
      if (override !== undefined) env['SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS'] = override
      const r = spawnSync(
        'sh',
        ['-e', '-c', `COVERAGE_STATUS=${status}; COVERAGE_BACKSTOP_SECS=930\n${block![1]}`],
        { encoding: 'utf8', env }
      )
      return { status: r.status, out: r.stdout }
    }
    const fired = msg(124)
    expect(fired.status).toBe(1)
    expect(fired.out).toMatch(/Test check exceeded its overall 930s backstop/)
    const lines = fired.out.split('\n')
    const narrow = lines.indexOf('     SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS=1080 git push')
    const broad = lines.indexOf(
      '   Last resort, skipping every pre-push check: git push --no-verify'
    )
    expect(narrow).toBeGreaterThan(-1)
    expect(broad).toBeGreaterThan(narrow)
    expect(fired.out).not.toMatch(/Bypass:/)
    expect(msg(124, '600').out).toContain('SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS=1200 git push')
    expect(msg(124, '70000').out).toContain('SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS=99999 git push')
    const capped = msg(124, '99999')
    expect(capped.out).not.toMatch(/SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS=\d+ git push/)
    expect(capped.out).toContain('Last resort, skipping every pre-push check')
    const failed = msg(1)
    expect(failed.status).toBe(1)
    expect(failed.out).toBe('')
    const passed = msg(0)
    expect(passed.status).toBe(0)
    expect(passed.out).toBe('')
  })

  it('i2: without NO_PG_SWEEP the plain-run notice is not printed (paired control)', () => {
    const r = runStub('exit 0', FAST)
    expect(r.out).toContain('RC=0')
    expect(r.out).not.toMatch(/suites run plainly/)
  })

  it('j: a quick SIGKILL (OOM-shaped 137) well inside the budget is a failure, not a timeout', () => {
    const r = runStub('kill -KILL $$', FAST)
    expect(r.out).toContain('RC=137')
    expect(r.out).toMatch(/✗ packages\/stubpkg failed \(exit 137/)
    expect(r.out).not.toMatch(/exceeded its/)
  })

  it('k: the hook backstop follows a valid override and ignores an invalid one (block executed under sh)', () => {
    const hook = readFileSync(join(__dirname, '..', '..', '.husky', 'pre-push'), 'utf8')
    const block = /# >>> backstop[^\n]*\n([\s\S]*?)# <<< backstop/.exec(hook)
    expect(block).not.toBeNull()
    const backstop = (override?: string) => {
      const env: Record<string, string> = { PATH: process.env['PATH'] ?? '/usr/bin:/bin' }
      if (override !== undefined) env['SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS'] = override
      const r = spawnSync(
        'sh',
        ['-e', '-c', `${block![1]}\nprintf '%s' "$COVERAGE_BACKSTOP_SECS"`],
        {
          encoding: 'utf8',
          env,
        }
      )
      expect(r.status).toBe(0)
      return Number(r.stdout)
    }
    expect(backstop()).toBe(930)
    expect(backstop('200')).toBe(4 * (200 + 15) + 60)
    expect(backstop('30')).toBe(4 * (30 + 15) + 60)
    expect(backstop('99999')).toBe(4 * (99999 + 15) + 60)
    for (const bad of ['0', '07', '-5', '1.5', 'abc', '', '100000', '999999999999999999999'])
      expect(backstop(bad)).toBe(930)
  })
})
