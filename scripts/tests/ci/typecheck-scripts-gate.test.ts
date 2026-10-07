/**
 * SMI-6975 — control harness for scripts/ci/typecheck-scripts.sh.
 *
 * WHY THIS FILE EXISTS. The gate's thesis is "no step fails silently," and it
 * shipped twice with a silent-success path anyway. The second one (H1) sat on
 * the single comparison the script's own header calls the reconciliation:
 * `SET_DIFF="$(diff A B || true)"` followed by an emptiness test, where `diff`
 * exits >=2 on error writing nothing to stdout — so the variable was empty for
 * two different reasons and the gate printed PASS plus a `checked` count whose
 * caption claimed an equality that had never been established.
 *
 * H1 survived a review round that explicitly hunted for exactly its shape. The
 * reason is instructive and is the argument for this file: every control in
 * that round was a one-off manual shim, and the author ran the stub experiment
 * for `perl` and not for `diff`. A control you run once proves a fact; a
 * control that lives in the suite proves it again after the next edit.
 *
 * THE THREE-WAY OUTCOME. Each arm below distinguishes three states, not two,
 * and the failure clause is asserted FIRST so that reordering this table
 * breaks the test rather than silently weakening it:
 *
 *   INCONCLUSIVE  the gate could not establish the property  (exit != 0)
 *   FAIL          the gate established it and it is violated (exit != 0)
 *   PASS          the gate established it and it holds       (exit == 0)
 *
 * Collapsing the first two is the defect this gate exists to prevent, so a
 * test that only asserted "exit non-zero" would pass for the wrong reason.
 *
 * COST. One full gate run is ~3s (measured), so these spawn the real script
 * rather than mocking it. Nothing here stubs `tsc`: the gate resolves it as a
 * fixed path (`$REPO_ROOT/node_modules/.bin/tsc`), and a harness that replaced
 * the compiler would stop testing the thing under test.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// Derived from this file's own location, NOT from `git rev-parse`. Under
// Docker-first the container sees /app as a bind mount whose .git is a FILE
// pointing at a host path that does not exist inside the container, so
// `git rev-parse --show-toplevel` fails outright there — measured. A path
// relative to this file is correct in both the container and on the host.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const GATE = join(REPO_ROOT, 'scripts', 'ci', 'typecheck-scripts.sh')

/** Every arm gets the same budget; a hang is a failure, not a slow pass. */
const RUN_TIMEOUT_MS = 120_000

interface GateRun {
  status: number
  out: string
}

/**
 * Runs the real gate, optionally with a PATH-prepended directory of stubs.
 *
 * `status` is read from spawnSync directly rather than through a pipe: a
 * POSIX pipeline reports its LAST command's status, which is how a failing
 * producer gets read as success. Null (signal-killed) is NOT coerced to 0 —
 * that coercion is itself a silent-success bug, and it exists elsewhere in
 * this repo's hook harnesses.
 */
function runGate(stubDir?: string): GateRun {
  const env = { ...process.env }
  if (stubDir) env.PATH = `${stubDir}:${env.PATH ?? ''}`
  const r = spawnSync('bash', [GATE], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
    env,
  })
  if (r.status === null) {
    throw new Error(
      `gate was terminated by a signal (${r.signal ?? 'unknown'}) rather than exiting — ` +
        `this is neither PASS nor FAIL and must not be read as either`
    )
  }
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

/** Writes an executable stub that shadows `name` on PATH. */
function makeStub(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, body)
  chmodSync(p, 0o755)
}

const scratch: string[] = []
function scratchDir(tag: string): string {
  // tmpdir(), not anywhere under REPO_ROOT: in a worktree container
  // node_modules is mounted :ro by design (SMI-5560/5626), so writing a stub
  // there fails ENOENT/EROFS — measured. The stub only needs to be on PATH.
  const d = join(tmpdir(), `smi6975-gate-${tag}-${process.pid}-${scratch.length}`)
  mkdirSync(d, { recursive: true })
  scratch.push(d)
  return d
}

