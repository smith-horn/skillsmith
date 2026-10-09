/**
 * SMI-6967 PR-gate (H-A): no test exercised the payload-to-producer
 * derivation at all before this -- every existing liveness-fold test
 * (`ruflo-bridge-state.test.ts`) injects the already-computed
 * `producerPresentThisProbe` boolean directly, so a mutant at the actual
 * derivation site (`isProducerPresent` in `ruflo-bridge-probe.mjs`) stayed
 * green through three review rounds. These tests drive `isProducerPresent`
 * itself from real `memory_bridge_status` payload shapes, asserting the
 * PROPERTY (a valid non-negative INTEGER count arms; anything else does
 * not) rather than re-asserting a value the production code already
 * computed.
 *
 * The mutation this must catch (H-A): reverting the shared
 * `isValidCount(total) && total > 0` check back to the prior inline
 * `Number.isFinite(total) && total > 0` wrongly re-admits a fractional
 * `totalEntries` such as `0.5` -- finite and positive, but not a count any
 * real probe would ever produce. Because `foldLiveness` LATCHES
 * `everProducerPresent` permanently on a single `true` reading, one invalid
 * fractional payload would otherwise arm the gate forever.
 *
 * Importing `ruflo-bridge-probe.mjs` here is safe only because that file now
 * carries an `isMainModule` entry-point guard (same SMI, same PR) -- without
 * it, importing the module for its export would also run `main()` as a side
 * effect (spawn the launcher, take the bridge lock, write state). See that
 * file's own comment at the bottom for why the guard was added.
 */
import { spawnSync } from 'node:child_process'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'
import {
  BRIDGE_PROBE_DISABLE_VAR,
  PROBE_COMMAND,
} from '../../packages/doc-retrieval-mcp/src/retrieval-log/ruflo-bridge-state.js'
import { extractLearningCounters, isProducerPresent } from '../ruflo-bridge-probe.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('isProducerPresent — agentdb.totalEntries arm (SMI-6967 H-A: shared isValidCount, not a second Number.isFinite copy)', () => {
  it('arms on an integer totalEntries > 0', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: 1 } })).toBe(true)
  })

  it('does NOT arm on a fractional totalEntries — the H-A mutant case: 0.5 passes Number.isFinite but is not a count', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: 0.5 } })).toBe(false)
  })

  it('does NOT arm on totalEntries === 0 (valid count, but not > 0)', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: 0 } })).toBe(false)
  })

  it('does NOT arm on a negative totalEntries', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: -1 } })).toBe(false)
  })

  it('does NOT arm on a string totalEntries', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: '5' } })).toBe(false)
  })

  it('does NOT arm on Infinity', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: Infinity } })).toBe(false)
  })

  it('does NOT arm on NaN', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: NaN } })).toBe(false)
  })

  it('does NOT arm on a boolean totalEntries', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: true } })).toBe(false)
  })

  it('does NOT arm on an array totalEntries', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: [1] } })).toBe(false)
  })

  it('does NOT arm on an object totalEntries', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: {} } })).toBe(false)
  })

  it('does NOT arm when totalEntries is absent', () => {
    expect(isProducerPresent({ agentdb: {} })).toBe(false)
    expect(isProducerPresent({})).toBe(false)
  })

  it('does NOT arm when totalEntries is explicitly null', () => {
    expect(isProducerPresent({ agentdb: { totalEntries: null } })).toBe(false)
  })
})

describe("isProducerPresent — bridge.status === 'connected' arm (independent of the totalEntries arm)", () => {
  it("arms on bridge.status === 'connected' alone, with no agentdb block at all", () => {
    expect(isProducerPresent({ bridge: { status: 'connected' } })).toBe(true)
  })

  it('arms on a connected bridge even when totalEntries is invalid — the two arms never gate each other', () => {
    expect(
      isProducerPresent({ bridge: { status: 'connected' }, agentdb: { totalEntries: 0.5 } })
    ).toBe(true)
  })

  it("does NOT arm on a non-'connected' bridge.status", () => {
    expect(isProducerPresent({ bridge: { status: 'not-synced' } })).toBe(false)
  })

  it('does NOT arm when bridge.status is absent', () => {
    expect(isProducerPresent({ bridge: {} })).toBe(false)
  })

  it('does NOT arm when bridge is absent entirely', () => {
    expect(isProducerPresent({})).toBe(false)
  })

  it('does NOT arm when bridge is null', () => {
    expect(isProducerPresent({ bridge: null })).toBe(false)
  })
})

