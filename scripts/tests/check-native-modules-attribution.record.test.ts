/**
 * scripts/tests/check-native-modules-attribution.record.test.ts
 * SMI-6684 Wave 3 fix round -- covers what the original attribution suite
 * never asserted (adversarial review F-2, F-9, F-14, F-17): the JSONL
 * record (addendum A-1), the rendered block beyond L1 (spec §5.2 L2-L5),
 * and robustness paths (SIGPIPE mid-block, the watchdog knob, temp-file
 * cleanup, stderr silence).
 *
 * Every spawn sets HOME to a fresh temp dir via the harness (never the real
 * ~/.skillsmith -- SMI-5847 precedent).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  type Fixtures,
  type RunOpts,
  SCRIPT,
  parseAttribution,
  resolveBin,
  runCase,
  runFromCaseDir,
  setupFixtures,
  stageCase,
} from './check-native-modules-attribution.harness'

const KEYS = ['schema', 'at', 'container', 'mode', 'state', 'reason', 'cause', 'tier', 'wall_secs']

function jsonlPath(home: string): string {
  return join(home, '.skillsmith', 'logs', 'native-attribution.jsonl')
}

function records(home: string): Record<string, unknown>[] {
  const p = jsonlPath(home)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

/** The attribution block: from the L1 line up to (not including) the next blank line. */
function block(stdout: string): string[] {
  const lines = stdout.split('\n')
  const i = lines.findIndex((l) => l.startsWith('  Mount check: '))
  if (i < 0) return []
  const j = lines.indexOf('', i)
  return lines.slice(i, j < 0 ? undefined : j)
}

/** Legacy seam run (no hook-docker-detect.sh), so DOCKER_CONTAINER is honoured. */
function runSeam(env: Record<string, string>): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(resolveBin('sh') ?? '/bin/sh', [SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      SKILLSMITH_NATIVE_CHECK_TEST: 'fail',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
  })
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

const C = 'skillsmith-dev-1'
const DRILL = `  Full check: docker exec -w /app ${C} bash scripts/lib/check-mount-composition.sh --live --no-report`
const DRILL_T = `  Full check (no time limit): docker exec -w /app ${C} bash scripts/lib/check-mount-composition.sh --live --no-report`
const RESTART = `  Next: docker restart ${C}`
const STOPSTART = `  Still shown after the restart: docker stop ${C} && docker start ${C}`
const BS = '/app/packages/core/node_modules/better-sqlite3/build/Release'

