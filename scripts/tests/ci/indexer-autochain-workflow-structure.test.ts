/**
 * SMI-7112 (1.4): structural contract for indexer-backfill-autochain.yml.
 *
 * These pin the properties that make the autochain safe, as YAML facts a refactor
 * cannot silently drop: manual-dispatch support, the DISPATCH_ALLOWED gate on
 * every side effect, and -- the one that matters most -- the authoritative
 * enable read being the command IMMEDIATELY before the dispatch.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'indexer-backfill-autochain.yml')

interface Step {
  name?: string
  id?: string
  if?: string
  env?: Record<string, string>
  run?: string
  uses?: string
}
const doc = parseYaml(readFileSync(WORKFLOW, 'utf8')) as {
  on: Record<string, unknown>
  jobs: { autochain: { if: string; env: Record<string, string>; steps: Step[] } }
}
const job = doc.jobs.autochain
const steps = job.steps

/** Executable commands of a `run:` block: comments/blanks dropped, `\` continuations joined. */
function commands(run: string): string[] {
  const out: string[] = []
  let acc = ''
  for (const raw of run.split('\n')) {
    const line = raw.trim()
    if (acc === '' && (line === '' || line.startsWith('#'))) continue
    if (line.endsWith('\\')) {
      acc += line.slice(0, -1).trim() + ' '
      continue
    }
    out.push((acc + line).trim())
    acc = ''
  }
  if (acc) out.push(acc.trim())
  return out
}
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
      /gh workflow run|alert-notify|\bsleep\b/.test(commands(s.run ?? '').join('\n'))
    )
    expect(risky.length).toBeGreaterThanOrEqual(4) // cooldown, retry-cap alert, dispatch, failure alert
    const ungated = risky
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

    it('SEQUENCE: before the dispatch there are EXACTLY two commands, the fence then the read, each a single simple command', () => {
      const cmds = commands(dispatchStep!.run!)
      const at = cmds.findIndex((c) => c.startsWith('timeout 60 gh workflow run'))
      expect(cmds.slice(0, at), `commands: ${JSON.stringify(cmds)}`).toEqual([
        'bash scripts/ci/autochain-newest-run-fence.sh || exit $?',
        'GH_TOKEN="$VARIABLE_READ_PAT" bash scripts/ci/autochain-read-enable.sh || exit 1',
      ])
      // nothing alters the shell's error handling or the step's execution, and nothing runs in the background
      const whole = commands(dispatchStep!.run!).join('\n')
      expect(whole).not.toMatch(/\bset\s+[+-]|\btrap\b|\bsleep\b|\bwait\b|(^|[^&])&\s*$/m)
      expect(dispatchStep).not.toHaveProperty('continue-on-error')
      expect(dispatchStep).not.toHaveProperty('shell')
    })

    it('the newest-run fence is the command directly above the read (so read stays adjacent to the dispatch)', () => {
      const cmds = commands(dispatchStep!.run!)
      const read = cmds.findIndex((c) => c.includes('autochain-read-enable.sh'))
      expect(read, `commands: ${JSON.stringify(cmds)}`).toBeGreaterThan(0)
      // The fence's own exit status must be the step's: a lossy wrapper (`|| exit 1`) collapses
      // its documented 3 (skipped loudly) into 1 (could not evaluate).
      expect(cmds[read - 1]).toMatch(
        /^bash scripts\/ci\/autochain-newest-run-fence\.sh \|\| exit \$\?$/
      )
      expect(cmds[read - 1]).not.toMatch(/exit [0-9]/)
      // the dispatch step runs the read WITHOUT --verify-read (which authorises nothing)
      expect(cmds[read]).not.toContain('--verify-read')
    })

    it('the fence is told the triggering ATTEMPT and event (a re-run keeps its run id)', () => {
      expect(dispatchStep!.env!.TRIGGER_EVENT).toContain('github.event_name')
      expect(dispatchStep!.env!.TRIGGER_RUN_ATTEMPT).toContain(
        'github.event.workflow_run.run_attempt'
      )
      expect(dispatchStep!.env!.TRIGGER_RUN_ATTEMPT).toContain('inputs.completed_run_attempt')
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

describe('the dispatch step executed with stubbed scripts (exit-status propagation)', () => {
  /** Run the dispatch step's real `run:` text the way Actions does, with the three scripts stubbed. */
  function runStep(fenceRc: number, readRc: number, shellFlags: string[]) {
    const dir = mkdtempSync(join(tmpdir(), 'smi7112-wf-'))
    mkdirSync(join(dir, 'scripts', 'ci'), { recursive: true })
    mkdirSync(join(dir, 'bin'))
    const stub = (p: string, body: string) => {
      writeFileSync(p, body)
      chmodSync(p, 0o755)
    }
    stub(
      join(dir, 'scripts/ci/autochain-newest-run-fence.sh'),
      `echo fence >> "$MARK"; exit ${fenceRc}\n`
    )
    stub(join(dir, 'scripts/ci/autochain-read-enable.sh'), `echo read >> "$MARK"; exit ${readRc}\n`)
    stub(join(dir, 'bin/timeout'), 'shift; echo dispatch >> "$MARK"; exit 0\n')
    const script = join(dir, 'step.sh')
    writeFileSync(script, dispatchStep!.run!.replace(/\$\{\{[^}]*\}\}/g, 'x'))
    const r = spawnSync('bash', [...shellFlags, script], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
        MARK: join(dir, 'marks'),
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_RUN_ID: '1',
        VARIABLE_READ_PAT: 'pat',
      },
    })
    const marks = existsSync(join(dir, 'marks'))
      ? readFileSync(join(dir, 'marks'), 'utf8').trim()
      : ''
    return { status: r.status, marks: marks === '' ? [] : marks.split('\n'), err: r.stderr }
  }

  describe.each([
    ['bash -e (the Actions default)', ['-e']],
    ['bash -eo pipefail', ['-eo', 'pipefail']],
  ] as [string, string[]][])('under %s', (_n, flags) => {
    it('CONTROL: fence 0 and read 0 reach the dispatch', () => {
      const r = runStep(0, 0, flags)
      expect(r.marks, r.err).toEqual(['fence', 'read', 'dispatch'])
      expect(r.status).toBe(0)
    })

    it('fence exit 3 (skipped loudly) is the step exit status: 3, no read, no dispatch', () => {
      const r = runStep(3, 0, flags)
      expect(r.status).toBe(3)
      expect(r.marks).toEqual(['fence'])
    })

    it('fence exit 1 (could not evaluate) is the step exit status: 1, no read, no dispatch', () => {
      const r = runStep(1, 0, flags)
      expect(r.status).toBe(1)
      expect(r.marks).toEqual(['fence'])
    })

    it('a failing enable read stops the step before the dispatch', () => {
      const r = runStep(0, 4, flags)
      expect(r.status).toBe(1)
      expect(r.marks).toEqual(['fence', 'read'])
    })
  })
})
