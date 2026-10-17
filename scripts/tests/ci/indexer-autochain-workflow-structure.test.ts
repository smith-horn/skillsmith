/**
 * SMI-7112 (1.4): structural contract for indexer-backfill-autochain.yml.
 *
 * These pin the properties that make the autochain safe, as YAML facts a refactor
 * cannot silently drop: manual-dispatch support, the DISPATCH_ALLOWED gate on
 * every side effect, and -- the one that matters most -- the authoritative
 * enable read being the command IMMEDIATELY before the dispatch. SMI-7121 moved the
 * newest-run fence into its own step (with the busy-window check between it and the
 * dispatch); the SMI-7121 additions are pinned in indexer-autochain-workflow-defer.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { commands, loadWorkflow, runStepScript } from './indexer-autochain-workflow.helpers.ts'

const doc = loadWorkflow()
const job = doc.jobs.autochain
const steps = job.steps

const dispatchStep = steps.find((s) => (s.run ?? '').includes('gh workflow run'))

describe('autochain workflow structure', () => {
  it('declares both workflow_run and workflow_dispatch(completed_run_id, verify_only)', () => {
    expect(doc.on).toHaveProperty('workflow_run')
    const wd = doc.on.workflow_dispatch as {
      inputs: Record<string, { required?: boolean; default?: unknown; type: string }>
    }
    expect(wd.inputs.completed_run_id.required).toBe(true)
    expect(wd.inputs.verify_only.type).toBe('boolean')
    expect(wd.inputs.verify_only.default).toBe(true)
  })

  it('the job `if` admits workflow_dispatch', () => {
    expect(job.if).toMatch(/github\.event_name\s*==\s*'workflow_dispatch'/)
  })

  it('COMPLETED_RUN_ID is taken from inputs.completed_run_id on a manual run', () => {
    expect(job.env.COMPLETED_RUN_ID).toContain('inputs.completed_run_id')
  })

  it('DISPATCH_ALLOWED is job-level and turns on verify_only', () => {
    expect(job.env.DISPATCH_ALLOWED).toContain('inputs.verify_only')
  })

  it('every step that dispatches, alerts or waits is gated on DISPATCH_ALLOWED', () => {
    const risky = steps.filter((s) =>
      /gh workflow run|alert-notify|autochain-alert\.sh|\bsleep\b|backfill-autochain-defer\.ts (insert|claim|needs-intervention|reconcile)/.test(
        commands(s.run ?? '').join('\n')
      )
    )
    // cooldown, halt / retry-cap / reconcile / multiple-deferral (x2) / needs-intervention / failure
    // alerts, reconcile, marker close, insert, claim, dispatch
    expect(risky.length).toBeGreaterThanOrEqual(13)
    // The one exemption: the kill-switch stop alert fires exactly when DISPATCH_ALLOWED is
    // false, under its own condition (pinned in indexer-autochain-workflow-defer.test.ts).
    const ungated = risky
      .filter((s) => s.name !== 'Alert on kill-switch stop (link)')
      .filter((s) => !(s.if ?? '').includes("env.DISPATCH_ALLOWED == 'true'"))
      .map((s) => s.name)
    expect(
      ungated,
      `side-effect steps missing the DISPATCH_ALLOWED gate: ${ungated.join(', ')}`
    ).toEqual([])
  })

  it('has a Send Alert on Failure step', () => {
    const s = steps.find((x) => x.name === 'Send Alert on Failure')
    expect(s?.if).toContain('failure()')
  })

  describe('the authoritative enable read (R3-1)', () => {
    it('the dispatch step exists and passes a unique dispatch_token', () => {
      expect(dispatchStep).toBeDefined()
      expect(dispatchStep!.run).toContain('-f dispatch_token="ac-$GITHUB_RUN_ID"')
    })

    it('ADJACENCY: the command right before `timeout 60 gh workflow run` is the read script, nothing between', () => {
      const cmds = commands(dispatchStep!.run!)
      const at = cmds.findIndex((c) => c.startsWith('timeout 60 gh workflow run'))
      expect(at, `commands: ${JSON.stringify(cmds)}`).toBeGreaterThan(0)
      expect(cmds[at - 1]).toMatch(
        /^GH_TOKEN="\$VARIABLE_READ_PAT" bash scripts\/ci\/autochain-read-enable\.sh/
      )
    })

    it('SEQUENCE: before the dispatch there is EXACTLY one command, the read, a single simple command', () => {
      const cmds = commands(dispatchStep!.run!)
      const at = cmds.findIndex((c) => c.startsWith('timeout 60 gh workflow run'))
      expect(cmds.slice(0, at), `commands: ${JSON.stringify(cmds)}`).toEqual([
        'GH_TOKEN="$VARIABLE_READ_PAT" bash scripts/ci/autochain-read-enable.sh || exit 1',
      ])
      // nothing alters the shell's error handling or the step's execution, and nothing runs in the background
      const whole = commands(dispatchStep!.run!).join('\n')
      expect(whole).not.toMatch(/\bset\s+[+-]|\btrap\b|\bsleep\b|\bwait\b|(^|[^&])&\s*$/m)
      expect(dispatchStep).not.toHaveProperty('continue-on-error')
      expect(dispatchStep).not.toHaveProperty('shell')
      // the dispatch step runs the read WITHOUT --verify-read (which authorises nothing)
      expect(cmds[0]).not.toContain('--verify-read')
    })

    it('the newest-run fence is its own step, BEFORE the dispatch step, preserving its exit status', () => {
      const fence = steps.find((x) => x.id === 'fence')
      expect(fence, 'no fence step').toBeDefined()
      expect(steps.indexOf(fence!)).toBeLessThan(steps.indexOf(dispatchStep!))
      const cmds = commands(fence!.run!)
      // The fence's own exit status must be the step's: a lossy wrapper (`|| exit 1`) collapses
      // its documented 3 (skipped loudly) into 1 (could not evaluate).
      expect(cmds).toEqual([
        'rc=0',
        'bash scripts/ci/autochain-newest-run-fence.sh || rc=$?',
        'echo "exit_code=$rc" >> "$GITHUB_OUTPUT"',
        'exit "$rc"',
      ])
      expect(fence).not.toHaveProperty('continue-on-error')
      // the dispatch only runs after a passing fence
      expect(dispatchStep!.if).toContain("steps.fence.outcome == 'success'")
    })

    it('the fence is told the triggering ATTEMPT and event (a re-run keeps its run id)', () => {
      const fence = steps.find((x) => x.id === 'fence')!
      expect(fence.env!.TRIGGER_EVENT).toContain('github.event_name')
      expect(fence.env!.TRIGGER_RUN_ATTEMPT).toContain('github.event.workflow_run.run_attempt')
      expect(fence.env!.TRIGGER_RUN_ATTEMPT).toContain('inputs.completed_run_attempt')
      // a schedule tick names the attempt its deferral marker recorded
      expect(fence.env!.TRIGGER_RUN_ATTEMPT).toContain('steps.target.outputs.completed_run_attempt')
    })

    it('a verify-only manual run ALSO executes the read, in --verify-read mode, and never dispatches', () => {
      const s = steps.find((x) => (x.run ?? '').includes('--verify-read'))
      expect(s, 'no verify-read step').toBeDefined()
      expect(s!.run).toContain('autochain-read-enable.sh --verify-read')
      expect(s!.run).not.toContain('gh workflow run')
      expect(s!.if).toContain("env.DISPATCH_ALLOWED != 'true'")
      expect(s!.if).toContain("github.event_name == 'workflow_dispatch'")
      expect(s!.env!.VARIABLE_READ_PAT).toContain('secrets.BACKFILL_VARIABLE_READ_PAT')
      // it must run after Checkout (the script lives in the repo)
      const idx = (n: string) => steps.findIndex((x) => x.name === n)
      expect(steps.indexOf(s!)).toBeGreaterThan(idx('Checkout'))
    })

    it('the post-cooldown collision (non_terminal != 0) has its own explicit reporting step', () => {
      const s = steps.find((x) => x.name === 'Report post-cooldown collision')
      expect(s, 'no collision step').toBeDefined()
      expect(s!.if).toContain("steps.recheck.outputs.non_terminal != '0'")
      expect(s!.run).toContain('GITHUB_STEP_SUMMARY')
      expect(steps.indexOf(s!)).toBeLessThan(steps.indexOf(dispatchStep!))
    })

    it('the dispatch step has no delay and no `vars.` reference', () => {
      expect(commands(dispatchStep!.run!).join('\n')).not.toMatch(/\bsleep\b/)
      expect(JSON.stringify(dispatchStep)).not.toContain('vars.')
    })

    it('the read uses ONLY the BACKFILL_VARIABLE_READ_PAT secret', () => {
      expect(dispatchStep!.env!.VARIABLE_READ_PAT).toContain('secrets.BACKFILL_VARIABLE_READ_PAT')
    })
  })
})

describe('the fence and dispatch steps executed with stubbed scripts (exit-status propagation)', () => {
  const fenceStep = steps.find((x) => x.id === 'fence')!
  const fence = (rc: number, flags: string[]) =>
    runStepScript(fenceStep.run!, {
      shellFlags: flags,
      stubs: { 'scripts/ci/autochain-newest-run-fence.sh': `echo fence >> "$MARK"; exit ${rc}\n` },
    })
  const dispatch = (readRc: number, flags: string[]) =>
    runStepScript(dispatchStep!.run!, {
      shellFlags: flags,
      env: { VARIABLE_READ_PAT: 'pat' },
      stubs: {
        'scripts/ci/autochain-read-enable.sh': `echo read >> "$MARK"; exit ${readRc}\n`,
        'bin/timeout': 'shift; echo dispatch >> "$MARK"; exit 0\n',
      },
    })

  describe.each([
    ['bash -e (the Actions default)', ['-e']],
    ['bash -eo pipefail', ['-eo', 'pipefail']],
  ] as [string, string[]][])('under %s', (_n, flags) => {
    it('CONTROL: fence 0 is step exit 0, exit_code=0', () => {
      const r = fence(0, flags)
      expect(r.status, r.err).toBe(0)
      expect(r.marks).toEqual(['fence'])
      expect(r.output).toBe('exit_code=0\n')
    })

    it('fence exit 3 (skipped loudly) is the step exit status 3, exit_code=3', () => {
      const r = fence(3, flags)
      expect(r.status, r.err).toBe(3)
      expect(r.output).toBe('exit_code=3\n')
    })

    it('fence exit 1 (could not evaluate) is the step exit status 1, exit_code=1', () => {
      const r = fence(1, flags)
      expect(r.status, r.err).toBe(1)
      expect(r.output).toBe('exit_code=1\n')
    })

    it('CONTROL: read 0 reaches the dispatch', () => {
      const r = dispatch(0, flags)
      expect(r.marks, r.err).toEqual(['read', 'dispatch'])
      expect(r.status).toBe(0)
    })

    it('a failing enable read stops the step before the dispatch', () => {
      const r = dispatch(4, flags)
      expect(r.status).toBe(1)
      expect(r.marks).toEqual(['read'])
    })
  })
})
