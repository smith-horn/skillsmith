/**
 * SMI-5513: Tests for scripts/lib/check-native-modules.sh — the container
 * native-binding health preflight.
 *
 * Driven via the SKILLSMITH_NATIVE_CHECK_TEST seam so the container probe is
 * deterministic without a real Docker container. Per the "never skipIf(inDocker)"
 * lesson (SMI-5426), this runs inside CI's in-Docker vitest and must exercise
 * the branching logic rather than no-op there.
 *
 * Cases:
 *   opt-out:      SKILLSMITH_SKIP_NATIVE_CHECK=1 wins even with a failing seam.
 *   healthy:      seam=ok → exit 0, silent.
 *   broken:       seam=fail → exit 1, actionable remedy (docker restart +
 *                 regen-lockfile + scoped opt-out), and does NOT advertise the
 *                 blanket `--no-verify` footgun (SMI-5344 consistency).
 *   source guard: no line runs `npm install` or a real `docker exec` --
 *                 directly or via `run_cmd` -- outside a comment, a
 *                 `printf`, or the two allow-listed read-only invocations
 *                 (READ-ONLY P-5 discipline).
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, '..', 'lib', 'check-native-modules.sh')

// `run_cmd` IS `docker exec` (scripts/lib/hook-docker-detect.sh), so it is a
// first-class docker-exec surface here, not just the literal text. The
// allow-list is closed: a third call site has to justify itself in this file.
// It is matched against ONE COMMAND, never a whole line — a substring match
// against a line lets an allowed call vouch for whatever is chained after it.
const ALLOWED_RUN_CMD = [
  /^run_cmd node -e/, // the read-only createDatabaseSync(':memory:') probe
  /^run_cmd sh -c "\$NCA_PRODUCER"/, // SMI-6684 Wave 3: read-only mount-composition attribution
]

/**
 * Commands that mutate for real. `npm i` is `npm install`, and `docker exec`
 * has three spellings.
 *
 * KNOWN GAP, stated rather than implied: a flag between the command and its
 * subcommand still evades it (`npm --prefix /app install`). Closing that needs
 * argument parsing, not a wider alternation, and nothing in this repo writes
 * npm that way today. It is a guard against an accidental line, not an
 * adversary.
 */
const MUTATING = /\bnpm\s+(install|i|ci|rebuild)\b|\bdocker\s+(container\s+|compose\s+)?exec\b/

/**
 * Lines that run a mutating command for real, outside a comment or printf.
 *
 * Re-derived rather than patched a third time (pr-reviewer skill: "after the
 * second consecutive finding on the same mechanism, delete it and re-derive").
 * Three rounds found three holes in the line-at-a-time version: it could not
 * see `run_cmd` at all; then its allow-list matched a substring; then its
 * one-per-line rule counted only `run_cmd`, so `run_cmd <allowed> ; npm install`
 * still passed. Each fix was locally correct and the shape stayed wrong.
 *
 * The requirement is per-COMMAND, so this is too: strip the trailing comment,
 * split the line into commands, and judge each one alone. An exemption can then
 * only ever excuse the command it applies to.
 *
 * KNOWN GAP, stated rather than implied: this reads ONE LINE AT A TIME, so a
 * command split across a `\` continuation is invisible to it
 * (`docker \` + newline + `exec "$C" true`). The script already writes the
 * allow-listed producer call that way, so it is the house style at that very
 * call site. Closing it needs line-joining, not a wider predicate.
 */
