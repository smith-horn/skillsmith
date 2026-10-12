/**
 * scripts/tests/check-native-modules-attribution.test.ts
 * SMI-6684 Wave 3 — tests for the cause-attribution layer added to the
 * failure path of scripts/lib/check-native-modules.sh (ADR-165). Drives the
 * REAL script end to end through the PATH-injected fakes in
 * check-native-modules-attribution.harness.ts.
 *
 * Every test spawns with HOME pointed at a fresh temp dir (never the real
 * ~/.skillsmith — SMI-5847 precedent). Assertions parse the §5.2 stable
 * grep contract (category/cause/tier/evidence), never incidental
 * substrings.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

const __dirname = dirname(fileURLToPath(import.meta.url))

const GRID = new Set(['CLEAN', 'PARTIAL', 'FINDINGS', 'FINDINGS + PARTIAL'])

interface CaseExpectation {
  id: string
  state: string
  reason?: string
  cause: string
  tier: 0 | 1 | 2
  mismatch?: boolean
  evidence?: string
  opts?: RunOpts
}

// The 42-row case table (SMI-6684 plan, § Wave 3), executed 42/42 against the
// prototype in all 4 shell combinations.
const CASES: CaseExpectation[] = [
  {
    id: 'R-main-degraded',
    state: 'FINDINGS + PARTIAL',
    cause: 'FALL-THROUGH',
    tier: 1,
    evidence: '/app/packages/core/node_modules/better-sqlite3/build/Release/test_extension.node',
  },
  {
    id: 'R-wt-degraded',
    state: 'FINDINGS',
    cause: 'FALL-THROUGH',
    tier: 1,
    evidence: '/app/packages/core/node_modules/better-sqlite3/build/Release/test_extension.node',
  },
  { id: 'R-wt-floor', state: 'FINDINGS', cause: 'NO-NATIVE-FINDING', tier: 0 },
  {
    id: 'R-timeout-partial',
    state: 'TIMEOUT',
    reason: 'checker-timeout:10s',
    cause: 'NOT-DETERMINED',
    tier: 0,
  },
  { id: 'S-main-floor', state: 'FINDINGS + PARTIAL', cause: 'NO-NATIVE-FINDING', tier: 0 },
  { id: 'S-clean', state: 'CLEAN', cause: 'NO-NATIVE-FINDING', tier: 0 },
  { id: 'S-partial', state: 'PARTIAL', cause: 'NO-NATIVE-FINDING', tier: 0 },
  {
    id: 'S-c4-main',
    state: 'FINDINGS + PARTIAL',
    cause: 'MOUNT-MISSING',
    tier: 1,
    evidence: '/app/packages/core/node_modules',
  },
  {
    id: 'S-c4-wt',
    state: 'FINDINGS',
    cause: 'MOUNT-MISSING',
    tier: 1,
    evidence: '/packages/core/node_modules/better-sqlite3',
  },
  {
    id: 'S-c2-wt',
    state: 'FINDINGS',
    cause: 'SEED-CONTENT',
    tier: 1,
    evidence: '/app/packages/core/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  },
  {
    id: 'S-subst-wt',
    state: 'FINDINGS',
    cause: 'MOUNT-SUBSTITUTED',
    tier: 1,
    evidence: '/packages/core/node_modules/better-sqlite3',
  },
  {
    id: 'S-other-a8',
    state: 'FINDINGS',
    cause: 'OTHER-NATIVE-FINDING',
    tier: 1,
    evidence: '/app/packages/core/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  },
  {
    id: 'S-stale-seed',
    state: 'FINDINGS',
    cause: 'OTHER-NATIVE-FINDING',
    tier: 1,
    evidence: '/app/packages/core/node_modules/better-sqlite3',
  },
  { id: 'S-sibling', state: 'FINDINGS', cause: 'NO-NATIVE-FINDING', tier: 0 },
  { id: 'S-othercopy', state: 'FINDINGS', cause: 'NO-NATIVE-FINDING', tier: 0 },
  {
    id: 'S-root',
    state: 'FINDINGS',
    cause: 'FALL-THROUGH',
    tier: 2,
    evidence: '/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  },
  {
    id: 'S-both-tiers',
    state: 'FINDINGS',
    cause: 'SEED-CONTENT',
    tier: 1,
    evidence: '/app/packages/core/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  },
  { id: 'S-grid-nosummary', state: 'FINDINGS', cause: 'NOT-DETERMINED', tier: 0 },
  { id: 'S-mismatch-clean', state: 'CLEAN', cause: 'NOT-DETERMINED', tier: 0, mismatch: true },
  { id: 'S-mismatch-f1', state: 'FINDINGS', cause: 'NOT-DETERMINED', tier: 0, mismatch: true },
  {
    id: 'T-complete-report',
    state: 'TIMEOUT',
    reason: 'checker-timeout:10s',
    cause: 'NOT-DETERMINED',
    tier: 0,
  },
  {
    id: 'T-complete-degraded',
    state: 'TIMEOUT',
    reason: 'checker-timeout:10s',
    cause: 'MOUNT-MISSING',
    tier: 1,
    evidence: '/app/packages/core/node_modules',
  },
  {
    id: 'T-partial-evidence',
    state: 'TIMEOUT',
    reason: 'checker-timeout:10s',
    cause: 'FALL-THROUGH',
    tier: 1,
    evidence: '/app/packages/core/node_modules/better-sqlite3/build/Release/test_extension.node',
  },
  {
    id: 'T-partial-lastline',
    state: 'TIMEOUT',
    reason: 'checker-timeout:10s',
    cause: 'NOT-DETERMINED',
    tier: 0,
  },
  {
    id: 'T-host-watchdog',
    state: 'TIMEOUT',
    reason: 'host-watchdog:1s',
    cause: 'NOT-DETERMINED',
    tier: 0,
    opts: { fakeDockerSleep: '4', env: { SKILLSMITH_NATIVE_CHECK_ATTRIBUTION_WATCHDOG_SECS: '1' } },
  },
  { id: 'U-rc2', state: 'UNEXPECTED', reason: 'checker-exit:2', cause: 'NOT-DETERMINED', tier: 0 },
  {
    id: 'U-rc127',
    state: 'UNEXPECTED',
    reason: 'checker-exit:127',
    cause: 'NOT-DETERMINED',
    tier: 0,
  },
  {
    id: 'U-rc137',
    state: 'UNEXPECTED',
    reason: 'checker-exit:137',
    cause: 'NOT-DETERMINED',
    tier: 0,
  },
  {
    id: 'U-docker125',
    state: 'UNEXPECTED',
    reason: 'exec-exit:125',
    cause: 'NOT-DETERMINED',
    tier: 0,
    opts: { fakeDockerRc: '125' },
  },
  {
    id: 'U-nonode',
    state: 'UNEXPECTED',
    reason: 'precondition:node-absent',
    cause: 'NOT-DETERMINED',
    tier: 0,
    opts: { cbin: 'CBIN_NONODE' },
  },
  {
    id: 'U-notimeout',
    state: 'UNEXPECTED',
    reason: 'precondition:timeout-absent',
    cause: 'NOT-DETERMINED',
    tier: 0,
    opts: { cbin: 'CBIN_NOTIMEOUT' },
  },
  {
    id: 'U-truncated',
    state: 'UNEXPECTED',
    reason: 'envelope-truncated',
    cause: 'NOT-DETERMINED',
    tier: 0,
    opts: { fakeDockerHead: '9' },
  },
  {
    id: 'A-unavailable',
    state: 'UNAVAILABLE',
    reason: 'checker-absent',
    cause: 'NOT-DETERMINED',
    tier: 0,
    opts: { appDir: 'APP_NOCHECKER' },
  },
  {
    id: 'M-garbage',
    state: 'MALFORMED',
    reason: 'report:invalid-json',
    cause: 'NOT-DETERMINED',
    tier: 0,
  },
  {
    id: 'M-nofield',
    state: 'MALFORMED',
    reason: 'report:bad:not_evaluated',
    cause: 'NOT-DETERMINED',
    tier: 0,
  },
  {
    id: 'M-schema3',
    state: 'MALFORMED',
    reason: 'report:bad:schema',
    cause: 'NOT-DETERMINED',
    tier: 0,
  },
  {
    id: 'M-live0',
    state: 'MALFORMED',
    reason: 'report:bad:live_probes',
    cause: 'NOT-DETERMINED',
    tier: 0,
  },
  {
    id: 'M-count',
    state: 'MALFORMED',
    reason: 'report:bad:missing',
    cause: 'NOT-DETERMINED',
    tier: 0,
  },
  {
    id: 'M-truncated',
    state: 'MALFORMED',
    reason: 'report:invalid-json',
    cause: 'NOT-DETERMINED',
    tier: 0,
  },
  { id: 'N-norep', state: 'NO-REPORT', reason: 'report-absent', cause: 'NOT-DETERMINED', tier: 0 },
  {
    id: 'N-disable-container',
    state: 'NO-REPORT',
    reason: 'checker-disabled',
    cause: 'NOT-DETERMINED',
    tier: 0,
    opts: { fakeContainerEnv: 'SKILLSMITH_MOUNT_COMPOSITION_DISABLE=1' },
  },
  {
    id: 'N-disable-host',
    state: 'NO-REPORT',
    reason: 'checker-disabled',
    cause: 'NOT-DETERMINED',
    tier: 0,
    opts: { env: { SKILLSMITH_MOUNT_COMPOSITION_DISABLE: '1' } },
  },
]

describe('check-native-modules.sh cause attribution (SMI-6684 Wave 3)', () => {
  let fx: Fixtures

  beforeAll(() => {
    fx = setupFixtures()
  })
  afterAll(() => {
    fx.cleanup()
  })

  function resolveOpts(opts?: RunOpts): RunOpts | undefined {
    if (!opts) return opts
    const resolved: RunOpts = { ...opts }
    if (opts.cbin === 'CBIN_NONODE') resolved.cbin = fx.cbinNoNode
    if (opts.cbin === 'CBIN_NOTIMEOUT') resolved.cbin = fx.cbinNoTimeout
    if (opts.appDir === 'APP_NOCHECKER') resolved.appDir = fx.appNoCheckerDir
    return resolved
  }

  describe.each(CASES)('C: $id', (c) => {
    it(`classifies (state, cause, reason, tier, evidence)`, () => {
      const r = runCase(fx, c.id, resolveOpts(c.opts))
      expect(r.status, `${c.id} exit status; stdout:\n${r.stdout}`).toBe(1)
      const parsed = parseAttribution(r.stdout)
      expect(parsed, `${c.id} did not match the §5.2 grep contract:\n${r.stdout}`).toBeDefined()
      expect(parsed!.state, c.id).toBe(c.state)
      expect(parsed!.cause, c.id).toBe(c.cause)
      expect(parsed!.tier, c.id).toBe(c.tier)
      expect(!!parsed!.mismatch, c.id).toBe(!!c.mismatch)
      if (c.evidence !== undefined) {
        expect(parsed!.evidence, c.id).toBe(c.evidence)
      }
      if (!GRID.has(c.state) && c.reason !== undefined && !c.mismatch) {
        expect(parsed!.detail, c.id).toBe(c.reason)
      }
    })
  })

  it('C-CONSEC: a stale report at a shared TMPDIR is never read by the next run', () => {
    const sharedTmp = mkdtempSync(join(tmpdir(), 'nca-shared-tmpdir-'))
    const r1 = runCase(fx, 'S-clean', { env: { TMPDIR: sharedTmp } })
    expect(parseAttribution(r1.stdout)?.state).toBe('CLEAN')
    const r2 = runCase(fx, 'N-norep', { env: { TMPDIR: sharedTmp } })
    expect(parseAttribution(r2.stdout)?.state).toBe('NO-REPORT')
    // the two runs' own --report dirs must differ (mktemp -d, not a fixed path)
    const dir1 = r1.checkerLog[0]?.match(/--report (\S+)\/report\.json/)?.[1]
    const dir2 = r2.checkerLog[0]?.match(/--report (\S+)\/report\.json/)?.[1]
    expect(dir1).toBeDefined()
    expect(dir2).toBeDefined()
    expect(dir1).not.toBe(dir2)
    // F-14 (SMI-6684 Wave 3 review): neither per-run dir survives either run
    // -- the original assertion was silently skipped whenever dir1 was
    // falsy, which never proved the two runs used distinct, cleaned-up dirs.
    expect(() => statSync(dir1!)).toThrow()
    expect(() => statSync(dir2!)).toThrow()
  })

  it('C-ARGV: the timeout shim sees the exact production invocation', () => {
    const r = runCase(fx, 'S-clean')
    expect(r.timeoutLog.length).toBeGreaterThan(0)
    const line = r.timeoutLog[0]!
    const src = readFileSync(SCRIPT, 'utf8')
    const timeoutSecs = /^NCA_TIMEOUT_SECS=(\d+)/m.exec(src)?.[1]
    expect(timeoutSecs).toBeDefined()
    expect(line).toMatch(
      new RegExp(
        `^${timeoutSecs} bash scripts/lib/check-mount-composition\\.sh --mode auto --live --report \\S+/report\\.json$`
      )
    )
  })

  it('C-CLEANUP: the per-run --report dir does not survive the run', () => {
    const r = runCase(fx, 'S-clean')
    const dir = r.checkerLog[0]?.match(/--report (\S+)\/report\.json/)?.[1]
    expect(dir).toBeDefined()
    expect(() => statSync(dir!)).toThrow()
  })

  it('I-SUCCESS: a passing probe exits 0 with empty output and exactly 1 exec', () => {
    const r = runCase(fx, 'S-clean', { fakeProbeRc: '0' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.execCount).toBe(1)
  })

  it('I-NODOCKER: no running container -> exit 0, 0 execs', () => {
    const r = runCase(fx, 'S-clean', { fakePs: '' })
    expect(r.status).toBe(0)
    expect(r.execCount).toBe(0)
  })

  it('I-SKIP: SKILLSMITH_SKIP_NATIVE_CHECK=1 wins even with a failing probe', () => {
    const r = runCase(fx, 'S-clean', { env: { SKILLSMITH_SKIP_NATIVE_CHECK: '1' } })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.execCount).toBe(0)
  })

  it('I-OFF: attribution disable renders OFF with exactly 1 exec (the probe)', () => {
    const r = runCase(fx, 'S-clean', { env: { SKILLSMITH_NATIVE_CHECK_ATTRIBUTION_DISABLE: '1' } })
    expect(r.status).toBe(1)
    const parsed = parseAttribution(r.stdout)
    expect(parsed?.state).toBe('OFF')
    expect(r.execCount).toBe(1)
  })

  it('I-DEVNULL: stdout to /dev/null skips attribution, exactly 1 exec', () => {
    const r = runCase(fx, 'S-clean', { devnull: true })
    expect(r.status).toBe(1)
    // r.stdout is NOT asserted here (F-14, SMI-6684 Wave 3 review): with
    // stdio[1]='ignore' it is unconditionally '' regardless of what the
    // script wrote, so that check proved nothing about the /dev/null guard.
    // execCount is the real assertion -- 1 means only the probe exec ran; a
    // second (attribution) exec would mean the guard failed to skip it.
    expect(r.execCount).toBe(1)
    expect(r.stderr).toBe('')
  })

  it('I-MKTEMP: host PATH without mktemp -> UNEXPECTED [host-mktemp], 1 exec', () => {
    // NOT hostBin: opts -- that would still fall back to the real PATH
    // (which has a real mktemp) appended after it. env.PATH is spread LAST
    // in runFromCaseDir()'s env object, so it replaces PATH outright with
    // ONLY the curated no-mktemp dir.
    const r = runCase(fx, 'S-clean', { env: { PATH: fx.hostBinNoMktemp } })
    expect(r.status).toBe(1)
    const parsed = parseAttribution(r.stdout)
    expect(parsed?.state).toBe('UNEXPECTED')
    expect(parsed?.cause).toBe('NOT-DETERMINED')
    expect(parsed?.detail).toBe('host-mktemp')
    expect(r.execCount).toBe(1)
  })

  it('I-SIGPIPE: a reader that closes stdout immediately still exits 1', () => {
    const r = runCase(fx, 'S-clean', { closeStdoutImmediately: true })
    expect(r.status).toBe(1)
  })

  it('I-WATCHDOG-KNOB: an invalid watchdog value is ignored, not an instant false TIMEOUT', () => {
    const r = runCase(fx, 'R-wt-floor', {
      env: { SKILLSMITH_NATIVE_CHECK_ATTRIBUTION_WATCHDOG_SECS: 'abc' },
    })
    const parsed = parseAttribution(r.stdout)
    expect(parsed?.state).not.toBe('TIMEOUT')
    expect(parsed?.state).toBe('FINDINGS')
  })

  it('T-PARSE: sh -n accepts the script', () => {
    const sh = resolveBin('sh')
    expect(sh).toBeDefined()
    const r = spawnSync(sh!, ['-n', SCRIPT], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
  })

  it('T-PIN: the checker source literals the classifier keys on still exist', () => {
    const checkerSh = readFileSync(
      join(__dirname, '..', 'lib', 'check-mount-composition.sh'),
      'utf8'
    )
    const probesSh = readFileSync(
      join(__dirname, '..', 'lib', 'check-mount-composition.probes.sh'),
      'utf8'
    )
    const fragments = [
      'is mounted but SUBSTITUTED: ',
      'declared but NOT mounted: ',
      ' in-scope destination(s) checked; ',
    ]
    for (const f of fragments) {
      expect(checkerSh.includes(f), `missing in check-mount-composition.sh: ${f}`).toBe(true)
    }
    // F-9 (SMI-6684 Wave 3 review): pin the two A4 cause strings
    // nca_scan_line's FALL/SEED branches match on verbatim, and the
    // "-- $cause" join nca_scan_line's own subject-extraction has to reach
    // through -- without these, a checker rewording of either turns the
    // classifier silently wrong instead of failing this test.
    const probeFragments = [
      'expected ELF (declared',
      'STALE SEED at',
      'destination is NOT mounted -- READ-ONLY-PARENT FALL-THROUGH: ',
      'destination IS mounted, so the SEEDED VOLUME CONTENT itself is wrong (not a fall-through)',
      'expected ELF (declared $dst, volume=$src, version=$ver) -- $cause',
    ]
    for (const f of probeFragments) {
      expect(probesSh.includes(f), `missing in check-mount-composition.probes.sh: ${f}`).toBe(true)
    }
    expect(checkerSh.includes('FAIL [%s] %s'), 'fail() format string').toBe(true)
  })

  it('T-OLDFAIL: a reworded A4 fall-through string is never read as NO-NATIVE-FINDING', () => {
    // spec §4.4 "safe degradation": reword READ-ONLY-PARENT FALL-THROUGH ->
    // PARENT FALLTHROUGH on the S-root fixture (no MISS evidence to fall
    // back on) -- the reworded line must stop matching nca_scan_line's
    // exact-substring FALL pattern and degrade to OTHER-NATIVE-FINDING /
    // NOT-DETERMINED, never silently read as "nothing wrong". Staged via
    // stageCase()+runFromCaseDir() into an OS temp dir, never writing
    // inside the committed fixtures/ tree.
    const staged = stageCase(fx.root, 'S-root')
    const stdoutFile = join(staged, 'stdout')
    const reworded = readFileSync(stdoutFile, 'utf8').replace(
      'READ-ONLY-PARENT FALL-THROUGH',
      'PARENT FALLTHROUGH'
    )
    writeFileSync(stdoutFile, reworded)
    const r = runFromCaseDir(fx, staged)
    const parsed = parseAttribution(r.stdout)
    // F-14 (SMI-6684 Wave 3 review): `parsed?.cause` reads `undefined` when
    // parsed is undefined, and `undefined !== 'NO-NATIVE-FINDING'` passes
    // vacuously -- assert parsed exists, then pin the exact degraded cause
    // spec §4.4's safe-degradation table gives for S-root (no MISS
    // evidence): OTHER-NATIVE-FINDING, not just "not NO-NATIVE-FINDING".
    expect(parsed, `stdout:\n${r.stdout}`).toBeDefined()
    expect(parsed?.cause).toBe('OTHER-NATIVE-FINDING')
  })

  it('T-LEAK: 5 repeated truncated-envelope runs leave no leaked --report dir', () => {
    for (let i = 0; i < 5; i++) {
      const r = runCase(fx, 'U-truncated', { fakeDockerHead: '9' })
      const dir = r.checkerLog[0]?.match(/--report (\S+)\/report\.json/)?.[1]
      // F-14 (SMI-6684 Wave 3 review): `if (dir)` silently skipped the whole
      // assertion whenever the regex failed to match -- the checker fake
      // writes its own log line unconditionally, so dir must always be
      // defined; a missing match is itself a failure, not a pass.
      expect(dir, `iteration ${i}: no --report dir logged`).toBeDefined()
      expect(() => statSync(dir!), `leak on iteration ${i}`).toThrow()
    }
  })
})