describe('isProducerPresent — malformed top-level payload', () => {
  it('does NOT arm, and does not throw, on a null payload', () => {
    expect(isProducerPresent(null)).toBe(false)
  })

  it('does NOT arm, and does not throw, on an undefined payload', () => {
    expect(isProducerPresent(undefined)).toBe(false)
  })
})

// SMI-6985 Medium: before this seam was split out, nothing drove this exact
// extraction from any test (confirmed: `grep -n intelligence scripts/tests/
// *.ts packages/doc-retrieval-mcp/src/retrieval-log/*.test.ts` returned a
// single hit, a type declaration) — the gap that let a reachable, healthy
// payload whose `intelligence` block silently vanished go permanently
// unreportable (ruflo-bridge-state.liveness.ts's own SMI-6985 doc comment
// has the full mechanism).
describe('extractLearningCounters (SMI-6985 Medium)', () => {
  it('reads both counters when the intelligence block is present', () => {
    expect(
      extractLearningCounters({ intelligence: { patternsLearned: 3, trajectoriesRecorded: 5 } })
    ).toEqual({ patternsLearned: 3, trajectoriesRecorded: 5 })
  })

  it('returns {null, null} when the intelligence block is entirely absent — the exact reported shape', () => {
    expect(extractLearningCounters({ agentdb: {}, bridge: { status: 'connected' } })).toEqual({
      patternsLearned: null,
      trajectoriesRecorded: null,
    })
  })

  it('returns {null, null} on an empty payload, without throwing', () => {
    expect(extractLearningCounters({})).toEqual({
      patternsLearned: null,
      trajectoriesRecorded: null,
    })
  })

  it('does not throw, and returns {null, null}, on a null payload', () => {
    expect(extractLearningCounters(null)).toEqual({
      patternsLearned: null,
      trajectoriesRecorded: null,
    })
  })

  it('reads a partial intelligence block (one counter present, the other absent) independently per axis', () => {
    expect(extractLearningCounters({ intelligence: { patternsLearned: 4 } })).toEqual({
      patternsLearned: 4,
      trajectoriesRecorded: null,
    })
  })
})

