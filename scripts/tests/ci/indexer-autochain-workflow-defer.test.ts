/**
 * SMI-7121 (Wave 2b-ii): structural contract for the autochain's halts, busy window,
 * deferral and scheduled resume. Each property is a YAML fact a refactor could silently
 * drop; the step scripts that decide something are also executed with stubs.
 */
import { describe, it, expect } from 'vitest'
import {
  commands,
  loadWorkflow,
  runStepScript,
  type Step,
} from './indexer-autochain-workflow.helpers.ts'

const doc = loadWorkflow()
const job = doc.jobs.autochain
const steps = job.steps
const byId = (id: string): Step => {
  const s = steps.find((x) => x.id === id)
  expect(s, `no step with id ${id}`).toBeDefined()
  return s!
}
const byName = (name: string): Step => {
  const s = steps.find((x) => x.name === name)
  expect(s, `no step named ${name}`).toBeDefined()
  return s!
}
const idx = (s: Step) => steps.indexOf(s)
const cmdText = (s: Step) => commands(s.run ?? '').join('\n')
const READ = 'GH_TOKEN="$VARIABLE_READ_PAT" bash scripts/ci/autochain-read-enable.sh || exit 1'
const DA = "env.DISPATCH_ALLOWED == 'true'"

describe('triggers and gates', () => {
  it('schedules the plan D6 resume cron, exactly once', () => {
    expect(doc.on.schedule).toEqual([{ cron: '3,23,43 1,4,9,10,15,16,21,22 * * *' }])
  })

  it('workflow_dispatch takes acknowledge_halts as a string defaulting to empty', () => {
    const wd = doc.on.workflow_dispatch as {
      inputs: Record<string, { type: string; default?: unknown }>
    }
    expect(wd.inputs.acknowledge_halts).toMatchObject({ type: 'string', default: '' })
  })

  it('the job `if` admits schedule, and still only SUCCESSFUL workflow_run completions', () => {
    expect(job.if).toMatch(/github\.event_name\s*==\s*'schedule'/)
    expect(job.if).toContain("github.event.workflow_run.conclusion == 'success'")
  })

  it('DISPATCH_ALLOWED is true for schedule unless a kill switch is set', () => {
    expect(job.env.DISPATCH_ALLOWED).toContain("github.event_name == 'schedule'")
    expect(job.env.DISPATCH_ALLOWED).toContain("vars.BACKFILL_AUTOCHAIN_DISABLE != '1'")
    expect(job.env.DISPATCH_ALLOWED).toContain("vars.BACKFILL_KILL_SWITCH != '1'")
  })

  it('BACKFILL_NDB_MAX and BACKFILL_BUSY_HOURS come from repo variables, empty meaning the default', () => {
    expect(job.env.BACKFILL_NDB_MAX).toBe("${{ vars.BACKFILL_NDB_MAX || '' }}")
    expect(job.env.BACKFILL_BUSY_HOURS).toBe("${{ vars.BACKFILL_BUSY_HOURS || '' }}")
  })

  describe('the kill-switch gate (executed)', () => {
    const gate = byName('Kill-switch gate')
    const run = (env: Record<string, string>) =>
      runStepScript(gate.run!, { env: { AUTOCHAIN_DISABLE: '', BACKFILL_KILL_SWITCH: '', ...env } })

    it.each([
      ['schedule', 'AUTOCHAIN_DISABLE'],
      ['schedule', 'BACKFILL_KILL_SWITCH'],
      ['workflow_run', 'AUTOCHAIN_DISABLE'],
      ['workflow_run', 'BACKFILL_KILL_SWITCH'],
    ])(
      '%s with %s=1: the gate step sets skip=true and exits 0 (a workflow_run link under BACKFILL_KILL_SWITCH is then made red by the separate kill-switch alert step)',
      (event, sw) => {
        const r = run({ EVENT_NAME: event, [sw]: '1' })
        expect(r.status, r.err).toBe(0)
        expect(r.githubEnv).toBe('skip=true\n')
      }
    )

    it.each(['schedule', 'workflow_run', 'workflow_dispatch'])(
      'CONTROL: %s with no switch set does not stop',
      (event) => {
        const r = run({ EVENT_NAME: event, AUTOCHAIN_DISABLE: '0' })
        expect(r.status, r.err).toBe(0)
        expect(r.githubEnv).toBe('')
      }
    )

    it('a manual verify run with a switch set still recovers (no skip)', () => {
      const r = run({ EVENT_NAME: 'workflow_dispatch', AUTOCHAIN_DISABLE: '1' })
      expect(r.githubEnv).toBe('')
    })

    it('reads the event through env, not inline', () => {
      expect(gate.env!.EVENT_NAME).toBe('${{ github.event_name }}')
    })
  })
})

