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

/**
 * True only for a line that is an actual, non-empty `NEXT_ACTION=` assignment
 * statement. A bare `includes('NEXT_ACTION=')` is satisfied by a comment, an
 * `echo`, or an empty assignment, none of which print a next action -- so an
 * arm could lose its real assignment and keep passing on a forged mention.
 */
function assignsNextAction(line: string): boolean {
  return /^\s*NEXT_ACTION=(?!""|''|\s*$)\S/.test(line)
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
      lines.forEach((line, i) => {
        if (!/\binconclusive "/.test(line)) return
        armCount += 1
        let hasNext = false
        for (let j = i + 1; j < Math.min(i + 25, lines.length); j += 1) {
          if (assignsNextAction(lines[j])) hasNext = true
          if (lines[j].includes('exit_for_inconclusive')) break
        }
        if (!hasNext) offenders.push(`${f}:${i + 1}`)
      })
    }
    // Known-positive on the scanner itself: if it found no arms at all it is
    // matching nothing, and an empty offenders list would mean nothing.
    expect(armCount).toBeGreaterThan(10)
    // Known-positive / known-negative on the predicate: the forgeries a plain
    // substring test accepts must be rejected, and a real assignment accepted.
    expect(assignsNextAction('    NEXT_ACTION="re-run the gate"')).toBe(true)
    expect(assignsNextAction('NEXT_ACTION=fixed-word')).toBe(true)
    expect(assignsNextAction('    # NEXT_ACTION="re-run the gate"')).toBe(false)
    expect(assignsNextAction('    echo "NEXT_ACTION=re-run"')).toBe(false)
    expect(assignsNextAction('    NEXT_ACTION=""')).toBe(false)
    expect(assignsNextAction("    NEXT_ACTION=''")).toBe(false)
    expect(assignsNextAction('    NEXT_ACTION=')).toBe(false)
    expect(offenders).toEqual([])
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
      { name: 'non-matching', include: '["zz-nomatch/**/*.ts"]', cause: 'tsc --showConfig failed' },
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