describe('SMI-7032: PROBE_COMMAND names a command that can actually load the probe', () => {
  // This lives HERE, not beside the constant in
  // packages/doc-retrieval-mcp/src/retrieval-log/ruflo-bridge-state.test.ts,
  // and the placement is the point. That file is reached by
  // `Test (<package>)`, gated on `affected_count != '0'`. Measured with the
  // repo's own classifier (scripts/ci/detect-affected.ts), with controls:
  //
  //   scripts/ruflo-bridge-probe.mjs        -> affected_count=0   job SKIPS
  //   ...retrieval-log/*.render.ts          -> affected_count=1   job runs
  //   README.md                             -> affected_count=0
  //
  // So a PR editing only the probe's own imports — the change most likely to
  // break this again — would skip that job entirely. `Test (root)` runs this
  // file unconditionally on any `code`-tier diff.
  //
  // What it asserts: the command every [ruflo-bridge] banner tells its reader
  // to run, tokenized and executed as written, actually runs the probe. Two
  // tests previously asserted only that the banner CONTAINED the command
  // string, which is why a command that exited 1 with ERR_MODULE_NOT_FOUND for
  // everyone, every time, lived its whole life green.
  //
  // Sandbox: HOME, TMPDIR, XDG_*_HOME and SKILLSMITH_STATE_DIR_OVERRIDE all
  // point inside ONE temp root, and the seeded state makes main() take its
  // debounce path. Asserted, not assumed, for what is measured:
  //   - launcher boundary: the probe's test-only seam
  //     (SKILLSMITH_RUFLO_PROBE_LAUNCHER_LOG_TEST) records every launcher spawn;
  //     a debounced run must record none.
  //   - docker contact: a `docker` shim first on PATH records PATH-resolved
  //     calls (an absolute-path docker call would NOT be seen by it).
  //   - filesystem: every pre-existing file under the sandbox root keeps its
  //     sha256, mode and size; the only additions are the log dir + file.
  // Not measured: writes outside the sandbox root, or network calls.
  const tokens = PROBE_COMMAND.trim().split(/\s+/)

  // One budget, measured: each test spawns once. A cold `npx --no-install tsx`
  // run of the debounce path took 252-294ms in the dev container (5 runs), so
  // 5s is ~17x the slowest. vitest's own testTimeout is 15s (vitest.preset.ts),
  // and spawn + slack stays well under it.
  const SPAWN_BUDGET_MS = 5_000
  const TEST_BUDGET_MS = SPAWN_BUDGET_MS + 2_000

  // path -> signature for every file and directory under root. Files: mode,
  // size and sha256 of the bytes (mtime deliberately excluded: a same-size
  // rewrite with a restored mtime must still be caught). Directories: mode only
  // (their mtime legitimately moves when an entry is added).
  const snapshot = (root: string): Map<string, string> => {
    const out = new Map<string, string>()
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        const st = statSync(full)
        const mode = (st.mode & 0o7777).toString(8)
        const sig = st.isDirectory()
          ? `dir:${mode}`
          : `file:${mode}:${st.size}:${createHash('sha256').update(readFileSync(full)).digest('hex')}`
        out.set(full.slice(root.length), sig)
        if (st.isDirectory()) walk(full)
      }
    }
    walk(root)
    return out
  }

  // Executes argv EXACTLY as given (no `-e`, no substituted entry point)
  // against a debounced fixture, so the probe's own main() runs end to end
  // without contacting any server. The fixture pre-seeds a fresh entry for an
  // invocation-unique key whose evaluatedAt is also invocation-unique; main()
  // then logs `debounced — prior entry at <evaluatedAt>`. Only the probe's own
  // code reading the seeded state can produce that line, so a command that
  // merely prints something (e.g. `echo RESOLVED ...`) cannot forge it.
  const runAdvertised = (argv: string[]) => {
    const sandbox = makeFixtureTempDir('smi-7032-probe')
    const stateDir = join(sandbox, 'state')
    for (const d of ['state', 'home', 'tmp', 'xdg']) mkdirSync(join(sandbox, d))
    // Pre-existing decoys so the hash comparison has bytes to protect.
    writeFileSync(join(stateDir, 'decoy.txt'), 'smi-7032 decoy AAAA')
    writeFileSync(join(sandbox, 'home', 'decoy.txt'), 'smi-7032 home decoy')
    const key = `smi-7032-key-${randomUUID()}`
    // Unique per invocation, still well inside the 24h debounce window.
    const evaluatedAt = new Date(Date.now() - (60_000 + randomInt(1, 3_600_000))).toISOString()
    const statePath = join(stateDir, 'ruflo-bridge.state')
    writeFileSync(
      statePath,
      JSON.stringify({ [key]: { verdict: 'ok', evaluatedAt, reason: 'smi-7032 fixture' } })
    )
    const stateBefore = readFileSync(statePath)
    // `docker` shim, outside stateDir so its record never enters the snapshot.
    const shimDir = makeFixtureTempDir('smi-7032-shim')
    const dockerLog = join(shimDir, 'docker-invocations.log')
    const launcherLog = join(shimDir, 'launcher-invocations.log')
    mkdirSync(join(shimDir, 'bin'))
    const shim = join(shimDir, 'bin', 'docker')
    writeFileSync(shim, `#!/bin/sh\necho "$@" >> "${dockerLog}"\nexit 1\n`)
    chmodSync(shim, 0o755)
    const before = snapshot(sandbox)
    const result = spawnSync(argv[0], [...argv.slice(1), '--key', key], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: SPAWN_BUDGET_MS,
      env: makeFixtureEnv({
        HOME: join(sandbox, 'home'),
        TMPDIR: join(sandbox, 'tmp'),
        XDG_CONFIG_HOME: join(sandbox, 'xdg'),
        XDG_CACHE_HOME: join(sandbox, 'xdg'),
        XDG_DATA_HOME: join(sandbox, 'xdg'),
        XDG_STATE_HOME: join(sandbox, 'xdg'),
        SKILLSMITH_RUFLO_PROBE_LAUNCHER_LOG_TEST: launcherLog,
        VITEST: 'true',
        PATH: `${join(shimDir, 'bin')}:${process.env.PATH ?? ''}`,
        // Pin npx's own cache OUTSIDE the snapshot root. Otherwise it lands in
        // $HOME/.npm whenever the runner did not export npm_config_cache: true
        // under pre-push (vitest run directly), not under `npx vitest`. That
        // made this test pass or fail depending on how it was invoked.
        npm_config_cache: join(shimDir, 'npm-cache'),
        SKILLSMITH_STATE_DIR_OVERRIDE: stateDir,
        [BRIDGE_PROBE_DISABLE_VAR]: '',
      }),
    })
    const logDir = join(stateDir, 'logs')
    const logText = existsSync(logDir)
      ? readdirSync(logDir)
          .map((f) => readFileSync(join(logDir, f), 'utf8'))
          .join('\n')
      : ''
    const after = snapshot(sandbox)
    const launcherCalls = existsSync(launcherLog) ? readFileSync(launcherLog, 'utf8') : ''
    const dockerCalls = existsSync(dockerLog) ? readFileSync(dockerLog, 'utf8') : ''
    const stateUnchanged = readFileSync(statePath).equals(stateBefore)
    return {
      result,
      logText,
      evaluatedAt,
      stateDir,
      sandbox,
      shimDir,
      before,
      after,
      launcherCalls,
      dockerCalls,
      stateUnchanged,
    }
  }

  it(
    'executing PROBE_COMMAND as written runs the probe script itself',
    () => {
      expect(tokens.length).toBeGreaterThan(1)
      const scriptRel = tokens[tokens.length - 1]
      // isFile, not merely exists: join(REPO_ROOT, '') is the root itself.
      expect(statSync(join(REPO_ROOT, scriptRel)).isFile()).toBe(true)

      const run = runAdvertised(tokens)
      const { result, logText, evaluatedAt, sandbox, shimDir } = run
      try {
        expect(result.error).toBeUndefined()
        expect(result.signal).toBeNull()
        expect(result.status).toBe(0)
        expect(logText).toContain(`debounced — prior entry at ${evaluatedAt}`)
        // Debounce must PREVENT the work, not merely be reached: no launcher
        // spawn (observed at the launcher boundary itself), no PATH-resolved
        // docker call, and no state write.
        expect(run.launcherCalls).toBe('')
        expect(run.dockerCalls).toBe('')
        expect(run.stateUnchanged).toBe(true)
        // Every pre-existing path under the sandbox root keeps its bytes
        // (sha256), mode and size; the only additions are the log dir + file,
        // plus the TOOLCHAIN's own caches under TMPDIR (tsx's per-uid dir and
        // node's compile cache, written because TMPDIR points into the sandbox;
        // measured: the only other additions in a real run).
        for (const [path, sig] of run.before) expect(run.after.get(path)).toBe(sig)
        const toolchainCache = /^\/tmp\/(tsx-\d+|node-compile-cache)(\/|$)/
        const added = [...run.after.keys()]
          .filter((p) => !run.before.has(p) && !toolchainCache.test(p))
          .sort()
        expect(added).toHaveLength(2)
        expect(added[0]).toBe('/state/logs')
        expect(added[1]).toMatch(/^\/state\/logs\/ruflo-bridge-probe-\d{4}-\d{2}-\d{2}\.log$/)
      } finally {
        rmSync(sandbox, { recursive: true, force: true })
        rmSync(shimDir, { recursive: true, force: true })
      }
    },
    TEST_BUDGET_MS
  )

  it('the launcher-record seam is test-only: absent from the advertised command and read in exactly one place', () => {
    const SEAM = 'SKILLSMITH_RUFLO_PROBE_LAUNCHER_LOG_TEST'
    expect(PROBE_COMMAND).not.toContain(SEAM)
    const probeSrc = readFileSync(join(REPO_ROOT, tokens[tokens.length - 1]), 'utf8')
    // One definition of the name, one env read: the seam is a no-op when unset.
    expect(probeSrc.split(SEAM).length - 1).toBe(1)
    expect(probeSrc.split('process.env[LAUNCHER_INVOKE_LOG_TEST_VAR]').length - 1).toBe(1)
    // No git hook launches the probe with the seam set.
    const huskyDir = join(REPO_ROOT, '.husky')
    for (const name of readdirSync(huskyDir)) {
      const full = join(huskyDir, name)
      if (statSync(full).isFile()) expect(readFileSync(full, 'utf8')).not.toContain(SEAM)
    }
  })

  it(
    'bare node on the same script does NOT run the probe (known-negative control)',
    () => {
      const scriptRel = tokens[tokens.length - 1]
      const run = runAdvertised(['node', scriptRel])
      const { result, stateDir, sandbox, shimDir } = run
      try {
        expect(result.error).toBeUndefined()
        expect(result.status).not.toBe(0)
        expect(result.stderr ?? '').toContain('ERR_MODULE_NOT_FOUND')
        // The import fails before main() exists: no log at all (not merely
        // "no line with this timestamp"), and nothing in the state dir moved.
        expect(run.logText).toBe('')
        expect(existsSync(join(stateDir, 'logs'))).toBe(false)
        expect(run.after).toEqual(run.before)
        expect(run.stateUnchanged).toBe(true)
      } finally {
        rmSync(sandbox, { recursive: true, force: true })
        rmSync(shimDir, { recursive: true, force: true })
      }
    },
    TEST_BUDGET_MS
  )

  // INVARIANT (final review): the launcher-record seam can never change whether
  // the real launcher runs, whatever the variable holds. These runs take the
  // NON-debounce path (no seeded state), so the probe really spawns the
  // launcher, whose first docker call is `docker ps ...` -> recorded by the shim.
  const runLaunching = (opts: { seam?: string; dropVitest?: boolean; vitest?: string }) => {
    const sandbox = makeFixtureTempDir('smi-7032-launch')
    const shimDir = makeFixtureTempDir('smi-7032-launch-shim')
    for (const d of ['state', 'home', 'tmp', 'xdg']) mkdirSync(join(sandbox, d))
    const dockerLog = join(shimDir, 'docker-invocations.log')
    mkdirSync(join(shimDir, 'bin'))
    const shim = join(shimDir, 'bin', 'docker')
    writeFileSync(shim, `#!/bin/sh\necho "$@" >> "${dockerLog}"\nexit 1\n`)
    chmodSync(shim, 0o755)
    const env = makeFixtureEnv({
      HOME: join(sandbox, 'home'),
      TMPDIR: join(sandbox, 'tmp'),
      XDG_CONFIG_HOME: join(sandbox, 'xdg'),
      XDG_CACHE_HOME: join(sandbox, 'xdg'),
      XDG_DATA_HOME: join(sandbox, 'xdg'),
      XDG_STATE_HOME: join(sandbox, 'xdg'),
      PATH: `${join(shimDir, 'bin')}:${process.env.PATH ?? ''}`,
      npm_config_cache: join(shimDir, 'npm-cache'),
      SKILLSMITH_STATE_DIR_OVERRIDE: join(sandbox, 'state'),
      [BRIDGE_PROBE_DISABLE_VAR]: '',
      VITEST: opts.vitest ?? 'true',
      ...(opts.seam === undefined ? {} : { SKILLSMITH_RUFLO_PROBE_LAUNCHER_LOG_TEST: opts.seam }),
    })
    if (opts.dropVitest) delete env.VITEST
    const result = spawnSync(
      tokens[0],
      [...tokens.slice(1), '--key', `smi-7032-launch-${randomUUID()}`],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: SPAWN_BUDGET_MS, env }
    )
    const dockerCalls = existsSync(dockerLog) ? readFileSync(dockerLog, 'utf8') : ''
    return { result, dockerCalls, sandbox, shimDir }
  }
  const cleanup = (r: { sandbox: string; shimDir: string }) => {
    rmSync(r.sandbox, { recursive: true, force: true })
    rmSync(r.shimDir, { recursive: true, force: true })
  }

  it(
    'a seam pointing at an unwritable path never stops the launcher from running, and stderr names the variable',
    () => {
      const run = runLaunching({ seam: '/nonexistent-smi-7032-dir/sub/launcher.log' })
      try {
        expect(run.result.error).toBeUndefined()
        expect(run.result.signal).toBeNull()
        // The real launcher ran: its first docker call is `ps ...`.
        expect(run.dockerCalls).toMatch(/^ps /m)
        expect(run.result.stderr).toContain('SKILLSMITH_RUFLO_PROBE_LAUNCHER_LOG_TEST')
        expect(run.result.stderr).toContain('launching anyway')
      } finally {
        cleanup(run)
      }
    },
    TEST_BUDGET_MS
  )

  it(
    'outside vitest the seam is ignored: no seam file is written, the launcher still runs, stderr names the variable',
    () => {
      const probeLog = join(makeFixtureTempDir('smi-7032-seam'), 'seam.log')
      const run = runLaunching({ seam: probeLog, dropVitest: true })
      try {
        expect(run.result.error).toBeUndefined()
        expect(run.dockerCalls).toMatch(/^ps /m)
        expect(existsSync(probeLog)).toBe(false)
        expect(run.result.stderr).toContain('SKILLSMITH_RUFLO_PROBE_LAUNCHER_LOG_TEST')
        expect(run.result.stderr).toContain('ignored')
      } finally {
        cleanup(run)
        rmSync(dirname(probeLog), { recursive: true, force: true })
      }
    },
    TEST_BUDGET_MS
  )

  it(
    'with VITEST=true and a valid seam path the launcher invocation is recorded exactly once (positive pair for the debounce zero-call assertion)',
    () => {
      const seamDir = makeFixtureTempDir('smi-7032-seam-pos')
      const seamLog = join(seamDir, 'seam.log')
      const run = runLaunching({ seam: seamLog, vitest: 'true' })
      try {
        expect(run.result.error).toBeUndefined()
        expect(run.dockerCalls).toMatch(/^ps /m)
        const recorded = existsSync(seamLog) ? readFileSync(seamLog, 'utf8') : ''
        expect(recorded.split('launcher invoked: ').length - 1).toBe(1)
      } finally {
        cleanup(run)
        rmSync(seamDir, { recursive: true, force: true })
      }
    },
    TEST_BUDGET_MS
  )

  it(
    'VITEST=false does not count as under vitest: the seam is ignored and the launcher still runs',
    () => {
      const seamDir = makeFixtureTempDir('smi-7032-seam-false')
      const seamLog = join(seamDir, 'seam.log')
      const run = runLaunching({ seam: seamLog, vitest: 'false' })
      try {
        expect(run.result.error).toBeUndefined()
        expect(run.dockerCalls).toMatch(/^ps /m)
        expect(existsSync(seamLog)).toBe(false)
        expect(run.result.stderr).toContain('ignored')
      } finally {
        cleanup(run)
        rmSync(seamDir, { recursive: true, force: true })
      }
    },
    TEST_BUDGET_MS
  )

  it(
    'with the seam absent the launcher runs and no seam file or seam note appears anywhere',
    () => {
      const run = runLaunching({})
      try {
        expect(run.result.error).toBeUndefined()
        expect(run.dockerCalls).toMatch(/^ps /m)
        expect(run.result.stderr).not.toContain('SKILLSMITH_RUFLO_PROBE_LAUNCHER_LOG_TEST')
        const stray = [...snapshot(run.sandbox).keys(), ...snapshot(run.shimDir).keys()].filter(
          (p) => /launcher.*\.log$/.test(p)
        )
        expect(stray).toEqual([])
      } finally {
        cleanup(run)
      }
    },
    TEST_BUDGET_MS
  )
})
