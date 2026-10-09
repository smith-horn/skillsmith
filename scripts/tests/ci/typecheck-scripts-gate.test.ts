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
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
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

/** For tests that spawn several full gate runs (the preset default is 15s). */
const MULTI_RUN_TIMEOUT_MS = 6 * 60_000

/** tsconfig.scripts.json is parked under this name by the missing-config arm. */
const CONFIG_ASIDE = 'zz-smi6975-tsconfig-aside.json'

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
 * Marks every line that is part of a heredoc (body and terminator). A
 * `NEXT_ACTION=` or `exit_for_inconclusive` inside one is text handed to a
 * command, never executed by the shell, so the scan must not count it.
 */
function heredocMask(lines: string[]): boolean[] {
  const mask = lines.map(() => false)
  let end: string | null = null
  lines.forEach((line, i) => {
    if (end !== null) {
      mask[i] = true
      if (line.trim() === end) end = null
      return
    }
    if (/^\s*#/.test(line)) return
    const m = /(?<!<)<<-?\s*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|\\?([A-Za-z_]\w*))/.exec(line)
    if (m) end = m[1] ?? m[2] ?? m[3]
  })
  return mask
}

/**
 * Scans shell source lines for `inconclusive "` arms. Each arm must reach its
 * own `exit_for_inconclusive` (matched as code, never inside a comment or a
 * heredoc) before any other arm begins, and the last NEXT_ACTION assignment
 * before that exit must carry text. Offenders are returned as `<line> [reason]`.
 */