afterEach(() => {
  while (scratch.length) {
    const d = scratch.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

describe('SMI-6975 typecheck-scripts.sh — the gate reports PASS only when it established the property', () => {
  it('control: a clean tree PASSES, and the two derivations reconcile', () => {
    const r = runGate()
    // Failure clause first: if this arm is INCONCLUSIVE, every other arm in
    // this file is testing nothing, because they all distinguish themselves
    // from this baseline.
    expect(r.out).not.toContain('RESULT         INCONCLUSIVE')
    expect(r.out).toContain('RESULT         EVALUATED')
    expect(r.out).toContain('VERDICT        PASS')
    expect(r.status).toBe(0)
    // The reconciliation is a SET comparison of two independent derivations.
    // Assert both were derived and agree, not merely that a number appeared.
    const discovered = /discovered\s+(\d+)/.exec(r.out)?.[1]
    const roots = /compiler roots\s+(\d+)/.exec(r.out)?.[1]
    const checked = /checked\s+(\d+)/.exec(r.out)?.[1]
    expect(discovered).toBeDefined()
    expect(roots).toBe(discovered)
    expect(checked).toBe(discovered)
  })

  it('H1 regression: when `diff` itself fails, the gate is INCONCLUSIVE — never PASS', () => {
    // The defect: `diff` exits >=2 on error and writes NOTHING to stdout, so a
    // `|| true` + emptiness test took the "sets agree" branch. Reproduced live
    // before the fix: VERDICT PASS, exit 0, and `checked 266`.
    const dir = scratchDir('diff')
    makeStub(dir, 'diff', '#!/bin/sh\necho "diff: simulated failure" >&2\nexit 2\n')

    // Known-positive control on the instrument itself: a stub that does not
    // actually fail the way we think would make this whole arm vacuous.
    const probe = spawnSync('diff', ['a', 'b'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
    })
    expect(probe.status).toBe(2)
    expect(probe.stdout ?? '').toBe('')

    const r = runGate(dir)
    expect(r.out).toContain('RESULT         INCONCLUSIVE')
    expect(r.out).toContain('the set comparison itself failed')
    expect(r.status).not.toBe(0)
    // The specific false claim H1 produced: a `checked` count whose own caption
    // says it is set only once the two derivations were compared. If the
    // comparison did not run, this must not be a number.
    expect(r.out).not.toMatch(/checked\s+\d+/)
    // And it must not report the outcome it could not establish.
    expect(r.out).not.toContain('VERDICT        PASS')
  })

  it('when the ANSI/NUL strip fails, the gate is INCONCLUSIVE and keeps the diagnostic', () => {
    const dir = scratchDir('perl')
    makeStub(dir, 'perl', '#!/bin/sh\nexit 13\n')
    const r = runGate(dir)
    expect(r.out).toContain('RESULT         INCONCLUSIVE')
    expect(r.out).toContain('exit 13')
    expect(r.status).not.toBe(0)
    expect(r.out).not.toContain('VERDICT        PASS')
    // M3: the next-action must not point at an mktemp path the EXIT trap has
    // already removed. The content is dumped inline instead.
    expect(r.out).toContain('first 20 lines of the raw tsc output')
  })

  it('an unclassified extension under scripts/ is INCONCLUSIVE and names the file', () => {
    // The inventory classifies every file against a closed table. Anything it
    // does not recognise must stop the gate rather than be silently dropped
    // from one of the two derivations — which is how they could agree on a
    // number while both omitting the same category.
    const planted = join(REPO_ROOT, 'scripts', `zz-smi6975-probe-${process.pid}.probeext`)
    try {
      writeFileSync(planted, '# planted by typecheck-scripts-gate.test.ts\n')
      const r = runGate()
      expect(r.out).toContain('RESULT         INCONCLUSIVE')
      expect(r.out).toContain('extension this gate does not classify')
      expect(r.status).not.toBe(0)
      expect(r.out).not.toContain('VERDICT        PASS')
    } finally {
      rmSync(planted, { force: true })
    }
    // Prove the planted file was the cause and the tree is clean again —
    // otherwise a leaked probe file would break this gate for every later run.
    expect(existsSync(planted)).toBe(false)
    const after = runGate()
    expect(after.status).toBe(0)
  })

  it('H2 regression: the attribution anchor matches diagnostics outside scripts/', () => {
    // 16 non-test scripts import ../../packages/core/src/..., so packages/
    // sources enter the program: measured with --listFiles, 1402 program files
    // of which 110 are non-.d.ts sources under packages/, all fully checked
    // (skipLibCheck only skips .d.ts). A `^scripts/` anchor could not see a
    // diagnostic in any of them, so REPORTED would be 1 and ATTRIB 0 — firing
    // the mismatch arm with a next-action blaming the header parser.
    //
    // The regex is EXTRACTED from the gate rather than restated here. A copy
    // would keep passing after someone narrowed the real one.
    const src = readFileSync(GATE, 'utf8')
    const m = /^ATTRIB_RE='(.+)'$/m.exec(src)
    expect(
      m,
      'ATTRIB_RE assignment not found in the gate — did it move or change shape?'
    ).not.toBeNull()
    const attribRe = (m as RegExpExecArray)[1]

    // Run the gate's own regex through the gate's own matcher (grep -E), not a
    // JS translation of it, so this tests the engine that actually runs.
    const grepMatches = (line: string): boolean =>
      spawnSync('grep', ['-cE', attribRe], { input: line, encoding: 'utf8' }).status === 0

    // Known-positive: a scripts/ diagnostic must match (if this fails, the
    // negative assertion below proves nothing).
    expect(
      grepMatches("scripts/foo.ts:1:14 - error TS2322: Type 'string' is not assignable.")
    ).toBe(true)
    // The regression itself: a packages/ diagnostic must ALSO match.
    expect(
      grepMatches("packages/core/src/x.ts:1:14 - error TS2322: Type 'string' is not assignable.")
    ).toBe(true)
    // Known-negative: an indented continuation line must NOT match, or the
    // count would exceed one per diagnostic block and stop reconciling.
    expect(grepMatches("  2 const x: number = 'y';")).toBe(false)
  })
})
