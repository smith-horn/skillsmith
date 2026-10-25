/**
 * SMI-7142 (Wave 1): the autochain's resume mode. A resume is a `schedule` tick OR a
 * `workflow_dispatch` with mode=resume (the pg_cron dispatcher, or an operator), and one
 * predicate (job env IS_RESUME) stands for both. These pin the YAML facts a refactor could
 * silently drop, and execute the two new inline scripts (input validation, self-reconcile)
 * against case tables.
 */
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { formatOutputs } from '../../indexer/backfill-autochain-defer.ts'
import {
  commands,
  loadWorkflow,
  runStepScript,
  WORKFLOW,
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
const RESUME_EXPR =
  "(github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.mode == 'resume'))"

describe('inputs and title', () => {
  const wd = doc.on.workflow_dispatch as {
    inputs: Record<
      string,
      { type: string; required?: boolean; default?: unknown; options?: string[] }
    >
  }

  it('mode is a choice of link (default) and resume; resume_source is a display-only string', () => {
    expect(wd.inputs.mode).toMatchObject({ type: 'choice', default: 'link' })
    expect(wd.inputs.mode.options).toEqual(['link', 'resume'])
    expect(wd.inputs.resume_source).toMatchObject({ type: 'string', default: '' })
    expect(wd.inputs.completed_run_id).toMatchObject({ type: 'string', required: false })
  })

  it('the run title carries [resume] for a schedule tick or mode=resume and NO free-text input', () => {
    const runName = (doc as unknown as { 'run-name': string })['run-name']
    expect(runName).toContain(
      "(github.event_name == 'schedule' || inputs.mode == 'resume') && ' [resume]'"
    )
    // run-name is evaluated before validation, so user text in it could spoof the tag.
    const refs = [...runName.matchAll(/inputs\.([a-z_]+)/g)].map((m) => m[1])
    expect(refs).toEqual(['mode'])
    expect(runName).not.toContain('resume_source')
    // Bracket access would slip past the dotted-ref scan above.
    expect(runName).not.toMatch(/inputs\s*\[/)
  })

  it('the schedule trigger stays as the independent fallback, citing ADR-181', () => {
    expect(doc.on.schedule).toEqual([{ cron: '3,23,43 1,4,9,10,15,16,21,22 * * *' }])
    const text = readFileSync(WORKFLOW, 'utf8')
    expect(text).toMatch(/FALLBACK resumer only \(ADR-181/)
  })
})

describe('one resume predicate', () => {
  it('IS_RESUME is the job env predicate; the concurrency group inlines the same expression', () => {
    expect(job.env.IS_RESUME).toBe(`\${{ ${RESUME_EXPR.slice(1, -1)} }}`)
    const c = (doc as unknown as { concurrency: { group: string } }).concurrency
    expect(c.group).toBe(
      `\${{ ${RESUME_EXPR} && 'skill-indexer-backfill-autochain-tick' || 'skill-indexer-backfill-autochain' }}`
    )
  })

  it('no step tests the event name against schedule; only IS_RESUME decides resume behaviour', () => {
    const bare = steps
      .filter((s) => /event_name\s*[!=]=\s*'schedule'/.test(JSON.stringify(s)))
      .map((s) => s.name)
    expect(bare, `steps with a bare schedule check: ${bare.join(', ')}`).toEqual([])
  })

  it('every (schedule)/(resume) step reads IS_RESUME == true, never != true', () => {
    const tagged = steps.filter((s) => /\((schedule|resume)\)$/.test(s.name ?? ''))
    // non-vacuity: the derivation finds the known members and a plausible number of them
    const names = tagged.map((s) => s.name)
    for (const n of [
      'Yield to a live link (schedule)',
      'Claim the deferral marker (schedule)',
      'Reconcile this claim after the dispatch (resume)',
      'Alert on post-dispatch reconcile failure (resume)',
    ])
      expect(names).toContain(n)
    expect(tagged.length).toBeGreaterThanOrEqual(12)
    for (const s of tagged) {
      expect(s.if, s.name).toContain("env.IS_RESUME == 'true'")
      expect(s.if, s.name).not.toContain("env.IS_RESUME != 'true'")
    }
  })

  it('the link-only paths read IS_RESUME != true', () => {
    for (const n of [
      'No other backfill run queued or in-progress',
      'Resolve run display title',
      'Live-marker check before deferring',
      'Refuse a second deferral',
      'Defer to the next window',
    ]) {
      expect(byName(n).if, n).toContain("env.IS_RESUME != 'true'")
      expect(byName(n).if, n).not.toContain("env.IS_RESUME == 'true'")
    }
  })

  it('a resume dispatch is allowed only via verify_only=false, takes no run id, and cannot carry an acknowledgement', () => {
    // A mode=resume dispatch with verify_only=true fails validation; it must not ALSO
    // count as allowed, or the generic failure email fires on an operator typo.
    expect(job.env.DISPATCH_ALLOWED).not.toContain('inputs.mode')
    expect(job.env.DISPATCH_ALLOWED).toContain('inputs.verify_only == false')
    expect(job.env.COMPLETED_RUN_ID).toContain("inputs.mode != 'resume'")
    expect(byId('recover').env!.ACKNOWLEDGE_HALTS).toContain("inputs.mode != 'resume'")
  })

  it('the fence is told schedule and the marker attempt whenever it is a resume', () => {
    const fence = byId('fence')
    expect(fence.env!.TRIGGER_EVENT).toBe(
      "${{ env.IS_RESUME == 'true' && 'schedule' || github.event_name }}"
    )
    expect(fence.env!.TRIGGER_RUN_ATTEMPT).toMatch(
      /^\$\{\{ env\.IS_RESUME == 'true' && steps\.target\.outputs\.completed_run_attempt \|\| /
    )
  })

  it('the kill-switch gate stops a resume dispatch quietly, like a tick', () => {
    const gate = byName('Kill-switch gate')
    const go = (isResume: string, event: string) =>
      runStepScript(gate.run!, {
        env: {
          EVENT_NAME: event,
          IS_RESUME: isResume,
          AUTOCHAIN_DISABLE: '1',
          BACKFILL_KILL_SWITCH: '',
        },
      })
    expect(go('true', 'workflow_dispatch').githubEnv).toBe('skip=true\n')
    // CONTROL: a manual link under the same switch still recovers (verify-only side effects are off)
    expect(go('false', 'workflow_dispatch').githubEnv).toBe('')
  })
})

describe('Validate dispatch inputs (executed)', () => {
  const v = byName('Validate dispatch inputs')

  it('is the first step, runs only for workflow_dispatch and reads every input through env', () => {
    // SMI-7167: the only step allowed before it is the fail-soft ledger write `Record link start`
    // (ADR-183), which must run before every gate and validates its own run id. Nothing else may
    // act on the inputs first.
    const ledger = byName('Record link start')
    expect(idx(ledger)).toBe(0)
    expect(ledger['continue-on-error']).toBe(true)
    expect(idx(v)).toBe(1)
    expect(v.id).toBe('validate')
    expect(v.if).toBe("github.event_name == 'workflow_dispatch'")
    for (const k of [
      'MODE',
      'IN_COMPLETED_RUN_ID',
      'IN_COMPLETED_RUN_ATTEMPT',
      'IN_ACKNOWLEDGE_HALTS',
      'IN_VERIFY_ONLY',
      'IN_RESUME_SOURCE',
    ])
      expect(v.env![k], k).toMatch(/^\$\{\{ inputs\.[a-z_]+ \}\}$/)
    expect(v.run).not.toMatch(/\$\{\{/)
  })

  const base = {
    MODE: 'link',
    IN_COMPLETED_RUN_ID: '123',
    IN_COMPLETED_RUN_ATTEMPT: '1',
    IN_ACKNOWLEDGE_HALTS: '',
    IN_VERIFY_ONLY: 'true',
    IN_RESUME_SOURCE: '',
  }
  const resume = { ...base, MODE: 'resume', IN_COMPLETED_RUN_ID: '', IN_VERIFY_ONLY: 'false' }
  it('a validation failure does not send the generic failure email; the resume_source is logged, not titled', () => {
    expect(byName('Send Alert on Failure').if).toContain("steps.validate.outcome != 'failure'")
    const r = runStepScript(v.run!, { env: { ...resume, IN_RESUME_SOURCE: 'pg_cron-prod' } })
    expect(r.status, r.err).toBe(0)
    expect(r.err).toContain('resume_source: pg_cron-prod')
  })

  it.each([
    ['link with a run id (verify only) => exit 0', base, 0],
    ['link with a run id and verify_only=false => exit 0', { ...base, IN_VERIFY_ONLY: 'false' }, 0],
    ['link without a run id => exit 1', { ...base, IN_COMPLETED_RUN_ID: '' }, 1],
    ['resume, nothing else set => exit 0', resume, 0],
    ['resume with an empty attempt => exit 0', { ...resume, IN_COMPLETED_RUN_ATTEMPT: '' }, 0],
    ['resume with a source => exit 0', { ...resume, IN_RESUME_SOURCE: 'pg_cron-prod' }, 0],
    ['resume + verify_only=true => exit 1', { ...resume, IN_VERIFY_ONLY: 'true' }, 1],
    ['resume + a run id => exit 1', { ...resume, IN_COMPLETED_RUN_ID: '123' }, 1],
    ['resume + attempt 2 => exit 1', { ...resume, IN_COMPLETED_RUN_ATTEMPT: '2' }, 1],
    [
      'resume + acknowledge_halts => exit 1',
      { ...resume, IN_ACKNOWLEDGE_HALTS: 'no_progress_record' },
      1,
    ],
    ['an unknown mode => exit 1', { ...base, MODE: 'Resume' }, 1],
    ['an empty mode => exit 1', { ...base, MODE: '' }, 1],
    ['a source carrying a [resume] tag => exit 1', { ...base, IN_RESUME_SOURCE: 'x [resume]' }, 1],
    ['a source with a newline => exit 1', { ...base, IN_RESUME_SOURCE: 'a\nb' }, 1],
    ['a 65-character source => exit 1', { ...base, IN_RESUME_SOURCE: 'a'.repeat(65) }, 1],
    ['a 64-character source => exit 0', { ...base, IN_RESUME_SOURCE: 'a'.repeat(64) }, 0],
  ] as [string, Record<string, string>, number][])('%s', (_l, env, want) => {
    const r = runStepScript(v.run!, { env })
    expect(r.status, r.err).toBe(want)
    if (want === 1) expect(r.err).toContain('::error::Invalid dispatch inputs')
  })
})

describe('Reconcile this claim after the dispatch (executed)', () => {
  const s = byId('self_reconcile')
  const dispatch = byId('dispatch')

  it('sits right after the dispatch, resume-only, gated, and only after a claim and a dispatch succeeded', () => {
    expect(idx(s)).toBeGreaterThan(idx(dispatch))
    expect(idx(s)).toBeLessThan(idx(byName('Send Alert on Failure')))
    for (const c of [
      "env.skip != 'true'",
      "env.DISPATCH_ALLOWED == 'true'",
      "env.IS_RESUME == 'true'",
      "steps.claim.outputs.claimed == 'true'",
      "steps.dispatch.outcome == 'success'",
    ])
      expect(s.if, c).toContain(c)
    expect(commands(s.run!).join('\n')).toContain('backfill-autochain-defer.ts reconcile')
  })

  // The stub plays `tsx ... reconcile-marker`; its output is the real formatOutputs text.
  // Any other subcommand (the unscoped sweep) exits 9. Polls before `from` report nothing.
  const out = (ids: string, moved = '0') =>
    formatOutputs({
      moved_count: moved,
      moved: '[]',
      dispatched_count: ids === '' ? '0' : String(ids.split(',').length),
      left_count: '0',
      dispatched_ids: ids,
      needs_intervention_ids: '',
    })
  const stubs = (opts: {
    ids: string
    from?: number
    moved?: string
    rc?: number
    raw?: string
  }) => {
    const text = opts.raw ?? out(opts.ids, opts.moved)
    return {
      'bin/sleep': 'exit 0\n',
      'bin/npx': [
        'n=$(cat "$MARK.n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$MARK.n"',
        'echo "poll $n" >> "$MARK"',
        '[ "$3" = reconcile-marker ] || exit 9',
        `[ ${opts.rc ?? 0} -ne 0 ] && exit ${opts.rc ?? 0}`,
        `[ "$n" -ge ${opts.from ?? 1} ] || { cat <<'EMPTYEOF' >> "$GITHUB_OUTPUT"`,
        out(''),
        'EMPTYEOF',
        'exit 0; }',
        'cat <<\'STUBEOF\' >> "$GITHUB_OUTPUT"',
        text.replace(/\n$/, ''),
        'STUBEOF',
        '',
      ].join('\n'),
    }
  }
  const mine = { MARKER_ID: 'a', MARKER_ENV: 'prod' }

  it('stops polling as soon as THIS marker is dispatched and records it', () => {
    const r = runStepScript(s.run!, { stubs: stubs({ ids: 'a', from: 2 }), env: mine })
    expect(r.status, r.err).toBe(0)
    expect(r.marks).toEqual(['poll 1', 'poll 2'])
    expect(r.output).toBe('dispatched=true\n')
  })

  it('this marker among several dispatched ids is found', () => {
    const r = runStepScript(s.run!, { stubs: stubs({ ids: 'b,a' }), env: mine })
    expect(r.status, r.err).toBe(0)
    expect(r.output).toBe('dispatched=true\n')
  })

  it('only the OTHER marker reaching dispatched is not success: 6 polls, no dispatched=true', () => {
    const r = runStepScript(s.run!, { stubs: stubs({ ids: 'b' }), env: mine })
    expect(r.status, r.err).toBe(0)
    expect(r.marks).toHaveLength(6)
    expect(r.output).toBe('')
    expect(r.err).toContain('::warning::')
  })

  it('an id that merely contains ours (ba, ab) is not ours', () => {
    for (const ids of ['ba', 'ab', 'xa,ay']) {
      const r = runStepScript(s.run!, { stubs: stubs({ ids }), env: mine })
      expect(r.output, ids).toBe('')
    }
  })

  it('a run that never appears is a warning and green after exactly 6 polls', () => {
    const r = runStepScript(s.run!, { stubs: stubs({ ids: 'a', from: 99 }), env: mine })
    expect(r.status, r.err).toBe(0)
    expect(r.marks).toHaveLength(6)
    expect(r.output).toBe('')
    expect(r.err).toContain('::warning::')
  })

  it('uses the scoped subcommand, never the unscoped sweep, and passes the claimed marker through env', () => {
    const e = s.env!
    expect(e.MARKER_ID).toBe('${{ steps.target.outputs.marker_id }}')
    expect(e.MARKER_ENV).toBe('${{ steps.target.outputs.supabase_env }}')
    expect(commands(s.run!).join('\n')).not.toMatch(/defer\.ts reconcile(\s|$)/)
  })

  it('a marker moved to needs_intervention is red, not a quiet warning', () => {
    const r = runStepScript(s.run!, { stubs: stubs({ ids: '', moved: '1' }), env: mine })
    expect(r.status, r.err).toBe(1)
    expect(r.marks).toEqual(['poll 1'])
    expect(r.err).toContain('needs_intervention')
  })

  it('a read or transition error is red', () => {
    const r = runStepScript(s.run!, { stubs: stubs({ ids: 'a', rc: 1 }), env: mine })
    expect(r.status, r.err).toBe(1)
    expect(r.err).toContain('::error::')
  })

  it('empty output is red as unparseable, not read as "nothing moved"', () => {
    const r = runStepScript(s.run!, { stubs: stubs({ ids: '', raw: '' }), env: mine })
    expect(r.status, r.err).toBe(1)
    expect(r.err).toContain('unparseable')
    expect(r.output).toBe('')
  })

  it('output with moved_count but no dispatched_ids is red', () => {
    const r = runStepScript(s.run!, {
      stubs: stubs({ ids: '', raw: formatOutputs({ moved_count: '0' }) }),
      env: mine,
    })
    expect(r.status, r.err).toBe(1)
    expect(r.err).toContain('no dispatched_ids')
  })
})

describe('alerts after a post-dispatch reconcile failure', () => {
  it('the generic failure alert is suppressed only once its own alert delivered', () => {
    const g = byName('Send Alert on Failure')
    expect(g.if).toContain("steps.self_reconcile_alert.outputs.delivered != 'true'")
    // Suppressing on the reconcile's failure alone would send NO email when the
    // dedicated alert itself failed to deliver.
    expect(g.if).not.toContain("steps.self_reconcile.outcome != 'failure'")
    expect(g.env!.SELF_RECONCILE_FAILED).toBe("${{ steps.self_reconcile.outcome == 'failure' }}")
  })

  it('the generic fallback says DID dispatch after a reconcile failure, did not dispatch otherwise', () => {
    const g = byName('Send Alert on Failure')
    // jq is not in the dev container; the stub records its args (the message is one).
    const record = '#!/bin/sh\nprintf "%s\\n" "$@" >> "$MARK"\necho "{}"\n'
    const sent = (failed: string) =>
      runStepScript(g.run!, {
        stubs: { 'bin/curl': '#!/bin/sh\necho 200\n', 'bin/jq': record },
        env: {
          SELF_RECONCILE_FAILED: failed,
          COMPLETED_RUN_ID: '',
          RUN_URL: 'u',
          SUPABASE_URL: 'h',
          SUPABASE_SERVICE_ROLE_KEY: 'k',
        },
      })
    const yes = sent('true')
    expect(yes.marks.join('\n'), yes.err).toContain('DID dispatch the next chunk')
    expect(yes.marks.join('\n')).not.toContain('did not dispatch')
    const no = sent('false')
    expect(no.marks.join('\n')).toContain('It did not dispatch the next chunk')
  })

  it('its own alert says the chunk WAS dispatched', () => {
    const a = byId('self_reconcile_alert')
    expect(idx(a)).toBeGreaterThan(idx(byId('self_reconcile')))
    expect(idx(a)).toBeLessThan(idx(byName('Send Alert on Failure')))
    expect(a.if).toContain('failure()')
    expect(a.if).toContain("steps.self_reconcile.outcome == 'failure'")
    expect(a.env!.MARKER_ID).toBe('${{ steps.target.outputs.marker_id }}')
    expect(a.run).toContain('DID dispatch')
    expect(a.run).toContain('section 8.3')
    expect(a.run).toContain('bash scripts/ci/autochain-alert.sh')
    expect(a.run).not.toContain('did not dispatch')
  })
})
