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
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

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
function runGate(
  stubDir?: string,
  extraEnv?: Record<string, string>,
  unsetEnv: string[] = []
): GateRun {
  const env = { ...process.env, ...extraEnv }
  for (const k of unsetEnv) delete env[k]
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

/**
 * Scans shell source lines for `inconclusive "` arms. Each arm must reach its
 * own `exit_for_inconclusive` (matched as code, never inside a comment) before
 * any other arm begins, and the last NEXT_ACTION assignment before that exit
 * must carry text. Offenders are returned as `<line> [reason]`.
 */
function scanInconclusiveArms(lines: string[]): { armCount: number; offenders: string[] } {
  const isComment = (l: string): boolean => /^\s*#/.test(l)
  const isArm = (l: string): boolean => !isComment(l) && /\binconclusive "/.test(l)
  const isExit = (l: string): boolean => /^\s*exit_for_inconclusive\b(?!\s*\(\))/.test(l)
  const offenders: string[] = []
  let armCount = 0
  lines.forEach((line, i) => {
    if (!isArm(line)) return
    armCount += 1
    // The LAST NEXT_ACTION assignment before the exit is the one finish()
    // renders, so it is the one that must carry text.
    let last: string | null = null
    let reachedExit = false
    for (let j = i + 1; j < lines.length; j += 1) {
      if (isArm(lines[j])) break
      if (/^\s*(NEXT_ACTION=|printf\s+-v\s+NEXT_ACTION\b)/.test(lines[j])) last = lines[j]
      if (isExit(lines[j])) {
        reachedExit = true
        break
      }
    }
    if (!reachedExit) {
      offenders.push(`${i + 1} (no exit_for_inconclusive before the next arm or end of file)`)
      return
    }
    if (last === null || !assignsNextAction(last)) offenders.push(`${i + 1}`)
  })
  return { armCount, offenders }
}

/**
 * True only for a line that is an actual `NEXT_ACTION=` assignment whose value
 * carries literal text. A bare `includes('NEXT_ACTION=')` is satisfied by a
 * comment, an `echo`, or an empty assignment; and a source-level non-empty
 * check is still satisfied by `NEXT_ACTION="$UNSET"` or `"$(printf '')"`,
 * which RENDER empty (finish() tests the expanded value). So expansions are
 * stripped first and the remainder must contain a non-space character: a value
 * made only of expansions is rejected, because its rendered text cannot be
 * shown to be non-empty from the source. The behavioural test below is the
 * check on what actually rendered.
 */
function assignsNextAction(line: string): boolean {
  // `printf -v NEXT_ACTION "fmt" args` is an assignment too; its format and
  // arguments are scanned exactly like an `=` value.
  const m = /^\s*(?:NEXT_ACTION=|printf\s+-v\s+NEXT_ACTION\s+)(.*)$/.exec(line)
  if (!m) return false
  // $(...) is stripped innermost-first until stable, so nested substitutions
  // like $(echo $(date)) are removed whole rather than leaving ")" behind. A
  // value that is ONLY command substitutions is rejected even if the command
  // prints literal text (e.g. $(printf 'run foo')): its rendered text cannot be
  // shown from the source, so this errs toward flagging (the behavioural test
  // checks what actually rendered).
  let v = m[1].replace(/`[^`]*`/g, '') // `cmd`
  for (let prev = ''; prev !== v; ) {
    prev = v
    v = v.replace(/\$\([^()]*\)/g, '') // innermost $(cmd)
  }
  const literal = v
    .replace(/\$\{[^}]*\}/g, '') // ${X}, ${X:-}
    .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, '') // $X
    .replace(/["']/g, '') // quote characters carry no text
  return /\S/.test(literal)
}

/** Absolute path of a real tool, resolved at run time (never hard-coded). */
function realTool(name: string): string {
  const p = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim()
  if (!p.startsWith('/')) throw new Error(`could not resolve ${name} to an absolute path: ${p}`)
  return p
}

/** Writes an executable stub that shadows `name` on PATH. */
function makeStub(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, body)
  chmodSync(p, 0o755)
}

/** A tsc stand-in that records that it ran, then defers to the real compiler. */
function markingStub(marker: string, real: string): string {
  return `#!/bin/sh\ntouch '${marker}'\nexec ${real} "$@"\n`
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

// Sequential, and swept: these tests plant files under scripts/ and overwrite
// tsconfig.scripts.json in the LIVE tree (a temp copy would need node_modules
// and the packages/ import closure, which is not cheap or faithful). Each test
// restores in `finally`, but a SIGKILL skips that, so leftovers from a killed
// run are swept before the first test.
beforeAll(() => {
  const dir = join(REPO_ROOT, 'scripts')
  for (const f of readdirSync(dir)) {
    if (f.startsWith('zz-smi6975-')) rmSync(join(dir, f), { force: true })
  }
})

describe.sequential('SMI-6975 typecheck-scripts.sh gate: PASS only when established', () => {
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
    //
    // Two extensions, two claims: `.probeext` is an arbitrary unknown; `.js` is
    // the one the helper's comment singles out as deliberately NOT pre-classified
    // (0 exist today), so a future edit adding it to the excluded-JS set would
    // otherwise turn it into a silent exclusion.
    const planted: string[] = []
    try {
      for (const ext of ['.probeext', '.js']) {
        const name = `zz-smi6975-probe-${process.pid}${ext}`
        const file = join(REPO_ROOT, 'scripts', name)
        planted.push(file)
        writeFileSync(file, '# planted by typecheck-scripts-gate.test.ts\n')
        const r = runGate()
        expect(r.out, `${ext}: RESULT`).toContain('RESULT         INCONCLUSIVE')
        expect(r.out, `${ext}: cause`).toContain('extension this gate does not classify')
        expect(r.out, `${ext}: names the file`).toContain(name)
        expect(r.status, `${ext}: exit`).not.toBe(0)
        expect(r.out, `${ext}: verdict`).not.toContain('VERDICT        PASS')
        rmSync(file, { force: true })
      }
    } finally {
      for (const f of planted) rmSync(f, { force: true })
    }
    // Prove the planted files were the cause and the tree is clean again —
    // otherwise a leaked probe file would break this gate for every later run.
    for (const f of planted) expect(existsSync(f)).toBe(false)
    const after = runGate()
    expect(after.status).toBe(0)
  })

  it('every INCONCLUSIVE arm prints a next: action', () => {
    // M2. The gate models typecheck-edge-functions.sh's contract, whose own
    // CLAUDE.md row promises "Every state prints one next action". Seven arms
    // in the main script and one in the helpers printed none, so a reader hit
    // "could not run" with nothing to do about it.
    //
    // Asserted statically over the source rather than by running every arm:
    // several are only reachable by breaking a system tool, and a test that
    // can only cover the arms that are easy to trigger would leave exactly the
    // obscure ones unprotected — which is where they were.
    const files = ['typecheck-scripts.sh', 'typecheck-scripts.helpers.sh']
    const offenders: string[] = []
    let armCount = 0
    for (const f of files) {
      const lines = readFileSync(join(REPO_ROOT, 'scripts', 'ci', f), 'utf8').split('\n')
      const r = scanInconclusiveArms(lines)
      armCount += r.armCount
      for (const o of r.offenders) offenders.push(`${f}:${o}`)
    }
    // Known-positive on the scanner itself: if it found no arms at all it is
    // matching nothing, and an empty offenders list would mean nothing.
    expect(armCount).toBeGreaterThan(10)
    // Known-positive / known-negative on the scan: an arm with no exit of its
    // own must not borrow the NEXT_ACTION and exit of the arm after it.
    const borrowing = [
      'inconclusive "first"',
      'NEXT_ACTION="x"',
      'inconclusive "second"',
      'NEXT_ACTION="y"',
      'exit_for_inconclusive',
    ]
    const borrowed = scanInconclusiveArms(borrowing).offenders
    expect(borrowed, 'borrowing arm flagged').toHaveLength(1)
    expect(borrowed[0]).toMatch(/^1 /)
    // A comment that merely mentions exit_for_inconclusive is not an exit.
    expect(
      scanInconclusiveArms([
        'inconclusive "only"',
        'NEXT_ACTION="x"',
        '# falls through to exit_for_inconclusive below',
      ]).offenders,
      'comment-only exit flagged'
    ).toHaveLength(1)
    // A normal arm passes.
    expect(
      scanInconclusiveArms(['inconclusive "ok"', 'NEXT_ACTION="x"', '  exit_for_inconclusive'])
        .offenders,
      'normal arm clean'
    ).toEqual([])
    // Known-positive / known-negative on the predicate: the forgeries a plain
    // substring test accepts must be rejected, and a real assignment accepted.
    expect(assignsNextAction('    NEXT_ACTION="re-run the gate"')).toBe(true)
    expect(assignsNextAction('NEXT_ACTION=fixed-word')).toBe(true)
    expect(assignsNextAction('    # NEXT_ACTION="re-run the gate"')).toBe(false)
    expect(assignsNextAction('    echo "NEXT_ACTION=re-run"')).toBe(false)
    expect(assignsNextAction('    NEXT_ACTION=""')).toBe(false)
    expect(assignsNextAction("    NEXT_ACTION=''")).toBe(false)
    expect(assignsNextAction('    NEXT_ACTION=')).toBe(false)
    // Expansion-only values render empty at runtime (finish() tests the
    // expanded value) and must not count; literal text around an expansion must.
    expect(assignsNextAction('    NEXT_ACTION="$UNSET_VAR"')).toBe(false)
    expect(assignsNextAction('    NEXT_ACTION="${UNSET_VAR:-}"')).toBe(false)
    expect(assignsNextAction('    NEXT_ACTION="$(printf \'\')"')).toBe(false)
    expect(assignsNextAction('    NEXT_ACTION="`true`"')).toBe(false)
    expect(assignsNextAction('    NEXT_ACTION="fix $CONFIG; then re-run"')).toBe(true)
    expect(assignsNextAction('    printf -v NEXT_ACTION "re-run %s" "$X"')).toBe(true)
    expect(assignsNextAction('    printf -v NEXT_ACTION "$UNSET"')).toBe(false)
    expect(assignsNextAction('    printf -v OTHER "re-run"')).toBe(false)
    // Command-substitution-only values are rejected, including a nested one and
    // one whose command prints literal text (deliberately errs toward flagging).
    expect(assignsNextAction('    NEXT_ACTION="$(printf \'run foo\')"')).toBe(false)
    expect(assignsNextAction('    NEXT_ACTION="$(echo $(date))"')).toBe(false)
    expect(assignsNextAction('    NEXT_ACTION="fix $(echo $(date)) now"')).toBe(true)
    expect(offenders).toEqual([])
  })

  it('behavioural: every arm the harness can drive RENDERS a non-empty next: line', () => {
    // The static test above reads source; this one reads what was printed. An
    // assignment that expands empty passes the former and fails this. Arms are
    // driven by stubbing the one tool each depends on, with a stub that execs
    // the real binary for every other call so only the targeted call fails.
    //
    // NOT driven here (each needs the compiler, the filesystem or mktemp itself
    // broken rather than one pipeline stage): tsc missing/unrecognised, config
    // missing/unreadable, mktemp failure, find-over-scripts failure, the
    // --showConfig node-parse arm, the zero-roots arm (unreachable on this tsc),
    // the Found-line extraction/shape arms, the by-file pipeline stage arms, the
    // status-vs-output contract arms, and the attribution-mismatch arm. Those
    // stay covered by the static test only.
    const arms: Array<{ name: string; tool: string; body: string; cause: string }> = [
      {
        name: 'diff',
        tool: 'diff',
        body: '#!/bin/sh\nexit 2\n',
        cause: 'the set comparison itself failed',
      },
      {
        name: 'perl',
        tool: 'perl',
        body: '#!/bin/sh\nexit 13\n',
        cause: 'the ANSI/NUL-strip (perl) failed',
      },
      {
        name: 'global-grep',
        tool: 'grep',
        body: `#!/bin/sh\ncase "$*" in *'^error TS'*) exit 2 ;; esac\nexec ${realTool('grep')} "$@"\n`,
        cause: 'the global-diagnostic-shape grep failed',
      },
      {
        name: 'tests-find',
        tool: 'find',
        body: `#!/bin/sh\n[ "$1" = scripts/tests ] && exit 2\nexec ${realTool('find')} "$@"\n`,
        cause: 'find over scripts/tests failed',
      },
      {
        name: 'inventory-sort',
        tool: 'sort',
        body: '#!/bin/sh\ncat >/dev/null\nexit 2\n',
        cause: 'sort of the scripts/ file inventory failed',
      },
    ]
    for (const a of arms) {
      const dir = scratchDir(`next-${a.name}`)
      makeStub(dir, a.tool, a.body)
      const r = runGate(dir)
      // Failure clause first: if the arm did not fire, the next: assertion below
      // would be about a different arm entirely.
      expect(r.out, `${a.name}: RESULT`).toContain('RESULT         INCONCLUSIVE')
      expect(r.out, `${a.name}: cause`).toContain(a.cause)
      expect(r.status, `${a.name}: exit`).not.toBe(0)
      expect(r.out, `${a.name}: next line`).toMatch(/^ {2}next: \S/m)
    }
    // And an arm driven by a real input rather than a stub.
    const file = join(REPO_ROOT, 'scripts', `zz-smi6975-next-${process.pid}.probeext`)
    try {
      writeFileSync(file, 'x\n')
      const r = runGate()
      expect(r.out, 'unclassified ext: RESULT').toContain('RESULT         INCONCLUSIVE')
      expect(r.out, 'unclassified ext: next line').toMatch(/^ {2}next: \S/m)
    } finally {
      rmSync(file, { force: true })
    }
    expect(existsSync(file)).toBe(false)
  })

  it('scope regression: a SWAPPED root set with the SAME total is INCONCLUSIVE, never PASS', () => {
    // "Wrong scope, right total". The three variants above change the COUNT, so
    // a gate that compared counts would still pass them for the wrong reason.
    // This one keeps the count equal: drop one discovered file from the
    // compilation (exclude) and add one non-discovered file (files[] ignores
    // `exclude`). Only a SET comparison can see it.
    const configPath = join(REPO_ROOT, 'tsconfig.scripts.json')
    const original = readFileSync(configPath)
    const text = original.toString('utf8')
    const dropped = readdirSync(join(REPO_ROOT, 'scripts', 'lib')).find(
      (f) => f.endsWith('.ts') && !f.endsWith('.d.ts')
    )
    expect(dropped, 'no scripts/lib/*.ts to drop').toBeDefined()
    const added = 'scripts/tests/ci/typecheck-scripts-gate.test.ts'
    expect(existsSync(join(REPO_ROOT, added)), 'swap-in file must exist').toBe(true)
    expect(text.includes('"exclude": ['), 'exclude array not found').toBe(true)
    try {
      writeFileSync(
        configPath,
        text
          .replace('"exclude": [', `"exclude": [\n    "scripts/lib/${dropped}",`)
          .replace('"include":', `"files": ["${added}"],\n  "include":`)
      )
      const r = runGate()
      const discovered = /discovered\s+(\d+)/.exec(r.out)?.[1]
      const roots = /compiler roots\s+(\d+)/.exec(r.out)?.[1]
      // Known-positive on the premise: the totals really are equal, so only the
      // membership differs. Otherwise this would be the narrowed variant again.
      expect(discovered, 'discovered count printed').toBeDefined()
      expect(roots, 'compiler roots count printed').toBe(discovered)
      expect(r.out, 'RESULT').toContain('RESULT         INCONCLUSIVE')
      expect(r.out, 'cause').toContain('disagree -- scope could not be validated')
      expect(r.out, 'names the dropped file').toContain(`scripts/lib/${dropped}`)
      expect(r.out, 'names the swapped-in file').toContain(added)
      expect(r.status, 'exit').not.toBe(0)
      expect(r.out, 'verdict').not.toContain('VERDICT        PASS')
      expect(r.out, 'checked').not.toMatch(/checked\s+\d+/)
    } finally {
      writeFileSync(configPath, original)
    }
    expect(readFileSync(configPath).equals(original)).toBe(true)
    expect(runGate().status).toBe(0)
  })

  it('an ordinary type error is EVALUATED and FAIL, names the file, and is not INCONCLUSIVE', () => {
    // The permanent form of the plan's Step 4. Every other test here exercises
    // an instrument failure; nothing else proves the gate still does its actual
    // job. A gate that routed every non-zero compile to a generic
    // "global failure" arm would pass the clean control and the unreadable-file
    // test, and never say what was wrong with the code.
    const name = `zz-smi6975-typeerr-${process.pid}.ts`
    const file = join(REPO_ROOT, 'scripts', name)
    try {
      writeFileSync(file, "export const planted: number = 'not a number'\n")
      const r = runGate()
      // Failure clause first: INCONCLUSIVE would mean the gate could not say.
      expect(r.out, 'RESULT').not.toContain('RESULT         INCONCLUSIVE')
      expect(r.out, 'RESULT').toContain('RESULT         EVALUATED')
      expect(r.out, 'VERDICT').toContain('VERDICT        FAIL')
      expect(r.out, 'VERDICT').not.toContain('VERDICT        PASS')
      expect(r.status, 'exit').toBe(1)
      // Properties, not the rendered format: the planted file is named in the
      // by-file output, and the two derivations agree with each other.
      expect(r.out, 'names the file').toContain(`scripts/${name}`)
      const m = /(\d+) total \/ (\d+) attributed/.exec(r.out)
      expect(m, 'reconciliation line present').not.toBeNull()
      expect((m as RegExpExecArray)[1], 'total == attributed').toBe((m as RegExpExecArray)[2])
      expect(Number((m as RegExpExecArray)[1]), 'planted error counted').toBeGreaterThan(0)
    } finally {
      rmSync(file, { force: true })
    }
    expect(existsSync(file)).toBe(false)
    expect(runGate().status).toBe(0)
  })

  it('a compiler that hangs is INCONCLUSIVE (timeout), never PASS and never a hang', () => {
    // The gate bounds the full compile with a perl alarm (stock macOS has no
    // `timeout`). The shim answers --version/--showConfig like the real tsc and
    // hangs only on the full compile, so every earlier precondition passes and
    // the only thing under test is the timeout arm.
    const dir = scratchDir('hang')
    const real = join(REPO_ROOT, 'node_modules', '.bin', 'tsc')
    makeStub(
      dir,
      'tsc-hang',
      `#!/bin/sh\ncase "$*" in *--pretty*) exec sleep 600 ;; esac\nexec ${real} "$@"\n`
    )
    const t0 = Date.now()
    const r = runGate(undefined, {
      SKILLSMITH_TYPECHECK_SCRIPTS_TSC_TEST: join(dir, 'tsc-hang'),
      SKILLSMITH_TYPECHECK_SCRIPTS_TIMEOUT_SECS: '2',
    })
    const elapsed = Date.now() - t0
    expect(r.out, 'RESULT').toContain('RESULT         INCONCLUSIVE')
    expect(r.out, 'cause').toMatch(/did not finish within 2s/)
    expect(r.out, 'next').toMatch(/^ {2}next: \S/m)
    expect(r.out, 'not a pass').not.toContain('VERDICT        PASS')
    expect(r.status, 'exit').not.toBe(0)
    // The alarm, not the harness's own 120s budget, ended it.
    expect(elapsed, 'bounded').toBeLessThan(60_000)
    // A bad budget value is refused rather than silently disabling the bound.
    // 4294967296 and the 20-digit value pass a naive ^[1-9][0-9]*$ check but
    // wrap (or are rejected) inside perl's alarm(), which would arm no alarm at
    // all; 86401 is the first value past the documented maximum.
    for (const v of ['0', '4294967296', '12345678901234567890', '86401']) {
      const marker = join(dir, `invoked-${v}`)
      makeStub(dir, `tsc-mark-${v}`, markingStub(marker, real))
      const bad = runGate(undefined, {
        SKILLSMITH_TYPECHECK_SCRIPTS_TSC_TEST: join(dir, `tsc-mark-${v}`),
        SKILLSMITH_TYPECHECK_SCRIPTS_TIMEOUT_SECS: v,
      })
      expect(bad.out, `${v}: RESULT`).toContain('RESULT         INCONCLUSIVE')
      expect(bad.out, `${v}: cause`).toContain('1..86400')
      expect(bad.out, `${v}: next`).toMatch(/^ {2}next: \S/m)
      expect(bad.status, `${v}: exit`).not.toBe(0)
      // The refusal came before any compiler call, not after a run it ignored.
      expect(existsSync(marker), `${v}: compiler never invoked`).toBe(false)
    }
  })

  it('a compiler that hangs is still INCONCLUSIVE when the parent ignores SIGALRM', () => {
    // An inherited SIG_IGN for ALRM survives exec, and perl's alarm() then
    // cannot kill the command: the bound is silently lost. run_bounded resets
    // the disposition before arming. Spawned via `trap '' ALRM; exec bash gate`
    // so the gate inherits the ignore, as any wrapper could pass it.
    const dir = scratchDir('hang-ignored-alrm')
    const real = join(REPO_ROOT, 'node_modules', '.bin', 'tsc')
    makeStub(
      dir,
      'tsc-hang',
      `#!/bin/sh\ncase "$*" in *--pretty*) exec sleep 600 ;; esac\nexec ${real} "$@"\n`
    )
    const t0 = Date.now()
    const r = spawnSync('bash', ['-c', `trap '' ALRM; exec bash "${GATE}"`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: RUN_TIMEOUT_MS,
      env: {
        ...process.env,
        VITEST: 'true',
        SKILLSMITH_TYPECHECK_SCRIPTS_TSC_TEST: join(dir, 'tsc-hang'),
        SKILLSMITH_TYPECHECK_SCRIPTS_TIMEOUT_SECS: '2',
      },
    })
    const out = (r.stdout ?? '') + (r.stderr ?? '')
    expect(r.status, `exit (signal ${r.signal})`).toBe(1)
    expect(out, 'RESULT').toContain('RESULT         INCONCLUSIVE')
    expect(out, 'cause').toMatch(/did not finish within 2s/)
    expect(out, 'not a pass').not.toContain('VERDICT        PASS')
    expect(Date.now() - t0, 'bounded by the alarm, not the harness budget').toBeLessThan(30_000)
  })

  it('a compiler that hangs on --version or --showConfig is INCONCLUSIVE, within the bound', () => {
    // Only the full compile used to be bounded; these two calls ran unbounded.
    const dir = scratchDir('hang-pre')
    const real = join(REPO_ROOT, 'node_modules', '.bin', 'tsc')
    for (const call of ['--version', '--showConfig']) {
      makeStub(
        dir,
        `tsc-hang${call}`,
        `#!/bin/sh\ncase "$*" in *${call}*) exec sleep 600 ;; esac\nexec ${real} "$@"\n`
      )
      const t0 = Date.now()
      const r = runGate(undefined, {
        SKILLSMITH_TYPECHECK_SCRIPTS_TSC_TEST: join(dir, `tsc-hang${call}`),
        SKILLSMITH_TYPECHECK_SCRIPTS_TIMEOUT_SECS: '2',
      })
      expect(r.out, `${call}: RESULT`).toContain('RESULT         INCONCLUSIVE')
      expect(r.out, `${call}: cause names the call`).toContain(
        `tsc ${call} did not finish within 2s`
      )
      expect(r.out, `${call}: next`).toMatch(/^ {2}next: \S/m)
      expect(r.out, `${call}: not a pass`).not.toContain('VERDICT        PASS')
      expect(r.status, `${call}: exit`).not.toBe(0)
      expect(Date.now() - t0, `${call}: bounded`).toBeLessThan(60_000)
    }
  })

  it('a compiler killed by a signal, or exiting 127, is INCONCLUSIVE with a named cause', () => {
    // --version and --showConfig pass through to the real tsc so only the full
    // compile (the --pretty call) misbehaves. A stub that exits 127 stands in
    // for "could not exec": a real exec failure on the compile call alone is
    // not reachable through the seam, because --version already exec'd the same
    // binary. The arm keys on the status, so the stub exercises it honestly.
    const dir = scratchDir('compile-status')
    const real = join(REPO_ROOT, 'node_modules', '.bin', 'tsc')
    const arms = [
      { name: 'kill9', act: 'kill -9 $$', cause: 'tsc was killed by a signal (exit 137 = 128+9)' },
      {
        name: 'exit127',
        act: 'exit 127',
        cause: 'could not exec tsc via /usr/bin/perl (exit 127)',
      },
    ]
    for (const a of arms) {
      makeStub(
        dir,
        `tsc-${a.name}`,
        `#!/bin/sh\ncase "$*" in *--pretty*) ${a.act} ;; esac\nexec ${real} "$@"\n`
      )
      const r = runGate(undefined, {
        SKILLSMITH_TYPECHECK_SCRIPTS_TSC_TEST: join(dir, `tsc-${a.name}`),
      })
      expect(r.out, `${a.name}: RESULT`).toContain('RESULT         INCONCLUSIVE')
      expect(r.out, `${a.name}: cause`).toContain(a.cause)
      expect(r.out, `${a.name}: next`).toMatch(/^ {2}next: \S/m)
      expect(r.status, `${a.name}: exit`).not.toBe(0)
    }
  })

  it('the tsc test seam is ignored outside vitest and printed when honoured', () => {
    const dir = scratchDir('seam')
    const real = join(REPO_ROOT, 'node_modules', '.bin', 'tsc')
    const marker = join(dir, 'invoked')
    makeStub(dir, 'tsc-seam', markingStub(marker, real))
    const stub = join(dir, 'tsc-seam')

    // VITEST unset in the child: the seam is ignored, the REAL tsc runs.
    const ignored = runGate(undefined, { SKILLSMITH_TYPECHECK_SCRIPTS_TSC_TEST: stub }, ['VITEST'])
    expect(ignored.out, 'ignored line').toMatch(
      /SKILLSMITH_TYPECHECK_SCRIPTS_TSC_TEST ignored: it is honoured only under vitest/
    )
    expect(existsSync(marker), 'stub never invoked').toBe(false)
    expect(ignored.out, 'no substitution printed').not.toContain('SUBSTITUTED')
    expect(ignored.out, 'real tsc ran').toMatch(/^ {2}tsc {12}Version \d+\.\d+\.\d+/m)
    expect(ignored.out, 'evaluated').toContain('RESULT         EVALUATED')

    // VITEST=true: honoured, and the substitution is visible in the output.
    const honoured = runGate(undefined, {
      VITEST: 'true',
      SKILLSMITH_TYPECHECK_SCRIPTS_TSC_TEST: stub,
    })
    expect(existsSync(marker), 'stub invoked').toBe(true)
    expect(honoured.out, 'substitution printed').toContain(`tsc binary     ${stub}`)
    expect(honoured.out, 'substitution flagged').toContain('SUBSTITUTED')
    expect(honoured.out, 'no ignored line').not.toContain('ignored: it is honoured only')
  })

  it('ratchet: the BLOCKED exclusion set cannot grow silently, and both sides agree', () => {
    // M5. An exclusion is the gate declining to check something, so it is the
    // one list that must not be editable without someone noticing. There are
    // two independently-maintained copies -- the shell classifier and the
    // tsconfig `exclude` -- and the set-diff reconciliation only catches a
    // divergence BETWEEN them, not a deliberate addition to BOTH. Nothing
    // refuses growth. The sibling edge-function gate has a baseline ratchet;
    // this is the equivalent, pinned here rather than in a second data file.
    //
    // Adding an exclusion is allowed. Adding one WITHOUT updating this list
    // is not: that is the whole point.
    const PINNED = ['scripts/linear/create-warning-issues.ts', 'scripts/run-sql.ts'].sort()

    const helpers = readFileSync(
      join(REPO_ROOT, 'scripts', 'ci', 'typecheck-scripts.helpers.sh'),
      'utf8'
    )
    const caseLine = /_scripts_is_blocked_path\(\)\s*\{[\s\S]*?\n\s*(.+?)\)\s*return 0/.exec(
      helpers
    )
    expect(
      caseLine,
      '_scripts_is_blocked_path case arm not found — did it change shape?'
    ).not.toBeNull()
    const fromShell = (caseLine as RegExpExecArray)[1]
      .split('|')
      .map((s) => s.trim())
      .sort()
    expect(fromShell).toEqual(PINNED)

    // The tsconfig side. Strip // comments before parsing; this file is JSONC.
    const tsconfigRaw = readFileSync(join(REPO_ROOT, 'tsconfig.scripts.json'), 'utf8')
    const tsconfig = JSON.parse(tsconfigRaw.replace(/^\s*\/\/.*$/gm, '')) as {
      exclude?: string[]
    }
    const fromTsconfig = (tsconfig.exclude ?? [])
      .filter((e) => /\.(ts|mts|cts|tsx)$/.test(e))
      .sort()
    expect(fromTsconfig).toEqual(PINNED)

    // And every blocked path must carry its OWN reason, not inherit a reason
    // stated once for the whole list — which is what the output did before.
    //
    // EXECUTED, not grepped: a path merely appearing somewhere in the helper
    // source is satisfied by a comment, and says nothing about what the
    // function returns. Source the real helper and ask it for each reason.
    const HELPERS = join(REPO_ROOT, 'scripts', 'ci', 'typecheck-scripts.helpers.sh')
    const reasonFor = (path: string): string => {
      const r = spawnSync(
        'bash',
        ['-c', 'source "$1" && _scripts_blocked_reason "$2"', '_', HELPERS, path],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
        }
      )
      expect(r.status, `_scripts_blocked_reason failed for ${path}: ${r.stderr}`).toBe(0)
      return r.stdout
    }
    const EXPECTED_REASONS: Record<string, string> = {
      'scripts/linear/create-warning-issues.ts': '@linear/sdk is not an installed dependency',
      'scripts/run-sql.ts': 'pg is not an installed dependency',
    }
    expect(Object.keys(EXPECTED_REASONS).sort()).toEqual(PINNED)
    for (const p of PINNED) {
      expect(reasonFor(p), `reason for ${p}`).toBe(EXPECTED_REASONS[p])
    }
    // Known-negative on the instrument: an unrecorded path must hit the
    // fallback, and the fallback must not equal either recorded reason --
    // otherwise the loop above could not distinguish "recorded" from "default".
    const fallback = reasonFor('scripts/not-a-blocked-path.ts')
    expect(fallback).toContain('reason not recorded')
    for (const p of PINNED) expect(fallback).not.toBe(EXPECTED_REASONS[p])
    expect(helpers).not.toContain('neither @linear/sdk nor pg is an installed dependency')
  })

  it('scope regression: an emptied, non-matching, or narrowed include is INCONCLUSIVE, never PASS', () => {
    // Plan Step 5. Step 4 (a planted type error) tests the code; this tests the
    // INSTRUMENT -- an `include` that reads fewer files than intended reports
    // no errors, which is indistinguishable from a clean tree.
    //
    // Measured on tsc 5.9.3: an empty or non-matching `include` never reaches
    // the "zero roots" arm, because `tsc --showConfig` itself exits 1 with
    // TS18003 first. A NARROWED include is the only variant that reaches the
    // set-comparison arm, so it is the one that proves reconciliation works.
    const configPath = join(REPO_ROOT, 'tsconfig.scripts.json')
    const original = readFileSync(configPath)
    const includeRe = /"include":\s*\[[^\]]*\]/
    expect(includeRe.test(original.toString('utf8')), 'include array not found').toBe(true)
    const variants: Array<{ name: string; include: string; cause: string }> = [
      { name: 'emptied', include: '[]', cause: 'tsc --showConfig failed' },
      {
        name: 'non-matching',
        include: '["zz-nomatch/**/*.ts"]',
        cause: 'tsc --showConfig failed',
      },
      {
        name: 'narrowed',
        include: '["scripts/lib/**/*.ts"]',
        cause: 'disagree -- scope could not be validated',
      },
    ]
    try {
      for (const v of variants) {
        writeFileSync(
          configPath,
          original.toString('utf8').replace(includeRe, `"include": ${v.include}`)
        )
        const r = runGate()
        expect(r.out, `${v.name}: RESULT`).toContain('RESULT         INCONCLUSIVE')
        expect(r.out, `${v.name}: cause`).toContain(v.cause)
        expect(r.status, `${v.name}: exit`).not.toBe(0)
        expect(r.out, `${v.name}: verdict`).not.toContain('VERDICT        PASS')
        // `checked` is documented as set only once the two derivations agree.
        expect(r.out, `${v.name}: checked`).not.toMatch(/checked\s+\d+/)
      }
    } finally {
      writeFileSync(configPath, original)
    }
    // Restored byte-for-byte, and the gate is green again.
    expect(readFileSync(configPath).equals(original)).toBe(true)
    expect(runGate().status).toBe(0)
  })

  // chmod 000 only denies a non-root reader. Under root (some containers) the
  // file stays readable, so the premise is false there and the test would
  // assert about nothing -- skipped by capability, with the probe below proving
  // the premise on every run where it does execute.
  it.skipIf(process.getuid?.() === 0)(
    'an unreadable .ts under scripts/ is INCONCLUSIVE (tsc cannot read it), never PASS',
    () => {
      const file = join(REPO_ROOT, 'scripts', `zz-smi6975-unreadable-${process.pid}.ts`)
      try {
        writeFileSync(file, 'export const a: number = 1\n')
        chmodSync(file, 0o000)
        // Known-positive on the premise: the file really is unreadable here.
        expect(() => readFileSync(file)).toThrow()
        const r = runGate()
        expect(r.out).toContain('RESULT         INCONCLUSIVE')
        expect(r.out).toContain('module-resolution or global configuration failure')
        expect(r.status).not.toBe(0)
        expect(r.out).not.toContain('VERDICT        PASS')
      } finally {
        chmodSync(file, 0o644)
        rmSync(file, { force: true })
      }
      expect(existsSync(file)).toBe(false)
      expect(runGate().status).toBe(0)
    }
  )

  it(
    'backstop: an INCONCLUSIVE arm that falls through never reaches VERDICT PASS',
    () => {
      // Plants a non-exiting arm into two copies of the gate, beside the original
      // so REPO_ROOT resolves to the real tree. The control copy also deletes the
      // backstop and must reach VERDICT PASS / exit 0, proving the planted arm
      // really falls through to the verdict. The subject copy must not.
      const src = readFileSync(GATE, 'utf8')
      const anchor = 'if [[ "$ATTRIB_OUTSIDE" -gt 0 ]]; then'
      expect(src.includes(anchor), 'plant anchor not found -- did the gate change shape?').toBe(
        true
      )
      const planted = src.replace(anchor, `inconclusive "planted fall-through"\n${anchor}`)
      const backstopRe = /\nif \[\[ "\$RESULT" != "EVALUATED" \]\]; then\n[\s\S]*?\nfi\n/
      expect(backstopRe.test(planted), 'backstop block not found').toBe(true)
      const control = planted.replace(backstopRe, '\n')
      const dir = join(REPO_ROOT, 'scripts', 'ci')
      const tag = `${process.pid}-${Date.now()}`
      const subjectPath = join(dir, `.backstop-subject-${tag}.sh`)
      const controlPath = join(dir, `.backstop-control-${tag}.sh`)
      const run = (p: string) => {
        const r = spawnSync('bash', [p], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          timeout: RUN_TIMEOUT_MS,
        })
        if (r.status === null) throw new Error(`gate copy terminated by ${r.signal ?? 'unknown'}`)
        return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
      }
      try {
        writeFileSync(controlPath, control)
        writeFileSync(subjectPath, planted)
        const c = run(controlPath)
        expect(c.out, 'control: planted arm reaches the verdict').toMatch(/VERDICT\s+PASS/)
        expect(c.status, 'control exit').toBe(0)
        const s = run(subjectPath)
        expect(s.out, 'subject: no PASS').not.toMatch(/VERDICT\s+PASS/)
        expect(s.out, 'subject: names the gate bug').toContain('gate bug')
        expect(s.out, 'subject: RESULT').toMatch(/RESULT\s+INCONCLUSIVE/)
        expect(s.status, 'subject exit').not.toBe(0)
      } finally {
        rmSync(subjectPath, { force: true })
        rmSync(controlPath, { force: true })
      }
    },
    2 * RUN_TIMEOUT_MS + 30_000
  )

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
