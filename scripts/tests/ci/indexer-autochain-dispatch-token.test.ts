/**
 * SMI-7161: the autochain dispatches the next chunk with the fine-grained PAT in the secret
 * BACKFILL_AUTOCHAIN_DISPATCH_PAT, never with GITHUB_TOKEN.
 *
 * GitHub creates no `workflow_run` event for a run that GITHUB_TOKEN dispatched, so a chain whose
 * dispatch used the job token starts one backfill run and then stops, silently, with no red job.
 * The properties here are the ones that keep that from coming back: the dispatch credential is the
 * PAT (by expression AND by the token the dispatched `gh` process actually sees), nothing the
 * dispatch step inherits can supply GITHUB_TOKEN, an empty secret is red rather than a fallback, and
 * the job token cannot write Actions, so a regression fails with 403 instead of succeeding quietly.
 */
import { describe, it, expect } from 'vitest'
import {
  commands,
  DISPATCH_TOKEN_CHECK,
  loadWorkflow,
  runStepScript,
  type Step,
} from './indexer-autochain-workflow.helpers.ts'

const PAT_EXPR = '${{ secrets.BACKFILL_AUTOCHAIN_DISPATCH_PAT }}'
const NOT_PROVISIONED = 'BACKFILL_AUTOCHAIN_DISPATCH_PAT is not provisioned'

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
// The step that dispatches, found the way the structure tests find it.
const dispatchStep = steps.find((s) => (s.run ?? '').includes('gh workflow run'))!
const verifyReadStep = steps.find((s) => (s.run ?? '').includes('--verify-read'))!
const verifyStep = byName('Verify the dispatch credential (verify only)')
const preclaim = byId('preclaim')

// Stubs for the dispatch step: the read script, and `timeout` running its command after dropping
// the duration. `gh` is stubbed per test so each can record what it needs.
const readStub = { 'scripts/ci/autochain-read-enable.sh': 'echo read >> "$MARK"; exit 0\n' }
const timeoutStub = { 'bin/timeout': 'shift; exec "$@"\n' }
const recordingGh = 'echo "gh token=$GH_TOKEN argv=$*" >> "$MARK"; exit 0\n'
// A probe stub: records the call and answers like `gh api ... --jq .state` for a workflow state.
const probeGh = (state: string) => `echo "gh token=$GH_TOKEN argv=$*" >> "$MARK"; echo ${state}\n`

