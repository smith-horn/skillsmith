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
    expect(r.failed).toBe(' stubpkg')
  })

  it('c: a suite sleeping past its budget times out, fails, and leaves zero survivors', async () => {
    const r = runStub('echo $$ >> "$PIDFILE"; sleep 60 & echo $! >> "$PIDFILE"; wait', {
      ...FAST,
      SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS: '2',
    })
    expect(r.out).toMatch(/⏱ {2}packages\/stubpkg exceeded its 2s budget \(timed out; killed\)/)
    // SMI-7218 done-when: a timeout names a cause and an escape narrower than --no-verify.
    expect(r.out).toMatch(/Cause: the suite hung, or the machine is busy/)
    expect(r.out).toMatch(/SKILLSMITH_PRE_PUSH_SUITE_BUDGET_SECS=\d+ git push/)
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