describe('side effects and untrusted values', () => {
  const SIDE_EFFECT =
    /gh workflow run|alert-notify|autochain-alert\.sh|\bsleep\b|backfill-autochain-defer\.ts (insert|claim|needs-intervention|reconcile)/

  it('every step that writes a marker, alerts, waits or dispatches is gated on DISPATCH_ALLOWED', () => {
    const risky = steps.filter((s) => SIDE_EFFECT.test(cmdText(s)))
    const names = risky.map((s) => s.name)
    for (const want of [
      'Reconcile consumed deferral markers (schedule)',
      'Alert on markers needing intervention (reconcile)',
      'Alert on multiple deferrals (schedule)',
      'Alert on halt',
      'Close the deferral marker, not resumable (schedule)',
      'Close the deferral marker on a later run (schedule, fence exit 3)',
      'Refuse a second deferral',
      'Defer to the next window',
      'Claim the deferral marker (schedule)',
      'Close the deferral marker, campaign complete (schedule)',
      'Alert on kill-switch stop (link)',
      'Dispatch next chunk',
    ]) {
      expect(names, `side-effect step not detected: ${want}`).toContain(want)
    }
    // The one exemption: the kill-switch stop alert runs exactly when DISPATCH_ALLOWED is
    // false, so it carries its own condition (pinned in the G1 test below).
    const ungated = risky
      .filter((s) => s.id !== 'kill_alert')
      .filter((s) => !(s.if ?? '').includes(DA))
      .map((s) => s.name)
    expect(
      ungated,
      `side-effect steps missing the DISPATCH_ALLOWED gate: ${ungated.join(', ')}`
    ).toEqual([])
  })

  it('no run: script inlines ${{ steps.*.outputs.* }}, ${{ github.event.* }} or ${{ inputs.* }}', () => {
    const bad = steps
      .filter((s) =>
        /\$\{\{[^}]*\b(steps\.[A-Za-z0-9_-]+\.outputs|github\.event\.|inputs\.)/.test(s.run ?? '')
      )
      .map((s) => s.name)
    expect(bad, `steps inlining untrusted expressions: ${bad.join(', ')}`).toEqual([])
  })

  it('ACKNOWLEDGE_HALTS comes from the dispatch input only on workflow_dispatch, else from the marker', () => {
    const recover = byId('recover')
    const defer = byId('defer')
    expect(recover.env!.ACKNOWLEDGE_HALTS).toBe(
      "${{ github.event_name == 'workflow_dispatch' && inputs.acknowledge_halts || steps.target.outputs.acknowledged_halts || '' }}"
    )
    // the deferring link records the manual acknowledgement on the marker
    expect(defer.env!.ACKNOWLEDGE_HALTS).toBe(
      "${{ github.event_name == 'workflow_dispatch' && inputs.acknowledge_halts || '' }}"
    )
    const reads = /inputs\.acknowledge_halts|ACKNOWLEDGE_HALTS|acknowledged_halts/
    const others = steps.filter(
      (s) => s !== recover && s !== defer && reads.test(JSON.stringify(s))
    )
    expect(others.map((s) => s.name)).toEqual([])
    expect(JSON.stringify(job.env)).not.toMatch(reads)
  })

  it("the workflow sends only its own alert types; the stale-marker types are the watcher's", () => {
    const text = JSON.stringify(steps)
    const types = [
      ...new Set(
        [
          ...text.matchAll(/(?:ALERT_TYPE=|type:\\"|type:")(indexer_backfill_autochain_[a-z_]+)/g),
        ].map((m) => m[1])
      ),
    ].sort()
    expect(types).toEqual([
      'indexer_backfill_autochain_campaign_complete',
      'indexer_backfill_autochain_failed',
      'indexer_backfill_autochain_halted',
      'indexer_backfill_autochain_kill_switch_stop',
      'indexer_backfill_autochain_multiple_deferrals',
      'indexer_backfill_autochain_needs_intervention',
      'indexer_backfill_autochain_retry_cap',
    ])
  })
})

describe('kill switches (G1)', () => {
  const alert = byId('kill_alert')

  it('BACKFILL_KILL_SWITCH=1 on a workflow_run link alerts under its OWN condition (not DISPATCH_ALLOWED)', () => {
    expect(alert.if).toBe(
      "github.event_name == 'workflow_run' && env.BACKFILL_KILL_SWITCH == '1' && env.AUTOCHAIN_DISABLE != '1'"
    )
    expect(idx(alert)).toBe(idx(byName('Kill-switch gate')) + 1)
  })

  it('the alert names the completed run, says re-enabling does not resume, points to 8.1, and is red', () => {
    const text = alert.run!
    expect(text).toContain('type:"indexer_backfill_autochain_kill_switch_stop"')
    expect(text).toContain('$COMPLETED_RUN_ID')
    expect(text).toContain('Re-enabling does NOT resume')
    expect(text).toContain('section 8.1')
    expect(text).toContain('echo "delivered=true" >> "$GITHUB_OUTPUT"')
    expect(commands(text).at(-1)).toBe('exit 1')
    // inline: it runs before Checkout, so it must not need a checked-out file
    expect(text).not.toMatch(/scripts\//)
  })

  it('BACKFILL_AUTOCHAIN_DISABLE=1 (driver mode) and schedule ticks stay quiet', () => {
    expect(alert.if).toContain("env.AUTOCHAIN_DISABLE != '1'")
    expect(alert.if).not.toContain('schedule')
  })
})

describe('authoritative and pre-claim reads (G2, V1)', () => {
  const READ_CMD = 'GH_TOKEN="$VARIABLE_READ_PAT" bash scripts/ci/autochain-read-enable.sh'

  it("the dispatch step's only command before `gh workflow run` is the read of BOTH switches", () => {
    const cmds = commands(byName('Dispatch next chunk').run!)
    const at = cmds.findIndex((c) => c.startsWith('timeout 60 gh workflow run'))
    expect(cmds.slice(0, at)).toEqual([`${READ_CMD} || exit 1`])
  })

  it("a schedule tick runs the same read BEFORE the claim, under the claim's exact condition", () => {
    const pre = byId('preclaim')
    const claim = byId('claim')
    expect(pre.if).toBe(claim.if)
    expect(commands(pre.run!)).toEqual([READ_CMD])
    expect(pre.env!.VARIABLE_READ_PAT).toContain('secrets.BACKFILL_VARIABLE_READ_PAT')
    expect(idx(byId('window'))).toBeLessThan(idx(pre))
    expect(idx(pre)).toBe(idx(claim) - 1)
    expect(pre).not.toHaveProperty('continue-on-error')
  })
})

describe('campaign complete on a resume (V2)', () => {
  const done = byId('campaign_complete')
  const other = byName('Close the deferral marker, not resumable (schedule)')

  it('closes the marker with reason campaign_complete and an info alert, and stays green', () => {
    expect(done.if).toContain("steps.recover.outputs.campaign_complete == 'true'")
    expect(done.if).toContain("github.event_name == 'schedule'")
    const cmds = commands(done.run!)
    expect(cmds[0]).toBe(
      'REASON=campaign_complete npx tsx scripts/indexer/backfill-autochain-defer.ts needs-intervention'
    )
    expect(cmds.join('\n')).toContain('ALERT_TYPE=indexer_backfill_autochain_campaign_complete')
    expect(cmds.join('\n')).not.toMatch(/\bexit 1\b/)
  })

  it('halts and the retry cap keep the needs-intervention close (not the campaign one)', () => {
    expect(other.if).toContain("steps.recover.outputs.campaign_complete != 'true'")
    expect(cmdText(other)).toMatch(
      /REASON="resume recovery did not yield a dispatch: \$SKIP_REASON"/
    )
  })
})

describe('concurrency (V3)', () => {
  it('schedule ticks have their own group; links keep theirs; nothing cancels in progress', () => {
    const c = (doc as unknown as { concurrency: { group: string; 'cancel-in-progress': boolean } })
      .concurrency
    expect(c.group).toBe(
      "${{ github.event_name == 'schedule' && 'skill-indexer-backfill-autochain-tick' || 'skill-indexer-backfill-autochain' }}"
    )
    expect(c['cancel-in-progress']).toBe(false)
  })

  it('a tick yields to a live link at its start: before reconcile, schedule only', () => {
    const y = byName('Yield to a live link (schedule)')
    expect(cmdText(y)).toBe('bash scripts/ci/autochain-tick-yield.sh')
    expect(y.if).toContain("github.event_name == 'schedule'")
    expect(y.env!.GH_TOKEN).toContain('secrets.GITHUB_TOKEN')
    expect(idx(byName('Install dependencies'))).toBeLessThan(idx(y))
    expect(idx(y)).toBeLessThan(idx(byId('reconcile')))
  })
})

describe('halts', () => {
  const recover = byId('recover')

  it('recovery maps the halt exit (3) to a green step and keeps every other status', () => {
    const run = (rc: number) =>
      runStepScript(recover.run!, { stubs: { 'bin/npx': `echo recover >> "$MARK"; exit ${rc}\n` } })
    expect(run(0).status).toBe(0)
    expect(run(3).status).toBe(0)
    expect(run(1).status).toBe(1)
    expect(run(2).status).toBe(2)
  })

  it('every dispatch-path step requires skip == false, which only a clean recovery emits', () => {
    for (const s of [
      byName('Cooldown before reacquisition'),
      byId('recheck'),
      byId('fence'),
      byId('window'),
      byId('claim'),
      byName('Dispatch next chunk'),
    ]) {
      expect(s.if, s.name).toContain("steps.recover.outputs.skip == 'false'")
    }
  })

  it('a halt is reported, alerted once and then fails the job', () => {
    const report = byName('Report halt')
    const alert = byId('halt_alert')
    const fail = byName('Fail on halt')
    for (const s of [report, alert, fail])
      expect(s.if).toContain("steps.recover.outputs.halted == 'true'")
    expect(idx(report)).toBeLessThan(idx(alert))
    expect(idx(alert)).toBeLessThan(idx(fail))
    expect(cmdText(alert)).toContain('ALERT_TYPE=indexer_backfill_autochain_halted')
    expect(cmdText(alert)).toContain('echo "delivered=true" >> "$GITHUB_OUTPUT"')
    expect(commands(fail.run!)).toContain('exit 1')
    // verify-only is red without an alert: the report and the failure are not DISPATCH_ALLOWED-gated
    expect(report.if).not.toContain('DISPATCH_ALLOWED')
    expect(fail.if).not.toContain('DISPATCH_ALLOWED')
  })

  it('Send Alert on Failure is suppressed once a halt alert was delivered (one email per halt)', () => {
    const s = byName('Send Alert on Failure')
    expect(s.if).toContain('failure()')
    expect(s.if).toContain("steps.halt_alert.outputs.delivered != 'true'")
  })

  it('Send Alert on Failure does not depend on a checked-out file (a failure before Checkout still alerts)', () => {
    const s = byName('Send Alert on Failure')
    expect(s.run).not.toMatch(/scripts\//)
    expect(s.run).toContain('alert-notify')
  })

  it('Report skip reason does not also fire for a halt', () => {
    expect(byName('Report skip reason').if).toContain("steps.recover.outputs.halted != 'true'")
  })
})

describe('window, fence and dispatch order', () => {
  const fence = byId('fence')
  const window = byId('window')
  const dispatch = byName('Dispatch next chunk')

  it('the busy-window step sits after the fence and before the enable read', () => {
    expect(cmdText(window)).toBe('npx tsx scripts/indexer/backfill-busy-window.ts')
    expect(idx(fence)).toBeLessThan(idx(window))
    expect(idx(window)).toBeLessThan(idx(dispatch))
    expect(window.if).toContain("steps.fence.outcome == 'success'")
  })

  it('the dispatch requires an OPEN window (the gate before dispatch)', () => {
    expect(dispatch.if).toContain("steps.window.outputs.window_open == 'true'")
  })

  it('exactly one step dispatches; the read runs there and (non-authoritatively) before the claim', () => {
    const dispatchers = steps.filter((s) => cmdText(s).includes('gh workflow run'))
    expect(dispatchers).toEqual([dispatch])
    const readers = steps.filter(
      (s) =>
        cmdText(s).includes('autochain-read-enable.sh') && !cmdText(s).includes('--verify-read')
    )
    expect(readers).toEqual([byId('preclaim'), dispatch])
  })

  it('on either path NOTHING runs between the enable read and `gh workflow run`', () => {
    const cmds = commands(dispatch.run!)
    const at = cmds.findIndex((c) => c.startsWith('timeout 60 gh workflow run'))
    expect(cmds.slice(0, at + 1).length, JSON.stringify(cmds)).toBe(2)
    expect(cmds[0]).toBe(READ)
    // the one dispatch step serves both paths: link paths, and schedule after a claim
    expect(dispatch.if).toContain(
      "(github.event_name != 'schedule' || steps.claim.outputs.claimed == 'true')"
    )
    expect(dispatch.run).toContain('-f dispatch_token="ac-$GITHUB_RUN_ID"')
  })
})

describe('link path: deferral', () => {
  const live = byId('live')
  const liveAlert = byId('live_alert')
  const defer = byId('defer')

  it('a closed window checks for live markers, refuses a second deferral, otherwise inserts', () => {
    for (const s of [live, liveAlert, defer]) {
      expect(s.if).toContain("steps.window.outputs.window_open == 'false'")
      expect(s.if).toContain("github.event_name != 'schedule'")
    }
    expect(cmdText(live)).toBe('npx tsx scripts/indexer/backfill-autochain-defer.ts live-check')
    expect(liveAlert.if).toContain("steps.live.outputs.live_count != '0'")
    expect(cmdText(liveAlert)).toContain('ALERT_TYPE=indexer_backfill_autochain_multiple_deferrals')
    expect(commands(liveAlert.run!).at(-1)).toBe('exit 1')
    expect(defer.if).toContain("steps.live.outputs.live_count == '0'")
    expect(cmdText(defer)).toBe('npx tsx scripts/indexer/backfill-autochain-defer.ts insert')
    expect(idx(live)).toBeLessThan(idx(liveAlert))
    expect(idx(liveAlert)).toBeLessThan(idx(defer))
  })

  it('the insert records the triggering attempt, env, prefix, dry_run and next window', () => {
    expect(defer.env).toMatchObject({
      COMPLETED_RUN_ATTEMPT: expect.stringContaining('github.event.workflow_run.run_attempt'),
      SUPABASE_ENV: '${{ steps.recover.outputs.supabase_env }}',
      PATH_PREFIX: '${{ steps.recover.outputs.path_prefix }}',
      DRY_RUN: '${{ steps.recover.outputs.dry_run }}',
      NEXT_WINDOW_UTC: '${{ steps.window.outputs.next_window_utc }}',
    })
  })
})

describe('schedule path: reconcile, target, fence, claim', () => {
  it('reconcile, then target, then the pre-recovery window, then recovery', () => {
    const order = [
      'reconcile',
      'reconcile_alert',
      'target',
      'target_alert',
      'window_pre',
      'recover',
    ].map((i) => idx(byId(i)))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(cmdText(byId('reconcile'))).toBe(
      'npx tsx scripts/indexer/backfill-autochain-defer.ts reconcile'
    )
    expect(cmdText(byId('target'))).toBe(
      'npx tsx scripts/indexer/backfill-autochain-defer.ts schedule-target'
    )
  })

  it('reconcile alerts each moved marker and turns the job red', () => {
    const s = byId('reconcile_alert')
    expect(s.if).toContain("steps.reconcile.outputs.moved_count != '0'")
    expect(cmdText(s)).toContain('ALERT_TYPE=indexer_backfill_autochain_needs_intervention')
    expect(commands(s.run!).at(-1)).toBe('exit 1')
  })

  it('more than one open marker is red plus the multiple_deferrals alert', () => {
    const s = byId('target_alert')
    expect(s.if).toContain('failure()')
    expect(s.if).toContain("steps.target.outputs.multiple == 'true'")
    expect(cmdText(s)).toContain('ALERT_TYPE=indexer_backfill_autochain_multiple_deferrals')
  })

  it('zero open markers or a closed window stop the tick (skip=true) without failing', () => {
    expect(byName('Stop, no deferral to resume (schedule)').if).toContain(
      "steps.target.outputs.resume != 'true'"
    )
    expect(byName('Stop, window closed (schedule)').if).toContain(
      "steps.window_pre.outputs.window_open != 'true'"
    )
  })

  it('recovery takes the marker run and env on a schedule tick', () => {
    const r = byId('recover')
    expect(r.env!.RECOVERY_ENV).toBe('${{ steps.target.outputs.supabase_env }}')
    expect(r.env!.COMPLETED_RUN_ID).toBe(
      '${{ steps.target.outputs.completed_run_id || env.COMPLETED_RUN_ID }}'
    )
  })

  it('fence exit 3 on a schedule tick closes the marker as needs_intervention and alerts', () => {
    const s = byId('ni_alert')
    expect(s.if).toContain('failure()')
    expect(s.if).toContain("github.event_name == 'schedule'")
    expect(s.if).toContain("steps.fence.outputs.exit_code == '3'")
    const cmds = commands(s.run!)
    expect(cmds[0]).toMatch(
      /npx tsx scripts\/indexer\/backfill-autochain-defer\.ts needs-intervention$/
    )
    expect(cmds.join('\n')).toContain('ALERT_TYPE=indexer_backfill_autochain_needs_intervention')
    expect(byName('Send Alert on Failure').if).toContain(
      "steps.ni_alert.outputs.delivered != 'true'"
    )
  })

  it('the claim runs only after a passing fence inside an open window, and before the dispatch', () => {
    const claim = byId('claim')
    expect(claim.if).toContain("steps.fence.outcome == 'success'")
    expect(claim.if).toContain("steps.window.outputs.window_open == 'true'")
    // no status function: a red fence (exit 3 or 1) skips it
    expect(claim.if).not.toMatch(/always\(\)|failure\(\)|cancelled\(\)/)
    expect(cmdText(claim)).toBe('npx tsx scripts/indexer/backfill-autochain-defer.ts claim')
    expect(idx(byId('window'))).toBeLessThan(idx(claim))
    expect(idx(claim)).toBeLessThan(idx(byName('Dispatch next chunk')))
  })

  it('a tick whose recovery cannot resume closes the marker', () => {
    const s = byName('Close the deferral marker, not resumable (schedule)')
    expect(s.if).toContain("github.event_name == 'schedule'")
    expect(s.if).toContain("steps.recover.outputs.skip == 'true'")
    expect(cmdText(s)).toMatch(/backfill-autochain-defer\.ts needs-intervention$/)
  })
})