describe('the dispatch credential is the PAT, never GITHUB_TOKEN', () => {
  it('1. the dispatch step GH_TOKEN is exactly the PAT secret (no fallback expression)', () => {
    expect(dispatchStep.env!.GH_TOKEN).toBe(PAT_EXPR)
  })

  it('2. no env the dispatch step inherits, and nothing in its script, can supply the job token', () => {
    const w = doc as unknown as { env?: Record<string, string> }
    for (const [where, env] of [
      ['workflow env', w.env],
      ['job env', job.env],
      ['dispatch step env', dispatchStep.env],
    ] as [string, Record<string, string> | undefined][]) {
      const text = JSON.stringify(env ?? {})
      expect(text, where).not.toContain('secrets.GITHUB_TOKEN')
      expect(text, where).not.toContain('github.token')
    }
    // The only command allowed to assign GH_TOKEN is the enable read (scoped to that one command).
    const cmds = commands(dispatchStep.run!)
    const dispatchCmd = cmds.find((c) => c.includes('gh workflow run'))!
    expect(dispatchCmd).not.toMatch(/\b(GH_TOKEN|GITHUB_TOKEN)=/)
    const others = cmds.filter(
      (c) => c !== dispatchCmd && !c.startsWith('GH_TOKEN="$VARIABLE_READ_PAT" bash ')
    )
    expect(others.join('\n')).not.toMatch(/\b(GH_TOKEN|GITHUB_TOKEN)=|\bexport\b/)
    // Paired presence control in the same run: the probe can see the string it says is absent, so a
    // pass above is not a probe that cannot match. The newest-run fence DOES use the job token.
    expect(JSON.stringify(byId('fence'))).toContain('secrets.GITHUB_TOKEN')
  })

  it('3. the job token can read Actions but not write them', () => {
    const permissions = (job as unknown as { permissions: Record<string, string> }).permissions
    expect(permissions).toEqual({ actions: 'read', contents: 'read' })
  })

  it('4. an empty dispatch token is red before the read and the dispatch; a set one reaches both', () => {
    const run = (token: string) =>
      runStepScript(dispatchStep.run!, {
        env: { GH_TOKEN: token, VARIABLE_READ_PAT: 'read-sentinel' },
        stubs: { ...readStub, ...timeoutStub, 'bin/gh': recordingGh },
      })
    const empty = run('')
    expect(empty.status, empty.err).toBe(1)
    expect(empty.marks, 'neither the read nor the dispatch may run').toEqual([])
    expect(empty.err).toContain(NOT_PROVISIONED)
    // CONTROL: same stubs and env, token set -> the read and the dispatch both ran.
    const set = run('pat-sentinel')
    expect(set.status, set.err).toBe(0)
    expect(set.marks[0]).toBe('read')
    expect(set.marks[1]).toMatch(/^gh token=/)
  })

  it('7. the token the dispatched `gh` process actually sees is the PAT, and it carries --ref main', () => {
    const r = runStepScript(dispatchStep.run!, {
      env: { GH_TOKEN: 'pat-sentinel', VARIABLE_READ_PAT: 'read-sentinel' },
      stubs: { ...readStub, ...timeoutStub, 'bin/gh': recordingGh },
    })
    expect(r.status, r.err).toBe(0)
    const ghCalls = r.marks.filter((m) => m.startsWith('gh '))
    expect(ghCalls, r.err).toHaveLength(1)
    expect(ghCalls[0]).toMatch(/^gh token=pat-sentinel argv=/)
    expect(ghCalls[0]).toContain('workflow run indexer-backfill.yml --repo o/r --ref main')
    // never the read-only PAT
    expect(ghCalls[0]).not.toContain('read-sentinel')
    // the static command pins the same ref
    expect(commands(dispatchStep.run!).find((c) => c.includes('gh workflow run'))).toContain(
      '--ref main'
    )
  })

  it('8. a failed dispatch (gh exits non-zero) is red and never reports success', () => {
    // A green step after a failed `gh workflow run` would be the silent stop again: no next run,
    // no alert. Pins that nothing in the step swallows the dispatch's exit status (e.g. `|| true`).
    const failingGh = 'echo "gh token=$GH_TOKEN argv=$*" >> "$MARK"; echo "HTTP 403" >&2; exit 1\n'
    const r = runStepScript(dispatchStep.run!, {
      env: { GH_TOKEN: 'pat-sentinel', VARIABLE_READ_PAT: 'read-sentinel' },
      stubs: { ...readStub, ...timeoutStub, 'bin/gh': failingGh },
    })
    expect(r.status, r.err).not.toBe(0)
    expect(r.marks[0], 'the enable read ran first').toBe('read')
    expect(
      r.marks.filter((m) => m.startsWith('gh ')),
      'exactly one dispatch attempt'
    ).toHaveLength(1)
    expect(r.err).not.toContain('Re-dispatched indexer-backfill.yml')
  })

  it('the first command of the dispatch step is the shared token check', () => {
    expect(commands(dispatchStep.run!)[0]).toBe(DISPATCH_TOKEN_CHECK)
  })
})