function scanInconclusiveArms(lines: string[]): { armCount: number; offenders: string[] } {
  const hd = heredocMask(lines)
  const isComment = (l: string): boolean => /^\s*#/.test(l)
  const isArm = (i: number): boolean =>
    !hd[i] && !isComment(lines[i]) && /\binconclusive "/.test(lines[i])
  const isExit = (i: number): boolean =>
    !hd[i] && /^\s*exit_for_inconclusive\b(?!\s*\(\))/.test(lines[i])
  const offenders: string[] = []
  let armCount = 0
  lines.forEach((line, i) => {
    if (!isArm(i)) return
    armCount += 1
    // The LAST NEXT_ACTION assignment before the exit is the one finish()
    // renders, so it is the one that must carry text.
    let last: string | null = null
    let reachedExit = false
    for (let j = i + 1; j < lines.length; j += 1) {
      if (isArm(j)) break
      if (!hd[j] && /^\s*(NEXT_ACTION=|printf\s+-v\s+NEXT_ACTION\b)/.test(lines[j])) last = lines[j]
      if (isExit(j)) {
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
  const m = /^\s*(NEXT_ACTION=|printf\s+-v\s+NEXT_ACTION\s+)(.*)$/.exec(line)
  if (!m) return false
  const isPrintf = m[1].startsWith('printf')
  // $(...) is stripped innermost-first until stable, so nested substitutions
  // like $(echo $(date)) are removed whole rather than leaving ")" behind. A
  // value that is ONLY command substitutions is rejected even if the command
  // prints literal text (e.g. $(printf 'run foo')): its rendered text cannot be
  // shown from the source, so this errs toward flagging (the behavioural test
  // checks what actually rendered).
  let v = m[2].replace(/`[^`]*`/g, '') // `cmd`
  for (let prev = ''; prev !== v; ) {
    prev = v
    v = v.replace(/\$\([^()]*\)/g, '') // innermost $(cmd)
  }
  let literal = v
    .replace(/\$\{[^}]*\}/g, '') // ${X}, ${X:-}
    .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, '') // $X
    .replace(/["']/g, '') // quote characters carry no text
  // printf's first operand is a format: its %s/%d/... conversions print their
  // arguments, not text of their own, so `'%s' "${X:-}"` renders empty.
  if (isPrintf) literal = literal.replace(/%[-+ #0-9.]*[A-Za-z]/g, '')
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

/** Plants a file under REPO_ROOT (creating parents); its path carries a zz-smi6975- segment. */
function plant(rel: string, content: string): string {
  const abs = join(REPO_ROOT, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
  return abs
}

/** Removes every zz-smi6975- entry anywhere under `dir`; leftovers of a killed run. */
function sweepPlanted(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.name.startsWith('zz-smi6975-')) rmSync(p, { recursive: true, force: true })
    else if (e.isDirectory() && e.name !== 'node_modules') sweepPlanted(p)
  }
}

/**
 * Line numbers of every `\b` that sits inside a quoted string of shell source,
 * wherever the string is used. Scans the whole text as one stream so a string
 * spanning lines keeps its state; `balanced` is false when a quote never closed,
 * which means the scanner desynchronised and its answer cannot be trusted.
 */
function quotedWordBoundaryLines(src: string): { hits: number[]; balanced: boolean } {
  const hits: number[] = []
  let q: "'" | '"' | null = null
  let line = 1
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]
    if (c === '\n') line += 1
    else if (q === null) {
      if (c === '#' && (i === 0 || /\s/.test(src[i - 1]))) {
        while (i + 1 < src.length && src[i + 1] !== '\n') i += 1
      } else if (c === '\\') {
        i += 1
        if (src[i] === '\n') line += 1
      } else if (c === "'" || c === '"') q = c
    } else if (q === "'") {
      if (c === "'") q = null
      else if (c === '\\') {
        if (src[i + 1] === 'b') hits.push(line)
        else if (src[i + 1] === '\\') i += 1
      }
    } else if (c === '"') q = null
    else if (c === '\\') {
      const n = src[i + 1]
      // In double quotes `\\b` reaches the program as `\b` too.
      if (n === 'b' || (n === '\\' && src[i + 2] === 'b')) hits.push(line)
      if (n === '\n') line += 1
      if (n === '\\' || n === '"' || n === '$' || n === '`' || n === '\n') i += 1
    }
  }
  return { hits, balanced: q === null }
}

/** The patterns of every `return 0` arm of the `case` in shell function `fn`. */
function caseArmsReturningZero(src: string, fn: string): string[] {
  const body = new RegExp(`${fn}\\(\\)\\s*\\{([\\s\\S]*?)\\n\\}`).exec(src)?.[1]
  const cases = body === undefined ? null : /case\s+[^\n]*\s+in([\s\S]*?)\besac\b/.exec(body)
  if (cases === null) throw new Error(`${fn}: no case statement found -- did it change shape?`)
  const patterns: string[] = []
  for (const chunk of cases[1].split(';;')) {
    if (chunk.trim() === '') continue
    const arm = /^\s*([^)]+)\)([\s\S]*)$/.exec(chunk)
    if (arm === null) throw new Error(`${fn}: unparseable case arm: ${chunk.trim()}`)
    if (/\breturn 0\b/.test(arm[2])) patterns.push(...arm[1].split('|').map((x) => x.trim()))
  }
  return patterns.sort()
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
  sweepPlanted(dir)
  // A killed run can leave tsconfig.scripts.json parked under CONFIG_ASIDE.
  const cfg = join(REPO_ROOT, 'tsconfig.scripts.json')
  const aside = join(REPO_ROOT, CONFIG_ASIDE)
  if (existsSync(aside)) {
    if (existsSync(cfg)) rmSync(aside, { force: true })
    else renameSync(aside, cfg)
  }
  // Backstop copies embed their writer's pid and creation time. Remove a copy
  // when its pid is gone, or when it is older than any run could last: a live
  // pid alone is best-effort, because pids are reused.
  const ciDir = join(dir, 'ci')
  const staleMs = 60 * 60 * 1000
  for (const f of readdirSync(ciDir)) {
    const m = /^\.backstop-(?:subject|control)-(\d+)-(\d+)\.sh$/.exec(f)
    if (m && (!pidAlive(Number(m[1])) || Date.now() - Number(m[2]) > staleMs)) {
      rmSync(join(ciDir, f), { force: true })
    }
  }
})

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: the process exists but belongs to another user.
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

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

  it('when perl strips PARTIAL output then exits non-zero, the gate is INCONCLUSIVE, never FAIL', () => {
    // A perl that wrote usable output and then failed must not be trusted: a
    // check that treats the failure as fatal only when the output is empty would
    // read the partial output as a verdict (here, FAIL for the planted error).
    const name = `zz-smi6975-perlpartial-${process.pid}.ts`
    const dir = scratchDir('perl-partial')
    makeStub(dir, 'perl', '#!/bin/sh\n/usr/bin/perl "$@"\nexit 13\n')
    // Known-positive on the stub: it really emits output AND exits 13.
    const probe = spawnSync(join(dir, 'perl'), ['-e', 'print "partial"'], { encoding: 'utf8' })
    expect(probe.stdout).toBe('partial')
    expect(probe.status).toBe(13)
    const file = plant(`scripts/${name}`, "export const planted: number = 'not a number'\n")
    try {
      const r = runGate(dir)
      expect(r.out, 'RESULT').toContain('RESULT         INCONCLUSIVE')
      expect(r.out, 'cause').toContain('exit 13')
      expect(r.out, 'next').toMatch(/^ {2}next: \S/m)
      expect(r.out, 'not a pass').not.toContain('VERDICT        PASS')
      expect(r.out, 'not a fail').not.toContain('VERDICT        FAIL')
      expect(r.status, 'exit').not.toBe(0)
    } finally {
      rmSync(file, { force: true })
    }
    expect(existsSync(file)).toBe(false)
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

  it('an extensionless file and a .TS file under scripts/ are each INCONCLUSIVE and named', () => {
    // Run one at a time: with both planted, the .TS file alone would make the
    // run INCONCLUSIVE and hide an inventory that skips extensionless files.
    const cases = [`zz-smi6975-noext-${process.pid}`, `zz-smi6975-upper-${process.pid}.TS`]
    const planted: string[] = []
    try {
      for (const name of cases) {
        const file = plant(`scripts/${name}`, '# planted by typecheck-scripts-gate.test.ts\n')
        planted.push(file)
        const r = runGate()
        expect(r.out, `${name}: RESULT`).toContain('RESULT         INCONCLUSIVE')
        expect(r.out, `${name}: cause`).toContain('extension this gate does not classify')
        const listed = r.out.slice(r.out.indexOf('--- unclassified ---'))
        expect(listed, `${name}: listed as unclassified`).toContain(`scripts/${name}`)
        expect(r.out, `${name}: next`).toMatch(/^ {2}next: \S/m)
        expect(r.status, `${name}: exit`).not.toBe(0)
        expect(r.out, `${name}: verdict`).not.toContain('VERDICT        PASS')
        rmSync(file, { force: true })
      }
    } finally {
      for (const f of planted) rmSync(f, { force: true })
    }
    for (const f of planted) expect(existsSync(f)).toBe(false)
  })

  it('no grep -E pattern in the gate uses \\b, which POSIX ERE does not define', () => {
    // The gate runs under GNU grep (container, CI) and BSD grep (macOS host).
    const usesWordBoundary = (l: string): boolean => /\bgrep\b[^\n]*\s-[A-Za-z]*E[\s\S]*\\b/.test(l)
    expect(usesWordBoundary(`X="$(grep -cE '^Found [0-9]+ errors?\\b' f)"`), 'known positive').toBe(
      true
    )
    expect(
      usesWordBoundary(`X="$(grep -cE '^Found [0-9]+ errors?([^[:alnum:]_]|$)' f)"`),
      'known negative'
    ).toBe(false)
    const offenders: string[] = []
    let scanned = 0
    for (const f of ['typecheck-scripts.sh', 'typecheck-scripts.helpers.sh']) {
      readFileSync(join(REPO_ROOT, 'scripts', 'ci', f), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*#/.test(line) || !/\bgrep\b/.test(line)) return
          scanned += 1
          if (usesWordBoundary(line)) offenders.push(`${f}:${i + 1}`)
        })
    }
    expect(scanned, 'no grep lines found -- wrong files?').toBeGreaterThan(0)
    expect(offenders).toEqual([])

    // The word boundary can also be held in a variable and reach grep later, so
    // every quoted string in a non-comment position is scanned, grep or not.
    const hits = (src: string) => quotedWordBoundaryLines(src).hits
    expect(hits(String.raw`FOUND_RE='^Found [0-9]+\b'`), 'variable, single-quoted').toEqual([1])
    expect(
      hits('x=1\nFOUND_RE="^Found\\b"\ngrep -cE "$FOUND_RE" f'),
      'variable, double-quoted'
    ).toEqual([2])
    expect(hits(String.raw`FOUND_RE="^Found\\b"`), 'double-quoted, escaped backslash').toEqual([1])
    expect(hits("X='a\nb\\b'"), 'string spanning lines').toEqual([2])
    expect(hits(String.raw`# FOUND_RE='x\b'`), 'comment').toEqual([])
    expect(hits(String.raw`x=1 # y='\b'`), 'trailing comment').toEqual([])
    expect(hits(String.raw`grep -E \b f`), 'unquoted').toEqual([])
    expect(hits(String.raw`X='\\b'`), 'single-quoted escaped backslash').toEqual([])
    expect(hits(`X='^Found([^[:alnum:]_]|$)'`), 'bracket-expression boundary').toEqual([])
    for (const f of ['typecheck-scripts.sh', 'typecheck-scripts.helpers.sh']) {
      const r = quotedWordBoundaryLines(readFileSync(join(REPO_ROOT, 'scripts', 'ci', f), 'utf8'))
      expect(r.balanced, `${f}: scanner ended inside a quote`).toBe(true)
      expect(
        r.hits.map((n) => `${f}:${n}`),
        `${f}: \\b in a quoted string`
      ).toEqual([])
    }
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
    let plainCount = 0
    for (const f of files) {
      const lines = readFileSync(join(REPO_ROOT, 'scripts', 'ci', f), 'utf8').split('\n')
      const r = scanInconclusiveArms(lines)
      armCount += r.armCount
      plainCount += lines.filter((l) => !/^\s*#/.test(l) && /\binconclusive "/.test(l)).length
      for (const o of r.offenders) offenders.push(`${f}:${o}`)
    }
    // Known-positive on the scanner itself: if it found no arms at all it is
    // matching nothing, and an empty offenders list would mean nothing.
    expect(armCount).toBeGreaterThan(10)
    // The scan masks heredoc bodies. A mis-detected heredoc start would hide
    // every later arm, so the scan must see exactly the arms a plain line
    // count sees.
    expect(armCount, 'scan saw fewer arms than a plain count -- heredoc mask overreached').toBe(
      plainCount
    )
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
    // A NEXT_ACTION= inside a heredoc is text for a command, not an assignment.
    expect(
      scanInconclusiveArms([
        'inconclusive "only"',
        'cat <<EOF',
        'NEXT_ACTION="written inside a heredoc"',
        'EOF',
        '  exit_for_inconclusive',
      ]).offenders,
      'heredoc-only assignment flagged'
    ).toHaveLength(1)
    // ...but a real assignment after the heredoc ends counts, as does a quoted
    // or dash-form delimiter, and a here-string is not a heredoc.
    for (const open of ["cat <<'EOF'", 'cat <<"EOF"', 'cat <<-EOF']) {
      expect(
        scanInconclusiveArms([
          open,
          'NEXT_ACTION="heredoc text"',
          'EOF',
          'inconclusive "ok"',
          'NEXT_ACTION="real"',
          '  exit_for_inconclusive',
        ]),
        `real assignment after ${open}`
      ).toEqual({ armCount: 1, offenders: [] })
    }
    expect(
      scanInconclusiveArms([
        'cat <<<"$X"',
        'inconclusive "ok"',
        'NEXT_ACTION="real"',
        'exit_for_inconclusive',
      ]).offenders,
      'here-string does not open a heredoc'
    ).toEqual([])
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
    // A printf format's conversions print arguments, not text: an expansion-only
    // argument renders empty however many conversions wrap it.
    expect(assignsNextAction(`    printf -v NEXT_ACTION '%s' "\${X:-}"`)).toBe(false)
    expect(assignsNextAction('    printf -v NEXT_ACTION "%s %s" "$A" "$B"')).toBe(false)
    expect(assignsNextAction('    printf -v NEXT_ACTION "%-10s%5d" "$A" "$B"')).toBe(false)
    expect(assignsNextAction(`    printf -v NEXT_ACTION '%s' "re-run"`)).toBe(true)
    expect(assignsNextAction('    NEXT_ACTION="100% sure"')).toBe(true)
    // Command-substitution-only values are rejected, including a nested one and
    // one whose command prints literal text (deliberately errs toward flagging).
    expect(assignsNextAction('    NEXT_ACTION="$(printf \'run foo\')"')).toBe(false)
    expect(assignsNextAction('    NEXT_ACTION="$(echo $(date))"')).toBe(false)
    expect(assignsNextAction('    NEXT_ACTION="fix $(echo $(date)) now"')).toBe(true)
    expect(offenders).toEqual([])
  })

  it(
    'behavioural: every arm the harness can drive RENDERS a non-empty next: line',
    () => {
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

      // And the missing-config arm, driven by moving the real config aside.
      const cfg = join(REPO_ROOT, 'tsconfig.scripts.json')
      const aside = join(REPO_ROOT, CONFIG_ASIDE)
      try {
        renameSync(cfg, aside)
        const r = runGate()
        expect(r.out, 'missing config: RESULT').toContain('RESULT         INCONCLUSIVE')
        expect(r.out, 'missing config: cause').toContain('missing tsconfig.scripts.json')
        expect(r.out, 'missing config: next line').toMatch(/^ {2}next: \S/m)
      } finally {
        if (existsSync(aside)) renameSync(aside, cfg)
      }
      expect(existsSync(cfg), 'config restored').toBe(true)
      expect(existsSync(aside), 'aside copy gone').toBe(false)
    },
    MULTI_RUN_TIMEOUT_MS
  )

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
    // The rest are values a lenient pattern would accept: surrounding space, a
    // trailing newline, a sign, a leading zero, and a non-ASCII digit. An EMPTY
    // value is deliberately absent: the gate reads it with `:-600`, so it is the
    // unset case and runs with the default budget rather than being refused.
    const badValues = [
      '0',
      '4294967296',
      '12345678901234567890',
      '86401',
      ' 5',
      '5 ',
      '5\n',
      '+5',
      '05',
      '\u0665',
    ]
    for (const [idx, v] of badValues.entries()) {
      const marker = join(dir, `invoked-${idx}`)
      makeStub(dir, `tsc-mark-${idx}`, markingStub(marker, real))
      const bad = runGate(undefined, {
        SKILLSMITH_TYPECHECK_SCRIPTS_TSC_TEST: join(dir, `tsc-mark-${idx}`),
        SKILLSMITH_TYPECHECK_SCRIPTS_TIMEOUT_SECS: v,
      })
      const label = JSON.stringify(v)
      expect(bad.out, `${label}: RESULT`).toContain('RESULT         INCONCLUSIVE')
      expect(bad.out, `${label}: cause`).toContain('1..86400')
      expect(bad.out, `${label}: next`).toMatch(/^ {2}next: \S/m)
      expect(bad.status, `${label}: exit`).not.toBe(0)
      // The refusal came before any compiler call, not after a run it ignored.
      expect(existsSync(marker), `${label}: compiler never invoked`).toBe(false)
    }
  })

  it(
    'a compiler that hangs is still INCONCLUSIVE when the parent ignores or blocks SIGALRM',
    () => {
      // An inherited SIG_IGN for ALRM, or an inherited blocked mask, survives
      // exec, and perl's alarm() then cannot kill the command: the bound is
      // silently lost. run_bounded resets the disposition and unblocks the
      // signal before arming. Each wrapper execs the gate with that state
      // inherited, as any parent could pass it.
      const dir = scratchDir('hang-alrm-inherited')
      const real = join(REPO_ROOT, 'node_modules', '.bin', 'tsc')
      makeStub(
        dir,
        'tsc-hang',
        `#!/bin/sh\ncase "$*" in *--pretty*) exec sleep 600 ;; esac\nexec ${real} "$@"\n`
      )
      const wrappers: Array<[string, string, string[]]> = [
        ['ignored', 'bash', ['-c', `trap '' ALRM; exec bash "${GATE}"`]],
        [
          'blocked',
          'perl',
          [
            '-MPOSIX',
            '-e',
            'sigprocmask(SIG_BLOCK, POSIX::SigSet->new(SIGALRM)); exec @ARGV',
            'bash',
            GATE,
          ],
        ],
      ]
      for (const [label, cmd, args] of wrappers) {
        const t0 = Date.now()
        const r = spawnSync(cmd, args, {
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
        expect(r.status, `${label}: exit (signal ${r.signal})`).toBe(1)
        expect(out, `${label}: RESULT`).toContain('RESULT         INCONCLUSIVE')
        expect(out, `${label}: cause`).toMatch(/did not finish within 2s/)
        expect(out, `${label}: not a pass`).not.toContain('VERDICT        PASS')
        expect(Date.now() - t0, `${label}: bounded by the alarm`).toBeLessThan(30_000)
      }
    },
    2 * RUN_TIMEOUT_MS + 30_000
  )

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

  it('an unreadable compiled-file list is an instrument failure, not every file reported missing', () => {
    // If tsc's --listFiles paths share no prefix with the compiler's own
    // working directory, nothing under scripts/ is extracted. That must read
    // as "the list could not be read", not as N files tsc skipped.
    const dir = scratchDir('listfiles-empty')
    const real = join(REPO_ROOT, 'node_modules', '.bin', 'tsc')
    makeStub(
      dir,
      'tsc-nolist',
      `#!/bin/sh\ncase "$*" in *--pretty*) exit 0 ;; esac\nexec ${real} "$@"\n`
    )
    const r = runGate(undefined, { SKILLSMITH_TYPECHECK_SCRIPTS_TSC_TEST: join(dir, 'tsc-nolist') })
    expect(r.out, 'RESULT').toContain('RESULT         INCONCLUSIVE')
    expect(r.out, 'cause').toContain('tsc --listFiles named no file under')
    expect(r.out, 'not misreported as skipped files').not.toContain('did not read')
    expect(r.out, 'next').toMatch(/^ {2}next: \S/m)
    expect(r.status, 'exit').not.toBe(0)
  })

  it("the operator's raw tail keeps tsc's own lines visible past --listFiles' absolute paths", () => {
    // --listFiles prints one absolute path per program file. Without filtering
    // them out, the 20-line tail shown on a shape failure is all paths and the
    // line that explains the failure is hidden.
    const dir = scratchDir('tail-listfiles')
    const real = join(REPO_ROOT, 'node_modules', '.bin', 'tsc')
    const marker = `TAIL-MARKER-${process.pid}`
    // The compile call prints the marker, then the REAL program list (so the
    // compiled-roots check passes), then exits 2 with no 'Found' summary.
    makeStub(
      dir,
      'tsc-tail',
      `#!/bin/sh\ncase "$*" in *--pretty*) echo '${marker}'; ${real} -p tsconfig.scripts.json --listFilesOnly; exit 2 ;; esac\nexec ${real} "$@"\n`
    )
    const r = runGate(undefined, { SKILLSMITH_TYPECHECK_SCRIPTS_TSC_TEST: join(dir, 'tsc-tail') })
    expect(r.out, 'RESULT').toContain('RESULT         INCONCLUSIVE')
    expect(r.out, 'cause').toContain("no parseable 'Found' total")
    expect(r.out, 'tail section printed').toContain('--- raw tail ---')
    expect(r.out, 'marker visible in the tail').toContain(marker)
    const tail = r.out.split('--- raw tail ---')[1] ?? ''
    expect(tail, 'absolute program paths filtered from the tail').not.toMatch(/^\//m)
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

  it(
    'the tsc test seam is ignored outside vitest and printed when honoured',
    () => {
      const dir = scratchDir('seam')
      const real = join(REPO_ROOT, 'node_modules', '.bin', 'tsc')
      const marker = join(dir, 'invoked')
      makeStub(dir, 'tsc-seam', markingStub(marker, real))
      const stub = join(dir, 'tsc-seam')

      // VITEST unset in the child: the seam is ignored, the REAL tsc runs.
      const ignored = runGate(undefined, { SKILLSMITH_TYPECHECK_SCRIPTS_TSC_TEST: stub }, [
        'VITEST',
      ])
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

      // Only the exact string 'true' honours it: a falsy-looking or merely
      // non-empty VITEST must not switch a stub compiler into a PASS.
      for (const v of ['false', '1']) {
        rmSync(marker, { force: true })
        const r = runGate(undefined, { VITEST: v, SKILLSMITH_TYPECHECK_SCRIPTS_TSC_TEST: stub })
        expect(r.out, `VITEST=${v}: ignored line`).toMatch(
          /SKILLSMITH_TYPECHECK_SCRIPTS_TSC_TEST ignored: it is honoured only under vitest/
        )
        expect(existsSync(marker), `VITEST=${v}: stub never invoked`).toBe(false)
        expect(r.out, `VITEST=${v}: no substitution`).not.toContain('SUBSTITUTED')
      }
    },
    MULTI_RUN_TIMEOUT_MS
  )

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
    // EVERY `return 0` arm of the case, not the first: a second arm such as
    // `scripts/e2e/*) return 0 ;;` would otherwise exclude a directory unseen.
    // Known-positive on the extractor first, so an extractor that only reads the
    // first arm cannot satisfy the pin below.
    const twoArms = [
      '_scripts_is_blocked_path() {',
      '  case "$1" in',
      '    scripts/a.ts) return 0 ;;',
      '    scripts/e2e/*) return 0 ;;',
      '    *) return 1 ;;',
      '  esac',
      '}',
    ].join('\n')
    expect(
      caseArmsReturningZero(twoArms, '_scripts_is_blocked_path'),
      'extractor sees arm 2'
    ).toEqual(['scripts/a.ts', 'scripts/e2e/*'])
    const fromShell = caseArmsReturningZero(helpers, '_scripts_is_blocked_path')
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
    // The whole exclude list, not just its file entries: a directory or glob
    // entry (`scripts/e2e`) narrows scope exactly as a blocked file does.
    const ALLOWED_EXCLUDES = ['node_modules', 'dist', 'scripts/tests/**', ...PINNED]
    expect(
      (tsconfig.exclude ?? []).filter((e) => !ALLOWED_EXCLUDES.includes(e)),
      'tsconfig exclude entries outside the pinned set'
    ).toEqual([])

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
    // A path may contain ':' -- the anchor is the `:line:col - error` suffix.
    expect(
      grepMatches("scripts/zz-a:b.ts:1:14 - error TS2322: Type 'string' is not assignable.")
    ).toBe(true)
    // Known-negative: an indented continuation line must NOT match, or the
    // count would exceed one per diagnostic block and stop reconciling.
    expect(grepMatches("  2 const x: number = 'y';")).toBe(false)
  })

  it(
    'scope: a type error under scripts/e2e, ci, lib and indexer/_shared is FAIL and each file is named',
    () => {
      // A scope that is wrong CONSISTENTLY -- the inventory's find and the
      // tsconfig both skipping a directory -- reconciles perfectly and PASSES, so
      // only a planted error in each directory can see it.
      const dirs = ['scripts/e2e', 'scripts/ci', 'scripts/lib', 'scripts/indexer/_shared']
      const files = dirs.map((d) => `${d}/zz-smi6975-scope-${process.pid}.ts`)
      try {
        for (const f of files) plant(f, "export const planted: number = 'not a number'\n")
        const r = runGate()
        expect(r.out, 'RESULT').not.toContain('RESULT         INCONCLUSIVE')
        expect(r.out, 'RESULT').toContain('RESULT         EVALUATED')
        expect(r.out, 'VERDICT').toContain('VERDICT        FAIL')
        expect(r.status, 'exit').toBe(1)
        for (const f of files) expect(r.out, `names ${f}`).toContain(f)
        const m = /(\d+) total \/ (\d+) attributed/.exec(r.out)
        expect(m, 'reconciliation line present').not.toBeNull()
        expect(Number((m as RegExpExecArray)[1]), 'one error per directory').toBeGreaterThanOrEqual(
          dirs.length
        )
      } finally {
        for (const f of files) rmSync(join(REPO_ROOT, f), { force: true })
      }
      for (const f of files) expect(existsSync(join(REPO_ROOT, f))).toBe(false)
    },
    MULTI_RUN_TIMEOUT_MS
  )

  it(
    'depth: a valid file and a type error 4+ levels under scripts/ are PASS-in-scope and FAIL',
    () => {
      // An include of depth-limited globs (scripts/*/*/*.ts ...) agrees with an
      // equally shallow inventory and never sees a deeper file.
      const top = `scripts/zz-smi6975-deep-${process.pid}`
      const deep = `${top}/d1/d2/d3/d4`
      try {
        const base = /discovered\s+(\d+)/.exec(runGate().out)?.[1]
        expect(base, 'baseline discovered count').toBeDefined()
        plant(`${deep}/ok.ts`, 'export const ok: number = 1\n')
        const ok = runGate()
        expect(ok.out, 'valid: RESULT').toContain('RESULT         EVALUATED')
        expect(ok.out, 'valid: VERDICT').toContain('VERDICT        PASS')
        expect(ok.status, 'valid: exit').toBe(0)
        expect(Number(/discovered\s+(\d+)/.exec(ok.out)?.[1]), 'valid: file is in scope').toBe(
          Number(base) + 1
        )
        expect(/compiler roots\s+(\d+)/.exec(ok.out)?.[1], 'valid: tsc roots agree').toBe(
          String(Number(base) + 1)
        )
        rmSync(join(REPO_ROOT, `${deep}/ok.ts`), { force: true })

        plant(`${deep}/bad.ts`, "export const bad: number = 'not a number'\n")
        const bad = runGate()
        expect(bad.out, 'error: RESULT').toContain('RESULT         EVALUATED')
        expect(bad.out, 'error: VERDICT').toContain('VERDICT        FAIL')
        expect(bad.out, 'error: names the file').toContain(`${deep}/bad.ts`)
        expect(bad.status, 'error: exit').toBe(1)
      } finally {
        rmSync(join(REPO_ROOT, top), { recursive: true, force: true })
      }
      expect(existsSync(join(REPO_ROOT, top))).toBe(false)
    },
    MULTI_RUN_TIMEOUT_MS
  )

  it('a path containing ":" is attributed: EVALUATED/FAIL naming the file, not a false INCONCLUSIVE', () => {
    // A `[^:]*` path in the attribution pattern cannot span the colon, so the
    // header goes uncounted and REPORTED (1) disagrees with ATTRIB (0).
    const name = `zz-smi6975-a:b-${process.pid}.ts`
    const file = plant(`scripts/${name}`, "export const planted: number = 'not a number'\n")
    try {
      const r = runGate()
      expect(r.out, 'RESULT').not.toContain('RESULT         INCONCLUSIVE')
      expect(r.out, 'RESULT').toContain('RESULT         EVALUATED')
      expect(r.out, 'VERDICT').toContain('VERDICT        FAIL')
      expect(r.out, 'no mismatch').not.toContain('[MISMATCH]')
      expect(r.out, 'names the whole path').toContain(`scripts/${name}`)
      expect(r.status, 'exit').toBe(1)
    } finally {
      rmSync(file, { force: true })
    }
    expect(existsSync(file)).toBe(false)
  })

  it('a code-frame line that looks like a diagnostic is not counted as one', () => {
    // --pretty echoes the offending source line under each diagnostic,
    // prefixed by its line number. A source line containing text shaped like
    // `x:1:2 - error TS1:` must not be counted as a second diagnostic.
    const name = `zz-smi6975-frame-${process.pid}.ts`
    const file = plant(
      `scripts/${name}`,
      "export const planted: number = 'x:1:2 - error TS1: looks like a diagnostic'\n"
    )
    try {
      const r = runGate()
      expect(r.out, 'one diagnostic, counted once').toMatch(/\b1 total \/ 1 attributed\b/)
      expect(r.out, 'no mismatch').not.toContain('[MISMATCH]')
      expect(r.out, 'RESULT').toContain('RESULT         EVALUATED')
      expect(r.out, 'VERDICT').toContain('VERDICT        FAIL')
      expect(r.status, 'exit').toBe(1)
    } finally {
      rmSync(file, { force: true })
    }
    expect(existsSync(file)).toBe(false)
  })

  it('a compiler that forks a survivor cannot hold the gate past its budget (no pipe on the compile)', () => {
    // The full compile's output goes to a file. Through a pipe (`| tee`), a
    // surviving child keeps the write end open after the alarm kills the
    // compiler, and the gate waits for it: here 40s instead of ~2s.
    const dir = scratchDir('fork')
    const real = join(REPO_ROOT, 'node_modules', '.bin', 'tsc')
    makeStub(
      dir,
      'tsc-fork',
      `#!/bin/sh\ncase "$*" in *--pretty*) sleep 40 & sleep 40; exit 0 ;; esac\nexec ${real} "$@"\n`
    )
    const t0 = Date.now()
    const r = runGate(undefined, {
      SKILLSMITH_TYPECHECK_SCRIPTS_TSC_TEST: join(dir, 'tsc-fork'),
      SKILLSMITH_TYPECHECK_SCRIPTS_TIMEOUT_SECS: '2',
    })
    const elapsed = Date.now() - t0
    expect(r.out, 'RESULT').toContain('RESULT         INCONCLUSIVE')
    expect(r.out, 'cause').toMatch(/did not finish within 2s/)
    expect(r.out, 'not a pass').not.toContain('VERDICT        PASS')
    // Well under the 40s survivor, with room for a loaded host's real tsc runs.
    expect(elapsed, 'returned without waiting for the survivor').toBeLessThan(15_000)
  })

  it('a compiler that prints valid output and THEN hangs on --version or --showConfig is INCONCLUSIVE', () => {
    // Skipping the timeout guard whenever output is non-empty would accept these.
    const dir = scratchDir('hang-after-output')
    const real = join(REPO_ROOT, 'node_modules', '.bin', 'tsc')
    for (const [idx, call] of ['--version', '--showConfig'].entries()) {
      makeStub(
        dir,
        `tsc-late-${idx}`,
        `#!/bin/sh\ncase "$*" in *${call}*) ${real} "$@"; exec sleep 600 ;; esac\nexec ${real} "$@"\n`
      )
      const t0 = Date.now()
      const r = runGate(undefined, {
        SKILLSMITH_TYPECHECK_SCRIPTS_TSC_TEST: join(dir, `tsc-late-${idx}`),
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

  it('a compiler exiting 126 or 255 is INCONCLUSIVE as an unexpected status, not as a signal', () => {
    // 255 is not 128+127 and 126 is not a signal: only 129..192 is 128+signal.
    const dir = scratchDir('odd-status')
    const real = join(REPO_ROOT, 'node_modules', '.bin', 'tsc')
    for (const code of [126, 255]) {
      makeStub(
        dir,
        `tsc-exit${code}`,
        `#!/bin/sh\ncase "$*" in *--pretty*) exit ${code} ;; esac\nexec ${real} "$@"\n`
      )
      const r = runGate(undefined, {
        SKILLSMITH_TYPECHECK_SCRIPTS_TSC_TEST: join(dir, `tsc-exit${code}`),
      })
      expect(r.out, `${code}: RESULT`).toContain('RESULT         INCONCLUSIVE')
      expect(r.out, `${code}: cause`).toContain(`unexpected exit status ${code}`)
      expect(r.out, `${code}: not called a signal`).not.toContain('128+')
      expect(r.out, `${code}: not called a signal`).not.toContain('killed by a signal')
      expect(r.out, `${code}: next`).toMatch(/^ {2}next: \S/m)
      expect(r.status, `${code}: exit`).not.toBe(0)
      expect(r.out, `${code}: not a pass`).not.toContain('VERDICT        PASS')
    }
  })

  it(
    'a discovered file removed between the inventory and the compile is INCONCLUSIVE',
    () => {
      // tsc re-expands `include` when it compiles, so a root deleted after the
      // inventory simply vanishes from the program; only the compiled-file list
      // shows it. The stub deletes the file immediately before the real compile.
      const name = `zz-smi6975-vanish-${process.pid}.ts`
      const file = join(REPO_ROOT, 'scripts', name)
      const dir = scratchDir('vanish')
      const real = join(REPO_ROOT, 'node_modules', '.bin', 'tsc')
      makeStub(
        dir,
        'tsc-vanish',
        `#!/bin/sh\ncase "$*" in *--pretty*) rm -f '${file}' ;; esac\nexec ${real} "$@"\n`
      )
      makeStub(dir, 'tsc-keep', `#!/bin/sh\nexec ${real} "$@"\n`)
      try {
        plant(`scripts/${name}`, 'export const vanishing: number = 1\n')
        // Known-positive control: the same file, not deleted, is a root of an
        // EVALUATED run -- so the INCONCLUSIVE below is caused by the deletion.
        const keep = runGate(undefined, {
          SKILLSMITH_TYPECHECK_SCRIPTS_TSC_TEST: join(dir, 'tsc-keep'),
        })
        expect(keep.out, 'control: RESULT').toContain('RESULT         EVALUATED')
        const r = runGate(undefined, {
          SKILLSMITH_TYPECHECK_SCRIPTS_TSC_TEST: join(dir, 'tsc-vanish'),
        })
        expect(r.out, 'RESULT').toContain('RESULT         INCONCLUSIVE')
        expect(r.out, 'cause').toContain('tsc did not read 1 discovered file(s)')
        expect(r.out, 'names the file').toContain(`scripts/${name}`)
        expect(r.out, 'next').toMatch(/^ {2}next: \S/m)
        expect(r.out, 'not a pass').not.toContain('VERDICT        PASS')
        expect(r.status, 'exit').not.toBe(0)
      } finally {
        rmSync(file, { force: true })
      }
      expect(existsSync(file)).toBe(false)
    },
    MULTI_RUN_TIMEOUT_MS
  )

  it('scope regression: swapping a root for a different path with the SAME basename is INCONCLUSIVE', () => {
    // Same count AND same basename: only a comparison of full paths sees it. The
    // swapped-in file sits under scripts/tests/ (outside the inventory) and shares
    // its name with the root dropped from scripts/lib.
    const configPath = join(REPO_ROOT, 'tsconfig.scripts.json')
    const original = readFileSync(configPath)
    const text = original.toString('utf8')
    const dropped = readdirSync(join(REPO_ROOT, 'scripts', 'lib')).find(
      (f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.includes('.test.')
    )
    expect(dropped, 'no scripts/lib/*.ts to drop').toBeDefined()
    const droppedPath = `scripts/lib/${dropped}`
    const added = `scripts/tests/zz-smi6975-swap-${process.pid}/${dropped}`
    expect(basename(added), 'premise: same basename').toBe(basename(droppedPath))
    expect(added, 'premise: different path').not.toBe(droppedPath)
    expect(text.includes('"exclude": ['), 'exclude array not found').toBe(true)
    const planted = plant(added, 'export {}\n')
    try {
      writeFileSync(
        configPath,
        text
          .replace('"exclude": [', `"exclude": [\n    "${droppedPath}",`)
          .replace('"include":', `"files": ["${added}"],\n  "include":`)
      )
      const r = runGate()
      const discovered = /discovered\s+(\d+)/.exec(r.out)?.[1]
      const roots = /compiler roots\s+(\d+)/.exec(r.out)?.[1]
      expect(discovered, 'discovered count printed').toBeDefined()
      expect(roots, 'premise: equal totals').toBe(discovered)
      expect(r.out, 'RESULT').toContain('RESULT         INCONCLUSIVE')
      expect(r.out, 'cause').toContain('disagree -- scope could not be validated')
      expect(r.out, 'names the dropped path').toContain(droppedPath)
      expect(r.out, 'names the swapped-in path').toContain(added)
      expect(r.status, 'exit').not.toBe(0)
      expect(r.out, 'verdict').not.toContain('VERDICT        PASS')
    } finally {
      writeFileSync(configPath, original)
      rmSync(dirname(planted), { recursive: true, force: true })
    }
    expect(readFileSync(configPath).equals(original)).toBe(true)
    expect(existsSync(planted)).toBe(false)
  })
})
