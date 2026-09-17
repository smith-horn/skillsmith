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
const ALLOWED_RUN_CMD = [
  /run_cmd node -e/, // the read-only createDatabaseSync(':memory:') probe
  /run_cmd sh -c "\$NCA_PRODUCER"/, // SMI-6684 Wave 3: read-only mount-composition attribution
]

/** Lines that run a mutating command for real, outside a comment or printf. */
function mutatingOffenders(src: string): string[] {
  return src.split('\n').filter((line) => {
    const t = line.trim()
    if (t.startsWith('#')) return false
    if (/^\s*printf\b/.test(line)) return false
    if (/\brun_cmd\b/.test(line)) {
      if (/^\s*fail\)/.test(line)) return false // the test seam's run_cmd() { return 1; }
      if (/run_cmd\(\)/.test(line)) return false // the run_cmd() definition itself
      // One per line, or the allow-list does not apply: it matches a
      // substring, so an allowed call plus a chained second one would
      // otherwise satisfy it.
      if ((line.match(/\brun_cmd\b/g) ?? []).length > 1) return true
      return !ALLOWED_RUN_CMD.some((re) => re.test(line))
    }
    return /npm\s+(install|ci|rebuild)\b|docker\s+exec\b/.test(line)
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

  // Post-merge retro on PR #2873. The predicate above is only as good as its
  // own edge cases, and the previous version's allow-list matched a SUBSTRING:
  // a line carrying an allowed call AND a chained second one satisfied it and
  // would have shipped invisibly. That is the same unanchored-predicate class
  // the pre-merge gate found one round earlier, reintroduced by its own fix —
  // which nothing caught, because no round reviewed that fix. So the guard now
  // has its own cases, each carrying exactly one reason to fail.
  it.each([
    ['a bare mutating run_cmd', '    run_cmd rm -rf /app/node_modules', true],
    [
      'a second run_cmd chained onto an allowed one',
      '    run_cmd sh -c "$NCA_PRODUCER" ; run_cmd rm -rf /app/node_modules',
      true,
    ],
    ['a raw docker exec', '    docker exec "$C" npm install', true],
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
    ['a comment naming a mutating command', '    # never: run_cmd npm install', false],
    [
      'a printf naming a mutating command',
      '    printf "  docker exec -w /app %s ...\\n" "$C"',
      false,
    ],
  ])('READ-ONLY guard: %s', (_label, line, shouldFlag) => {
    expect(mutatingOffenders(line)).toEqual(shouldFlag ? [line] : [])
  })
})