describe('check-native-modules.sh attribution: record, render, robustness (fix round)', () => {
  let fx: Fixtures
  beforeAll(() => {
    fx = setupFixtures()
  })
  afterAll(() => {
    fx.cleanup()
  })

  describe('JSONL record (addendum A-1)', () => {
    it('R-JSONL-1: one schema-1 line, fields in the normative order, for a grid run', () => {
      const r = runCase(fx, 'R-main-degraded')
      expect(r.status).toBe(1)
      const recs = records(r.home)
      expect(recs).toHaveLength(1)
      const rec = recs[0]!
      expect(Object.keys(rec)).toEqual(KEYS)
      expect(rec['at']).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
      expect(rec).toMatchObject({
        schema: 1,
        container: C,
        mode: 'main',
        state: 'FINDINGS + PARTIAL',
        reason: '',
        cause: 'FALL-THROUGH',
        tier: 1,
      })
      expect(Number.isInteger(rec['wall_secs'])).toBe(true)
      expect(rec['wall_secs'] as number).toBeGreaterThanOrEqual(0)
    })

    const ROWS: [string, RunOpts, Record<string, unknown>][] = [
      [
        'R-timeout-partial',
        {},
        {
          mode: 'unknown',
          state: 'TIMEOUT',
          reason: 'checker-timeout:10s',
          cause: 'NOT-DETERMINED',
          tier: 0,
        },
      ],
      [
        'S-mismatch-f1',
        {},
        {
          mode: 'worktree',
          state: 'FINDINGS, REPORT/OUTPUT MISMATCH',
          reason: '',
          cause: 'NOT-DETERMINED',
          tier: 0,
        },
      ],
      [
        'S-root',
        {},
        { mode: 'worktree', state: 'FINDINGS', reason: '', cause: 'FALL-THROUGH', tier: 2 },
      ],
      [
        'T-complete-degraded',
        {},
        {
          mode: 'main',
          state: 'TIMEOUT',
          reason: 'checker-timeout:10s',
          cause: 'MOUNT-MISSING',
          tier: 1,
        },
      ],
      [
        'N-disable-host',
        { env: { SKILLSMITH_MOUNT_COMPOSITION_DISABLE: '1' } },
        {
          mode: 'unknown',
          state: 'NO-REPORT',
          reason: 'checker-disabled',
          cause: 'NOT-DETERMINED',
          tier: 0,
        },
      ],
    ]
    it.each(ROWS)(
      'R-JSONL-2: %s is recorded as parseable JSON with its classification',
      (id, opts, want) => {
        const r = runCase(fx, id, opts)
        const recs = records(r.home)
        expect(recs).toHaveLength(1)
        expect(recs[0]).toMatchObject({ schema: 1, container: C, ...want })
      }
    )

    it('R-JSONL-3: OFF is still recorded, with the disable var as the reason', () => {
      const r = runCase(fx, 'S-clean', {
        env: { SKILLSMITH_NATIVE_CHECK_ATTRIBUTION_DISABLE: '1' },
      })
      expect(records(r.home)).toEqual([
        expect.objectContaining({
          mode: 'unknown',
          state: 'OFF',
          reason: 'SKILLSMITH_NATIVE_CHECK_ATTRIBUTION_DISABLE=1',
          cause: 'NOT-DETERMINED',
          tier: 0,
          wall_secs: 0,
        }),
      ])
    })

    it('R-JSONL-4: stdout on /dev/null records SKIPPED-DEVNULL (and runs no attribution exec)', () => {
      const r = runCase(fx, 'S-clean', { devnull: true })
      expect(r.execCount).toBe(1)
      expect(records(r.home)).toEqual([
        expect.objectContaining({
          state: 'SKIPPED-DEVNULL',
          reason: '',
          cause: 'NOT-DETERMINED',
          tier: 0,
        }),
      ])
    })

    it('R-JSONL-5: nothing is recorded on success, without Docker, or under SKILLSMITH_SKIP_NATIVE_CHECK=1', () => {
      for (const opts of [
        { fakeProbeRc: '0' },
        { fakePs: '' },
        { env: { SKILLSMITH_SKIP_NATIVE_CHECK: '1' } },
      ] as RunOpts[]) {
        const r = runCase(fx, 'S-clean', opts)
        expect(r.status).toBe(0)
        expect(existsSync(join(r.home, '.skillsmith'))).toBe(false)
      }
    })

    it('R-JSONL-6: wall_secs is the measured host time, not a constant', () => {
      const r = runCase(fx, 'T-host-watchdog', {
        fakeDockerSleep: '4',
        env: { SKILLSMITH_NATIVE_CHECK_ATTRIBUTION_WATCHDOG_SECS: '1' },
      })
      const recs = records(r.home)
      expect(recs).toHaveLength(1)
      expect(recs[0]!['wall_secs'] as number).toBeGreaterThanOrEqual(1)
    })

    it('R-JSONL-7: a JSON-unsafe container name is recorded as "invalid", never raw', () => {
      const home = mkdtempSync(join(fx.root, 'home-'))
      const r = runSeam({ HOME: home, DOCKER_CONTAINER: 'bad"name\\x' })
      expect(r.status).toBe(1)
      const raw = readFileSync(jsonlPath(home), 'utf8')
      expect(raw).not.toContain('\\')
      expect(records(home)).toEqual([
        expect.objectContaining({
          container: 'invalid',
          state: 'UNEXPECTED',
          reason: 'exec-exit:1',
        }),
      ])
    })

    // F-17 (SMI-6684 Wave 3 review): the allow-list must reject a non-ASCII
    // letter regardless of locale -- a bracket-expression RANGE (A-Za-z) is
    // collation-order-dependent and can let an accented letter through under
    // some locales. LC_ALL is set here so the property is exercised under
    // the same locale the review measured the bug in when available; the
    // literal-charset fix is locale-independent either way, so this must
    // pass whether or not the container actually has that locale installed.
    it('R-JSONL-9: a non-ASCII container name is recorded as "invalid" under a UTF-8 locale', () => {
      const home = mkdtempSync(join(fx.root, 'home-'))
      const r = runSeam({ HOME: home, DOCKER_CONTAINER: 'caf\u00e9-dev-1', LC_ALL: 'en_US.UTF-8' })
      expect(r.status).toBe(1)
      expect(records(home)).toEqual([
        expect.objectContaining({
          container: 'invalid',
          state: 'UNEXPECTED',
          reason: 'exec-exit:1',
        }),
      ])
    })

    it.each([
      [
        '~/.skillsmith is a regular file',
        (h: string) => writeFileSync(join(h, '.skillsmith'), 'x'),
        (h: string) => h,
      ],
      [
        'the log path is a directory',
        (h: string) => mkdirSync(jsonlPath(h), { recursive: true }),
        (h: string) => h,
      ],
    ])(
      'R-JSONL-8: unwritable record (%s) keeps rc=1 and adds no stderr',
      (_label, prep, homeOf) => {
        for (const [id, extra, cause] of [
          ['R-main-degraded', {}, 'FALL-THROUGH'],
          ['S-clean', { SKILLSMITH_NATIVE_CHECK_ATTRIBUTION_DISABLE: '1' }, 'NOT-DETERMINED'],
        ] as [string, Record<string, string>, string][]) {
          const base = mkdtempSync(join(fx.root, 'home-'))
          prep(base)
          const r = runCase(fx, id, { home: homeOf(base), env: extra })
          expect(r.status, id).toBe(1)
          expect(parseAttribution(r.stdout)?.cause, id).toBe(cause)
          expect(
            r.stdout.split('\n').filter((l) => l.startsWith('  Mount check: ')),
            id
          ).toHaveLength(1)
          expect(r.stderr, id).toBe('')
        }
      }
    )
  })

  describe('render contract beyond L1 (spec §5.2)', () => {
    const BLOCKS: [string, RunOpts, string[]][] = [
      [
        'R-main-degraded',
        {},
        [
          '  Mount check: FINDINGS + PARTIAL -- cause: FALL-THROUGH [11 findings, 3 not evaluated]',
          `    better-sqlite3 mount is detached; the host macOS binary is served in its place: ${BS}/test_extension.node`,
          RESTART,
          STOPSTART,
          DRILL,
        ],
      ],
      [
        'S-c4-main',
        {},
        [
          '  Mount check: FINDINGS + PARTIAL -- cause: MOUNT-MISSING [9 findings, 3 not evaluated]',
          '    the declared mount at or above better-sqlite3 is not mounted: /app/packages/core/node_modules',
          RESTART,
          STOPSTART,
          DRILL,
        ],
      ],
      [
        'S-c4-wt',
        {},
        [
          '  Mount check: FINDINGS -- cause: MOUNT-MISSING [28 findings, 0 not evaluated]',
          '    the declared mount at or above better-sqlite3 is not mounted: /packages/core/node_modules/better-sqlite3',
          RESTART,
          `${STOPSTART}; survives that too: ./scripts/repair-worktrees.sh (main checkout), then ./scripts/worktree-docker.sh stop && ./scripts/worktree-docker.sh start`,
          DRILL,
        ],
      ],
      [
        'S-subst-wt',
        {},
        [
          '  Mount check: FINDINGS -- cause: MOUNT-SUBSTITUTED [3 findings, 0 not evaluated]',
          '    something other than the declared volume is mounted at better-sqlite3: /packages/core/node_modules/better-sqlite3',
          '  Next: ./scripts/worktree-docker.sh stop && ./scripts/worktree-docker.sh start',
          DRILL,
        ],
      ],
      [
        'S-c2-wt',
        {},
        [
          '  Mount check: FINDINGS -- cause: SEED-CONTENT [2 findings, 0 not evaluated]',
          `    the better-sqlite3 volume is mounted but holds a non-Linux binary: ${BS}/better_sqlite3.node`,
          '  Next: attach the full check output below to SMI-6547 -- a restart or rebuild re-seeds the same content',
          DRILL,
        ],
      ],
      [
        'S-other-a8',
        {},
        [
          '  Mount check: FINDINGS -- cause: OTHER-NATIVE-FINDING [2 findings, 0 not evaluated]',
          `    the checker reported a finding at better-sqlite3 that this message does not classify: ${BS}/better_sqlite3.node`,
          '  Next: run the full check below and act on its better-sqlite3 FAIL line',
          DRILL,
        ],
      ],
      [
        'S-root',
        {},
        [
          '  Mount check: FINDINGS -- cause: FALL-THROUGH [2 findings, 0 not evaluated]',
          '    better-sqlite3 mount is detached; the host macOS binary is served in its place (root copy): /app/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
          RESTART,
          STOPSTART,
          DRILL,
        ],
      ],
      [
        'T-partial-evidence',
        {},
        [
          '  Mount check: TIMEOUT -- cause: FALL-THROUGH [checker-timeout:10s]',
          `    better-sqlite3 mount is detached; the host macOS binary is served in its place: ${BS}/test_extension.node (from partial output)`,
          RESTART,
          STOPSTART,
          DRILL_T,
        ],
      ],
      [
        'R-wt-floor',
        {},
        [
          '  Mount check: FINDINGS -- cause: NO-NATIVE-FINDING [1 findings, 0 not evaluated]',
          '    nothing is wrong at better-sqlite3 now: never built, or a mount fault already repaired -- not distinguishable here',
          RESTART,
          DRILL,
        ],
      ],
      [
        'S-mismatch-f1',
        {},
        [
          '  Mount check: FINDINGS, REPORT/OUTPUT MISMATCH -- cause: NOT-DETERMINED [report says 1 findings; output shows 30]',
          '    the report and the checker output disagree, so no cause is named; this is not a clean result',
          RESTART,
          DRILL,
        ],
      ],
      [
        'A-unavailable',
        { appDir: 'APP_NOCHECKER' },
        [
          '  Mount check: UNAVAILABLE -- cause: NOT-DETERMINED [checker-absent]',
          '    this branch predates the mount checker, so the cause was not examined; this is not a clean result',
          RESTART,
          '  The checker ships on main; rebase this branch to get it.',
        ],
      ],
    ]
    it.each(BLOCKS)('R-BLOCK: %s renders the full block', (id, opts, want) => {
      const o = opts.appDir === 'APP_NOCHECKER' ? { ...opts, appDir: fx.appNoCheckerDir } : opts
      const r = runCase(fx, id, o)
      expect(r.status).toBe(1)
      expect(block(r.stdout)).toEqual(want)
    })

    it('R-BLOCK-C: the container name in L3/L5 is the resolved one, not a default', () => {
      const home = mkdtempSync(join(fx.root, 'home-'))
      const r = runSeam({ HOME: home, DOCKER_CONTAINER: 'smi-9999-example-dev-1' })
      const b = block(r.stdout)
      expect(b).toContain('  Next: docker restart smi-9999-example-dev-1')
      expect(b.at(-1)).toBe(
        '  Full check: docker exec -w /app smi-9999-example-dev-1 bash scripts/lib/check-mount-composition.sh --live --no-report'
      )
    })

    // Spec §5.2 "Per non-grid state" L2 rows and F-5's budget-in-reason.
    const PER_STATE: [string, RunOpts, string, string][] = [
      [
        'R-timeout-partial',
        {},
        'TIMEOUT -- cause: NOT-DETERMINED [checker-timeout:10s]',
        '    the check did not finish within 10s, so the cause was not examined; this is not a clean result',
      ],
      [
        'U-rc2',
        {},
        'UNEXPECTED -- cause: NOT-DETERMINED [checker-exit:2]',
        '    the check could not run to completion, so the cause was not examined; this is not a clean result',
      ],
      [
        'M-garbage',
        {},
        'MALFORMED -- cause: NOT-DETERMINED [report:invalid-json]',
        '    the check ran but its report was unusable, so the cause was not examined; this is not a clean result',
      ],
      [
        'N-disable-host',
        { env: { SKILLSMITH_MOUNT_COMPOSITION_DISABLE: '1' } },
        'NO-REPORT -- cause: NOT-DETERMINED [checker-disabled]',
        '    the checker is disabled (SKILLSMITH_MOUNT_COMPOSITION_DISABLE=1), so the cause was not examined; this is not a clean result',
      ],
      [
        'N-norep',
        {},
        'NO-REPORT -- cause: NOT-DETERMINED [report-absent]',
        '    the check exited without writing a report, so the cause was not examined; this is not a clean result',
      ],
    ]
    it.each(PER_STATE)('R-STATE: %s renders its own L1 reason and L2', (id, opts, l1, l2) => {
      const r = runCase(fx, id, opts)
      const b = block(r.stdout)
      expect(b[0]).toBe(`  Mount check: ${l1}`)
      expect(b[1]).toBe(l2)
    })
  })

  describe('robustness', () => {
    it('R-PIPE: a reader that closes mid-attribution (SIGPIPE inside the subshell) still exits 1 and records one row', () => {
      const r = runCase(fx, 'R-main-degraded', { fakeDockerSleep: '1', closeStdoutAfterLines: 10 })
      expect(r.status).toBe(1)
      // D-a / F-11 (SMI-6684 Wave 3 fix round): record BEFORE render means a
      // reader closing mid-block still leaves exactly one JSONL row.
      const recs = records(r.home)
      expect(recs).toHaveLength(1)
      expect(recs[0]).toMatchObject({ container: C, mode: 'main', cause: 'FALL-THROUGH' })
    })

    it.each(['0', '00', '-5'])(
      'R-KNOB: watchdog knob %j never forces an instant host-watchdog TIMEOUT',
      (v) => {
        const r = runCase(fx, 'R-wt-floor', {
          fakeDockerSleep: '1',
          env: { SKILLSMITH_NATIVE_CHECK_ATTRIBUTION_WATCHDOG_SECS: v },
        })
        expect(parseAttribution(r.stdout)?.state).toBe('FINDINGS')
      }
    )

    it('R-TMP: no host temp file survives a failure run, a watchdog run, or a healthy run', () => {
      for (const [id, opts] of [
        ['R-main-degraded', {}],
        [
          'T-host-watchdog',
          { fakeDockerSleep: '4', env: { SKILLSMITH_NATIVE_CHECK_ATTRIBUTION_WATCHDOG_SECS: '1' } },
        ],
        ['S-clean', { fakeProbeRc: '0' }],
      ] as [string, RunOpts][]) {
        const tmp = mkdtempSync(join(fx.root, 'hosttmp-'))
        const r = runCase(fx, id, { ...opts, env: { ...(opts.env ?? {}), TMPDIR: tmp } })
        expect(r.status).toBeGreaterThanOrEqual(0)
        expect(readdirSync(tmp), id).toEqual([])
      }
    })

    it('R-QUIET: a host-watchdog run writes nothing to stderr', () => {
      const r = runCase(fx, 'T-host-watchdog', {
        fakeDockerSleep: '4',
        env: { SKILLSMITH_NATIVE_CHECK_ATTRIBUTION_WATCHDOG_SECS: '1' },
      })
      expect(r.stderr).toBe('')
    })

    it('R-PARSER: a non-integer-printing findings value is MALFORMED [report:parser-incomplete]', () => {
      const staged = stageCase(fx.root, 'S-clean')
      const rep = join(staged, 'report')
      const txt = readFileSync(rep, 'utf8')
      expect(txt).toContain('"findings":0,')
      writeFileSync(rep, txt.replace('"findings":0,', '"findings":1e21,'))
      const r = runFromCaseDir(fx, staged)
      const p = parseAttribution(r.stdout)
      expect(p?.state).toBe('MALFORMED')
      expect(p?.detail).toBe('report:parser-incomplete')
    })

    it('R-ID: a two-digit assertion id at the native path is OTHER-NATIVE-FINDING, never an absence claim', () => {
      const staged = stageCase(fx.root, 'S-other-a8')
      const out = join(staged, 'stdout')
      const txt = readFileSync(out, 'utf8')
      expect(txt).toContain('FAIL [A8] ')
      writeFileSync(out, txt.replace('FAIL [A8] ', 'FAIL [A10] '))
      const p = parseAttribution(runFromCaseDir(fx, staged).stdout)
      expect(p?.cause).toBe('OTHER-NATIVE-FINDING')
    })

    it('R-PIN: the two A4 cause strings the classifier keys on exist verbatim in the checker', () => {
      const probes = readFileSync(join(SCRIPT, '..', 'check-mount-composition.probes.sh'), 'utf8')
      for (const f of [
        'destination is NOT mounted -- READ-ONLY-PARENT FALL-THROUGH: ',
        'destination IS mounted, so the SEEDED VOLUME CONTENT itself is wrong (not a fall-through)',
        'expected ELF (declared $dst, volume=$src, version=$ver) -- $cause',
      ]) {
        expect(probes.includes(f), f).toBe(true)
      }
    })
  })
})