function mutatingOffenders(src: string): string[] {
  /** Cut a trailing comment, but only at a `#` that is not inside quotes. */
  const stripComment = (s: string): string => {
    let quote: string | null = null
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      if (quote) {
        if (c === quote) quote = null
        continue
      }
      if (c === '"' || c === "'") quote = c
      else if (c === '#' && (i === 0 || /\s/.test(s[i - 1] as string))) return s.slice(0, i)
    }
    return s
  }

  return src.split('\n').filter((line) => {
    if (/^\s*#/.test(line)) return false // a whole-line comment runs nothing
    if (/^\s*run_cmd\(\)\s*\{/.test(line)) return false // the run_cmd() definition itself
    if (/^\s*fail\)/.test(line)) return false // the test seam's run_cmd() { return 1; }

    return stripComment(line)
      .split(/;|&&|\|\||\||&/) // one command per segment
      .map((seg) => {
        // Peel the shell words that PRECEDE a command without being one, so the
        // allow-list can anchor on the command itself. `if npm install` still
        // flags: peeling `if` leaves the mutating command exposed, not excused.
        let cmd = seg.trim()
        for (;;) {
          const peeled = cmd.replace(
            /^(?:[([{]\s*|!\s*|(?:if|then|elif|else|while|until|do|time)\s+)/,
            ''
          )
          if (peeled === cmd) return cmd
          cmd = peeled
        }
      })
      .some((cmd) => {
        if (cmd === '' || /^(printf|echo)\b/.test(cmd)) return false // these only print
        // A mutating command substituted INTO an allowed command's arguments
        // still runs, so the allow-list never suppresses this check.
        if (MUTATING.test(cmd)) return true
        return /\brun_cmd\b/.test(cmd) && !ALLOWED_RUN_CMD.some((re) => re.test(cmd))
      })
  })
}

function run(env: Record<string, string> = {}): { status: number; output: string } {
  // SMI-6684 Wave 3 / addendum A-1: the failure path now writes one JSONL
  // line to $HOME/.skillsmith/logs on every failure-path run. HOME is
  // always pointed at a fresh temp dir here (SMI-5847 precedent) so no
  // test can ever touch a real operator's ~/.skillsmith.
  const home = mkdtempSync(join(tmpdir(), 'nca-legacy-home-'))
  const r = spawnSync('sh', [SCRIPT], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  })
  return { status: r.status ?? 1, output: (r.stdout ?? '') + (r.stderr ?? '') }
}

describe('check-native-modules.sh (SMI-5513)', () => {
  it('opt-out: SKILLSMITH_SKIP_NATIVE_CHECK=1 wins even over a failing seam', () => {
    const r = run({ SKILLSMITH_SKIP_NATIVE_CHECK: '1', SKILLSMITH_NATIVE_CHECK_TEST: 'fail' })
    expect(r.status).toBe(0)
    expect(r.output).toBe('')
  })

  it('healthy probe (seam=ok) exits 0 silently', () => {
    const r = run({ SKILLSMITH_NATIVE_CHECK_TEST: 'ok' })
    expect(r.status).toBe(0)
    expect(r.output).toBe('')
  })

  it('broken probe (seam=fail) exits 1 with the actionable remedy (T-LEGACY, spec §6.5)', () => {
    const r = run({ SKILLSMITH_NATIVE_CHECK_TEST: 'fail' })
    expect(r.status).toBe(1)
    // Under the SKILLSMITH_NATIVE_CHECK_TEST=fail seam, run_cmd() { return 1; }
    // is used for BOTH the probe and the attribution exec, so attribution
    // classifies UNEXPECTED [exec-exit:1] without ever invoking docker
    // (spec §6.5) — this replaces the pre-SMI-6684 `/restart dev/` grep,
    // which no longer matches (the text is now `docker restart <C>`).
    expect(r.output).toMatch(/Mount check: UNEXPECTED -- cause: NOT-DETERMINED \[exec-exit:1\]/)
    expect(r.output).toMatch(/regen-lockfile/)
    expect(r.output).toMatch(/SKILLSMITH_SKIP_NATIVE_CHECK/)
    // SMI-5344: an environmental guard must not advertise the blanket
    // `git push --no-verify` footgun — only the scoped opt-out.
    expect(r.output).not.toMatch(/--no-verify/)
  })

  it('READ-ONLY: no mutating command outside comments/printf/test-seam', () => {
    expect(mutatingOffenders(readFileSync(SCRIPT, 'utf8'))).toEqual([])
  })

  // The predicate above is only as good as its own cases. Three review rounds
  // found three holes in it, each inside the previous round's fix, so it was
  // re-derived per-command rather than patched again. Every row below differs
  // from a passing line in EXACTLY ONE way: a row with two defects verifies
  // only whichever the predicate notices first, and tightening the predicate
  // then keeps the row green while the second defect ships.
  it.each([
    // --- must flag: one mutating command each -------------------------------
    ['a bare mutating run_cmd', '    run_cmd rm -rf /app/node_modules', true],
    [
      'a run_cmd chained after an allowed one',
      '    run_cmd sh -c "$NCA_PRODUCER" ; run_cmd rm -rf /app/node_modules',
      true,
    ],
    [
      'npm chained after an allowed run_cmd',
      '    run_cmd sh -c "$NCA_PRODUCER" ; npm install',
      true,
    ],
    // One row per separator, and each chains a RUN_CMD rather than an `npm`:
    // `MUTATING` matches anywhere on the line, so an npm-based row flags with
    // or without the split and pins nothing. Only a second `run_cmd` forces the
    // splitter to do the work. Every chained row used `;` before, so narrowing
    // the splitter to /;/ was caught by nothing — found by the delta review.
    ['a run_cmd chained with &&', '    run_cmd node -e "x" && run_cmd rm -rf /app', true],
    ['a run_cmd chained with ||', '    run_cmd node -e "x" || run_cmd rm -rf /app', true],
    ['a run_cmd chained with a pipe', '    run_cmd node -e "x" | run_cmd rm -rf /app', true],
    [
      'a run_cmd chained with a background &',
      '    run_cmd node -e "x" & run_cmd rm -rf /app',
      true,
    ],
    // A `#` inside quotes is not a comment; truncating there hid the rest.
    ['npm after a quoted hash', '    msg="a # b" ; npm install', true],
    // A mutating command substituted into an allowed command's own arguments.
    ['npm inside an allowed command substitution', '    run_cmd node -e "x$(npm install)"', true],
    [
      'docker exec chained after an allowed run_cmd',
      '    run_cmd node -e "x" ; docker exec "$C" true',
      true,
    ],
    [
      'a chained command hidden behind a trailing run_cmd() comment',
      '    run_cmd sh -c "$NCA_PRODUCER" ; run_cmd rm -rf /app # run_cmd()',
      true,
    ],
    ['a raw docker exec', '    docker exec "$C" true', true],
    ['docker container exec', '    docker container exec "$C" true', true],
    ['docker compose exec', '    docker compose exec dev true', true],
    ['npm install', '    npm install', true],
    ['npm i, the short spelling', '    npm i', true],
    // Pins the allow-list ANCHORS: unanchored, the allowed text vouches for a
    // command that merely contains it.
    ['an allowed call smuggled behind eval', '    eval run_cmd node -e "x"', true],
    // --- must not flag: one exemption each -----------------------------------
    [
      'the allowed producer call',
      '    ( run_cmd sh -c "$NCA_PRODUCER" nca "$T" ) >"$env" &',
      false,
    ],
    [
      'the allowed probe call',
      '    if run_cmd node -e "require(\'@skillsmith/core\')"; then',
      false,
    ],
    ['an indented comment naming a mutating command', '    # never: run_cmd npm install', false],
    // Pins the `^\s*#` skip on its own: the only other column-0 comment cover
    // was one incidental line in the real script.
    ['a column-0 comment naming a mutating command', '# docker exec is described here', false],
    ['an echo naming a mutating command', '    echo "run: docker exec $C npm install"', false],
    [
      'a printf naming a mutating command',
      '    printf "  docker exec -w /app %s ...\\n" "$C"',
      false,
    ],
    // Pins the trailing-comment strip: without it, prose in a comment reads as
    // a command and the guard cries wolf on an inert line.
    [
      'a trailing comment mentioning npm install',
      '    target=/app # npm install would be wrong',
      false,
    ],
    ['the run_cmd() definition', '    run_cmd() {', false],
    ['the test seam arm', '        fail) USE_DOCKER=1 ; run_cmd() { return 1; } ;;', false],
  ])('READ-ONLY guard: %s', (_label, line, shouldFlag) => {
    expect(mutatingOffenders(line)).toEqual(shouldFlag ? [line] : [])
  })
})