describe('the same check guards the claim (preclaim)', () => {
  const probeCmd = () => commands(preclaim.run!)[1]
  const run = (pat: string, ghStub: string) =>
    runStepScript(preclaim.run!, {
      env: { DISPATCH_PAT: pat, VARIABLE_READ_PAT: 'read-sentinel' },
      stubs: { ...readStub, 'bin/gh': ghStub },
    })

  it('5. preclaim reads the PAT through its own env var and checks it before anything else', () => {
    expect(preclaim.env!.DISPATCH_PAT).toBe(PAT_EXPR)
    // the existing read keeps its per-command token
    expect(preclaim.env!.VARIABLE_READ_PAT).toContain('secrets.BACKFILL_VARIABLE_READ_PAT')
    const cmds = commands(preclaim.run!)
    expect(cmds[0]).toMatch(/^\[ -n "\$DISPATCH_PAT" \] \|\| \{ echo "::error::/)
    expect(cmds[0]).toContain(NOT_PROVISIONED)
    expect(cmds[0]).toMatch(/exit 1; \}$/)
    expect(probeCmd()).toMatch(/^STATE=\$\(GH_TOKEN="\$DISPATCH_PAT" gh api /)
    expect(cmds[2]).toMatch(/^\[ "\$STATE" = active \] \|\| \{ echo "::error::/)
    expect(cmds.at(-1)).toBe(
      'GH_TOKEN="$VARIABLE_READ_PAT" bash scripts/ci/autochain-read-enable.sh'
    )
  })

  it('5. an empty PAT is red with no probe and no read; a valid one runs the probe then the read', () => {
    const empty = run('', 'echo probe >> "$MARK"; exit 0\n')
    expect(empty.status, empty.err).toBe(1)
    expect(empty.marks).toEqual([])
    expect(empty.err).toContain(NOT_PROVISIONED)
    // CONTROL: the probe saw the PAT, then the read ran
    const ok = run('pat-sentinel', probeGh('active'))
    expect(ok.status, ok.err).toBe(0)
    expect(ok.marks[0]).toMatch(/^gh token=pat-sentinel argv=api repos\/o\/r\/actions\/workflows\//)
    expect(ok.marks[1]).toBe('read')
  })

  it('5. an unusable PAT fails the probe before the read, with its own message', () => {
    const bad = run('pat-sentinel', 'echo probe >> "$MARK"; exit 1\n')
    expect(bad.status, bad.err).toBe(1)
    expect(bad.marks, 'the read must not run after a failed probe').toEqual(['probe'])
    expect(bad.err).toContain('cannot read Actions')
  })

  it('5. a workflow that is not active fails before the claim, and before the read', () => {
    const off = run('pat-sentinel', probeGh('disabled_manually'))
    expect(off.status, off.err).toBe(1)
    expect(off.marks.map((m) => m.split(' ')[0])).toEqual(['gh'])
    expect(off.err).toContain('is not active (state: disabled_manually)')
    expect(off.err).not.toContain('cannot read Actions')
  })
})

describe('the verify-only step proves the stored secret without dispatching', () => {
  it('6. it has the verify-read gate, uses the PAT and never dispatches', () => {
    expect(verifyStep.if).toBe(verifyReadStep.if)
    expect(verifyStep.env!.GH_TOKEN).toBe(PAT_EXPR)
    expect(verifyStep.run).not.toContain('gh workflow run')
    expect(commands(verifyStep.run!)[0]).toMatch(/^\[ -n "\$GH_TOKEN" \] \|\| \{ echo "::error::/)
    expect(steps.indexOf(verifyStep)).toBeGreaterThan(steps.findIndex((x) => x.name === 'Checkout'))
    expect(steps.indexOf(verifyStep)).toBeLessThan(steps.indexOf(dispatchStep))
  })

  it('6. executed: an empty secret is red without a call; a set one reads the workflow state', () => {
    const run = (token: string) =>
      runStepScript(verifyStep.run!, {
        env: { GH_TOKEN: token },
        stubs: { 'bin/gh': probeGh('active') },
      })
    const empty = run('')
    expect(empty.status, empty.err).toBe(1)
    expect(empty.marks).toEqual([])
    expect(empty.err).toContain(NOT_PROVISIONED)
    const ok = run('pat-sentinel')
    expect(ok.status, ok.err).toBe(0)
    expect(ok.marks).toHaveLength(1)
    expect(ok.marks[0]).toMatch(/^gh token=pat-sentinel argv=api repos\/o\/r\/actions\/workflows\//)
    expect(ok.marks[0]).not.toContain('workflow run')
  })

  it('6. executed: a failing probe call is red, with the cannot-read message', () => {
    const r = runStepScript(verifyStep.run!, {
      env: { GH_TOKEN: 'pat-sentinel' },
      stubs: { 'bin/gh': 'echo probe >> "$MARK"; exit 1\n' },
    })
    expect(r.status, r.err).not.toBe(0)
    expect(r.marks).toEqual(['probe'])
    expect(r.err).toContain('cannot read Actions')
  })

  it('6. executed: a workflow that is not active is red', () => {
    const r = runStepScript(verifyStep.run!, {
      env: { GH_TOKEN: 'pat-sentinel' },
      stubs: { 'bin/gh': probeGh('disabled_manually') },
    })
    expect(r.status, r.err).toBe(1)
    expect(r.err).toContain('is not active (state: disabled_manually)')
    expect(r.err).not.toContain('cannot read Actions')
  })
})
