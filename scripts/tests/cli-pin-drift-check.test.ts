/**
 * SMI-5746 — integration tests for scripts/cli-pin-drift-check.sh.
 *
 * Drives the bash script via spawnSync with:
 *   SKILLSMITH_CLI_PIN_DRIFT_TEST=1      — enables all test seams (production
 *                                          can't be hijacked by a stray env var)
 *   SKILLSMITH_CLI_PIN_DRIFT_HOME        — unique per-test tmp dir (isolates state/logs)
 *   SKILLSMITH_CLI_PIN_DRIFT_REPO_ROOT   — fixture repo dir (.mcp.json + package.json(s))
 *   SKILLSMITH_CLI_PIN_DRIFT_NPM_CMD     — fake npm script, no live registry calls
 *   SKILLSMITH_CLI_PIN_DRIFT_GH_CMD      — capture gh invocations without calling GitHub
 *   SKILLSMITH_CLI_PIN_DRIFT_SHADOW      — 1 (default-safe) or 0 to test the paging path
 *   SKILLSMITH_CLI_PIN_DRIFT_GRACE_DAYS  — override the 30-day default for faster fixtures
 *
 * Never skipIf(inDocker) — seams let this run inside the CI container where
 * vitest normally runs.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, '..', 'cli-pin-drift-check.sh')

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true })
  }
})

function makeTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `${prefix}-`))
  tmpDirs.push(d)
  return d
}

/**
 * Fixture repo: scripts/mcp-ruflo-launcher.sh (RUFLO_CLI_PIN=<semver>,
 * SMI-6744 ADR-170 § 7 — the pin's new home, retired from .mcp.json's npx
 * entry) + root package.json + packages/website/package.json.
 *
 * `rufloPin: null` omits the RUFLO_CLI_PIN line entirely (the "absent pin"
 * fixture); omitting `rufloPin` from opts keeps the '3.14.2' default every
 * pre-existing call site here relies on.
 */
function makeFixtureRepo(opts: {
  rufloPin?: string | null
  supabasePin?: string
  wranglerPin?: string
}): string {
  const dir = makeTmp('cli-pin-drift-repo')
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  const pinLine = opts.rufloPin === null ? '' : `RUFLO_CLI_PIN=${opts.rufloPin ?? '3.14.2'}\n`
  writeFileSync(
    join(dir, 'scripts', 'mcp-ruflo-launcher.sh'),
    `#!/usr/bin/env bash\nset -euo pipefail\n${pinLine}echo hi\n`
  )
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ devDependencies: { supabase: opts.supabasePin ?? '2.107.0' } })
  )
  mkdirSync(join(dir, 'packages', 'website'), { recursive: true })
  writeFileSync(
    join(dir, 'packages', 'website', 'package.json'),
    JSON.stringify({ devDependencies: { wrangler: opts.wranglerPin ?? '4.112.0' } })
  )
  return dir
}

/**
 * Fake npm: `view <pkg> version` → latest; `view <pkg> versions --json` →
 * the full version list. Every watched tool gets the same fake responses
 * (tests target one tool's drift at a time via its pin).
 */
function makeFakeNpm(
  versionsByTool: Record<string, { latest: string; versions: string[] }>
): string {
  const home = makeTmp('cli-pin-drift-npm')
  const scriptPath = join(home, 'fake-npm.sh')
  const cases = Object.entries(versionsByTool)
    .map(
      ([tool, { latest, versions }]) =>
        `  ${tool})\n` +
        `    if [ "$3" = "version" ]; then printf '%s\\n' "${latest}"; ` +
        `elif [ "$3" = "versions" ]; then printf '%s\\n' '${JSON.stringify(versions)}'; fi ;;`
    )
    .join('\n')
  const script = ['#!/bin/bash', 'case "$2" in', cases, '  *) ;;', 'esac'].join('\n')
  writeFileSync(scriptPath, script, { mode: 0o755 })
  return scriptPath
}

function makeFakeGh(opts: { existingIssueNum?: number } = {}): {
  scriptPath: string
  captureFile: string
} {
  const home = makeTmp('cli-pin-drift-gh')
  const captureFile = join(home, 'gh-calls.log')
  const listBranch =
    opts.existingIssueNum != null
      ? `  list) printf '%d\\n' "${opts.existingIssueNum}" ;;`
      : '  list) ;;'
  const script = [
    '#!/bin/bash',
    `printf '%s\\n' "cmd:$*" >> "${captureFile}"`,
    'case "$2" in',
    listBranch,
    `  create) printf 'https://github.com/o/r/issues/99\\n' ;;`,
    '  comment) ;;',
    'esac',
  ].join('\n')
  const scriptPath = join(home, 'fake-gh.sh')
  writeFileSync(scriptPath, script, { mode: 0o755 })
  return { scriptPath, captureFile }
}

function isoAgo(days: number): string {
  return new Date(Date.now() - days * 864e5).toISOString()
}

interface RunResult {
  status: number
  log: string
  state: Record<string, unknown>
}

function run(env: Record<string, string>): RunResult {
  const home = makeTmp('cli-pin-drift-home')
  const result = spawnSync('bash', [SCRIPT], {
    env: {
      ...process.env,
      SKILLSMITH_CLI_PIN_DRIFT_TEST: '1',
      SKILLSMITH_CLI_PIN_DRIFT_HOME: home,
      ...env,
    },
    encoding: 'utf8',
  })
  let log = ''
  let state: Record<string, unknown> = {}
  try {
    const logDir = join(home, '.skillsmith', 'logs')
    const files = readdirSync(logDir)
    log = files.map((f: string) => readFileSync(join(logDir, f), 'utf8')).join('\n')
  } catch {
    /* no log written */
  }
  try {
    state = JSON.parse(readFileSync(join(home, '.skillsmith', 'cli-pin-drift.state'), 'utf8'))
  } catch {
    /* no state written */
  }
  return { status: result.status ?? -1, log, state }
}

describe('cli-pin-drift-check.sh (SMI-5746)', () => {
  it('exits 0 and does nothing when disabled', () => {
    const repo = makeFixtureRepo({})
    const npm = makeFakeNpm({ ruflo: { latest: '3.14.2', versions: ['3.14.2'] } })
    const { scriptPath: gh } = makeFakeGh()

    const { status, state } = run({
      SKILLSMITH_CLI_PIN_DRIFT_DISABLE: '1',
      SKILLSMITH_CLI_PIN_DRIFT_REPO_ROOT: repo,
      SKILLSMITH_CLI_PIN_DRIFT_NPM_CMD: npm,
      SKILLSMITH_CLI_PIN_DRIFT_GH_CMD: gh,
    })

    expect(status).toBe(0)
    expect(state).toEqual({})
  })

  // SMI-6744 ADR-170 § 7: unlike every other soft-fail path in this script,
  // a missing or non-semver RUFLO_CLI_PIN is a hard exit 1 — see the
  // header's "Exit code" note and the block right above check_tool's calls.
  it('exits 1 when RUFLO_CLI_PIN is absent from the launcher', () => {
    const repo = makeFixtureRepo({ rufloPin: null })
    const npm = makeFakeNpm({})
    const { scriptPath: gh } = makeFakeGh()

    const { status, log } = run({
      SKILLSMITH_CLI_PIN_DRIFT_REPO_ROOT: repo,
      SKILLSMITH_CLI_PIN_DRIFT_NPM_CMD: npm,
      SKILLSMITH_CLI_PIN_DRIFT_GH_CMD: gh,
    })

    expect(status).toBe(1)
    expect(log).toContain('RUFLO_CLI_PIN not found or not valid semver')
    expect(log).toContain('mcp-ruflo-launcher.sh')
    expect(log).not.toContain('no pin found, skipping')
  })

  it('exits 1 when RUFLO_CLI_PIN is not a valid semver', () => {
    const repo = makeFixtureRepo({ rufloPin: 'latest' })
    const npm = makeFakeNpm({})
    const { scriptPath: gh } = makeFakeGh()

    const { status, log } = run({
      SKILLSMITH_CLI_PIN_DRIFT_REPO_ROOT: repo,
      SKILLSMITH_CLI_PIN_DRIFT_NPM_CMD: npm,
      SKILLSMITH_CLI_PIN_DRIFT_GH_CMD: gh,
    })

    expect(status).toBe(1)
    expect(log).toContain('RUFLO_CLI_PIN not found or not valid semver')
  })

  // SMI-6744 M-11 (governance review, 2026-09-23): the old code `exit 1`ed
  // immediately on a missing/invalid ruflo pin, before SUPABASE_PIN/
  // WRANGLER_PIN were even read -- silently disabling both of those checks.
  // Fixed: RUFLO_PIN_MISSING is set instead, every other check still runs,
  // and the overall exit code stays 1 only at the very end.
  it('M-11: supabase/wrangler checks still run when the ruflo pin is missing', () => {
    const repo = makeFixtureRepo({ rufloPin: null })
    const npm = makeFakeNpm({
      supabase: { latest: '2.107.0', versions: ['2.107.0'] },
      wrangler: { latest: '4.112.0', versions: ['4.112.0'] },
    })
    const { scriptPath: gh } = makeFakeGh()

    const { status, log, state } = run({
      SKILLSMITH_CLI_PIN_DRIFT_REPO_ROOT: repo,
      SKILLSMITH_CLI_PIN_DRIFT_NPM_CMD: npm,
      SKILLSMITH_CLI_PIN_DRIFT_GH_CMD: gh,
    })

    expect(status).toBe(1) // the ruflo pin is still missing -- overall exit code stays 1
    expect(log).toContain('RUFLO_CLI_PIN not found or not valid semver')
    // The fix under test: supabase and wrangler are NOT silently skipped.
    expect(log).toContain('supabase: up to date (2.107.0)')
    expect(log).toContain('wrangler: up to date (4.112.0)')
    expect((state as { supabase?: unknown }).supabase).toBeDefined()
    expect((state as { wrangler?: unknown }).wrangler).toBeDefined()
  })

  it('M-11: a missing ruflo pin is routed through page_tool -- the same notify path other drift findings use (shadow mode)', () => {
    const repo = makeFixtureRepo({ rufloPin: null })
    const npm = makeFakeNpm({
      supabase: { latest: '2.107.0', versions: ['2.107.0'] },
      wrangler: { latest: '4.112.0', versions: ['4.112.0'] },
    })
    const { scriptPath: gh, captureFile } = makeFakeGh()

    const { status, log } = run({
      SKILLSMITH_CLI_PIN_DRIFT_REPO_ROOT: repo,
      SKILLSMITH_CLI_PIN_DRIFT_NPM_CMD: npm,
      SKILLSMITH_CLI_PIN_DRIFT_GH_CMD: gh,
      // SHADOW unset -- defaults to "1" inside the script, same as production default
    })

    expect(status).toBe(1)
    expect(log).toContain('[shadow] WOULD open/update issue: CLI pin drift: ruflo')
    expect(() => readFileSync(captureFile, 'utf8')).toThrow() // gh never actually invoked in shadow mode
  })

  it('M-11: with shadow lifted, a missing ruflo pin opens a real deduped GitHub issue via page_tool', () => {
    const repo = makeFixtureRepo({ rufloPin: null })
    const npm = makeFakeNpm({
      supabase: { latest: '2.107.0', versions: ['2.107.0'] },
      wrangler: { latest: '4.112.0', versions: ['4.112.0'] },
    })
    const { scriptPath: gh, captureFile } = makeFakeGh()

    const { status } = run({
      SKILLSMITH_CLI_PIN_DRIFT_REPO_ROOT: repo,
      SKILLSMITH_CLI_PIN_DRIFT_NPM_CMD: npm,
      SKILLSMITH_CLI_PIN_DRIFT_GH_CMD: gh,
      SKILLSMITH_CLI_PIN_DRIFT_SHADOW: '0',
    })

    expect(status).toBe(1)
    const capture = readFileSync(captureFile, 'utf8')
    expect(capture).toContain('cmd:issue list')
    expect(capture).toContain('cmd:issue create')
    expect(capture).toMatch(/CLI pin drift: ruflo/)
  })

  it('prints "ruflo: pinned <X>..." (never "no pin found, skipping") once a valid pin is read from the launcher', () => {
    // A drifted-but-within-grace-period pin is what actually produces a
    // "pinned $pinned, first newer minor/major $first_newer" log line (the
    // up-to-date branch instead logs "up to date ($pinned)") — this is the
    // shape the plan row's "dry run prints ruflo: pinned <X>" refers to.
    const repo = makeFixtureRepo({ rufloPin: '3.14.2' })
    const npm = makeFakeNpm({
      ruflo: { latest: '3.15.0', versions: ['3.14.2', '3.15.0'] },
      supabase: { latest: '2.107.0', versions: ['2.107.0'] },
      wrangler: { latest: '4.112.0', versions: ['4.112.0'] },
    })
    const { scriptPath: gh } = makeFakeGh()

    const { status, log } = run({
      SKILLSMITH_CLI_PIN_DRIFT_REPO_ROOT: repo,
      SKILLSMITH_CLI_PIN_DRIFT_NPM_CMD: npm,
      SKILLSMITH_CLI_PIN_DRIFT_GH_CMD: gh,
    })

    expect(status).toBe(0)
    expect(log).toContain('ruflo: pinned 3.14.2, first newer minor/major 3.15.0')
    expect(log).not.toContain('no pin found, skipping')
  })

  it('logs but does not page when the pin is already up to date', () => {
    const repo = makeFixtureRepo({ rufloPin: '3.14.2' })
    const npm = makeFakeNpm({
      ruflo: { latest: '3.14.2', versions: ['3.14.2'] },
      supabase: { latest: '2.107.0', versions: ['2.107.0'] },
      wrangler: { latest: '4.112.0', versions: ['4.112.0'] },
    })
    const { scriptPath: gh, captureFile } = makeFakeGh()

    const { status, log, state } = run({
      SKILLSMITH_CLI_PIN_DRIFT_REPO_ROOT: repo,
      SKILLSMITH_CLI_PIN_DRIFT_NPM_CMD: npm,
      SKILLSMITH_CLI_PIN_DRIFT_GH_CMD: gh,
    })

    expect(status).toBe(0)
    expect(log).toContain('ruflo: up to date')
    expect(
      (state as { ruflo: { first_newer_minor_or_major: unknown } }).ruflo.first_newer_minor_or_major
    ).toBeNull()
    expect(() => readFileSync(captureFile, 'utf8')).toThrow() // gh never invoked
  })

  it('does not page a freshly-observed drift, even one that would otherwise qualify (grace period)', () => {
    const repo = makeFixtureRepo({ rufloPin: '3.14.2' })
    const npm = makeFakeNpm({
      ruflo: { latest: '3.15.0', versions: ['3.14.2', '3.15.0'] },
      supabase: { latest: '2.107.0', versions: ['2.107.0'] },
      wrangler: { latest: '4.112.0', versions: ['4.112.0'] },
    })
    const { scriptPath: gh, captureFile } = makeFakeGh()

    const { log } = run({
      SKILLSMITH_CLI_PIN_DRIFT_REPO_ROOT: repo,
      SKILLSMITH_CLI_PIN_DRIFT_NPM_CMD: npm,
      SKILLSMITH_CLI_PIN_DRIFT_GH_CMD: gh,
    })

    expect(log).toContain('within 30-day grace period, not paging yet')
    expect(() => readFileSync(captureFile, 'utf8')).toThrow()
  })

  it('shadow mode logs "WOULD open/update issue" without calling gh, once the grace period has elapsed', () => {
    const repo = makeFixtureRepo({ rufloPin: '3.14.2' })
    const npm = makeFakeNpm({
      ruflo: { latest: '3.15.0', versions: ['3.14.2', '3.15.0'] },
      supabase: { latest: '2.107.0', versions: ['2.107.0'] },
      wrangler: { latest: '4.112.0', versions: ['4.112.0'] },
    })
    const { scriptPath: gh, captureFile } = makeFakeGh()

    // Pre-seed state so first_observed_at is already outside the grace window.
    const home = makeTmp('cli-pin-drift-preseeded')
    mkdirSync(join(home, '.skillsmith'), { recursive: true })
    writeFileSync(
      join(home, '.skillsmith', 'cli-pin-drift.state'),
      JSON.stringify({
        ruflo: {
          pinned: '3.14.2',
          latest: '3.15.0',
          first_newer_minor_or_major: '3.15.0',
          first_observed_at: isoAgo(45),
        },
      })
    )

    const result = spawnSync('bash', [SCRIPT], {
      env: {
        ...process.env,
        SKILLSMITH_CLI_PIN_DRIFT_TEST: '1',
        SKILLSMITH_CLI_PIN_DRIFT_HOME: home,
        SKILLSMITH_CLI_PIN_DRIFT_REPO_ROOT: repo,
        SKILLSMITH_CLI_PIN_DRIFT_NPM_CMD: npm,
        SKILLSMITH_CLI_PIN_DRIFT_GH_CMD: gh,
        // SHADOW unset — defaults to "1" inside the script, same as production default
      },
      encoding: 'utf8',
    })
    const log = readFileSync(
      join(home, '.skillsmith', 'logs', readdirSync(join(home, '.skillsmith', 'logs'))[0]),
      'utf8'
    )

    expect(result.status).toBe(0)
    expect(log).toContain('[shadow] WOULD open/update issue: CLI pin drift: ruflo')
    expect(() => readFileSync(captureFile, 'utf8')).toThrow() // gh never actually invoked in shadow mode
  })

  it('with shadow lifted, opens a new GitHub issue once the grace period has elapsed', () => {
    const repo = makeFixtureRepo({ rufloPin: '3.14.2' })
    const npm = makeFakeNpm({
      ruflo: { latest: '3.15.0', versions: ['3.14.2', '3.15.0'] },
      supabase: { latest: '2.107.0', versions: ['2.107.0'] },
      wrangler: { latest: '4.112.0', versions: ['4.112.0'] },
    })
    const { scriptPath: gh, captureFile } = makeFakeGh()

    const home = makeTmp('cli-pin-drift-live')
    mkdirSync(join(home, '.skillsmith'), { recursive: true })
    writeFileSync(
      join(home, '.skillsmith', 'cli-pin-drift.state'),
      JSON.stringify({
        ruflo: {
          pinned: '3.14.2',
          latest: '3.15.0',
          first_newer_minor_or_major: '3.15.0',
          first_observed_at: isoAgo(45),
        },
      })
    )

    const result = spawnSync('bash', [SCRIPT], {
      env: {
        ...process.env,
        SKILLSMITH_CLI_PIN_DRIFT_TEST: '1',
        SKILLSMITH_CLI_PIN_DRIFT_HOME: home,
        SKILLSMITH_CLI_PIN_DRIFT_REPO_ROOT: repo,
        SKILLSMITH_CLI_PIN_DRIFT_NPM_CMD: npm,
        SKILLSMITH_CLI_PIN_DRIFT_GH_CMD: gh,
        SKILLSMITH_CLI_PIN_DRIFT_SHADOW: '0',
      },
      encoding: 'utf8',
    })

    expect(result.status).toBe(0)
    const capture = readFileSync(captureFile, 'utf8')
    expect(capture).toContain('cmd:issue list')
    expect(capture).toContain('cmd:issue create')
    expect(capture).toMatch(/CLI pin drift: ruflo/)

    const state = JSON.parse(readFileSync(join(home, '.skillsmith', 'cli-pin-drift.state'), 'utf8'))
    expect(state.ruflo.github_issue_number).toBe(99)
  })

  it('dedupes: a second run within the 14-day cooldown does not call gh again', () => {
    const repo = makeFixtureRepo({ rufloPin: '3.14.2' })
    const npm = makeFakeNpm({
      ruflo: { latest: '3.15.0', versions: ['3.14.2', '3.15.0'] },
      supabase: { latest: '2.107.0', versions: ['2.107.0'] },
      wrangler: { latest: '4.112.0', versions: ['4.112.0'] },
    })
    const { scriptPath: gh, captureFile } = makeFakeGh()

    const home = makeTmp('cli-pin-drift-dedupe')
    mkdirSync(join(home, '.skillsmith'), { recursive: true })
    writeFileSync(
      join(home, '.skillsmith', 'cli-pin-drift.state'),
      JSON.stringify({
        ruflo: {
          pinned: '3.14.2',
          latest: '3.15.0',
          first_newer_minor_or_major: '3.15.0',
          first_observed_at: isoAgo(45),
          last_notified_at: isoAgo(1), // notified yesterday — well within the 14-day cooldown
          github_issue_number: 99,
        },
      })
    )

    const envBase = {
      ...process.env,
      SKILLSMITH_CLI_PIN_DRIFT_TEST: '1',
      SKILLSMITH_CLI_PIN_DRIFT_HOME: home,
      SKILLSMITH_CLI_PIN_DRIFT_REPO_ROOT: repo,
      SKILLSMITH_CLI_PIN_DRIFT_NPM_CMD: npm,
      SKILLSMITH_CLI_PIN_DRIFT_GH_CMD: gh,
      SKILLSMITH_CLI_PIN_DRIFT_SHADOW: '0',
    }
    const result = spawnSync('bash', [SCRIPT], { env: envBase, encoding: 'utf8' })
    const log = readFileSync(
      join(home, '.skillsmith', 'logs', readdirSync(join(home, '.skillsmith', 'logs'))[0]),
      'utf8'
    )

    expect(result.status).toBe(0)
    expect(log).toContain('within 14-day re-notify cooldown; no gh action')
    expect(() => readFileSync(captureFile, 'utf8')).toThrow() // gh never invoked this run
  })
})

// ---------------------------------------------------------------------------
// M-11 red-arm test: mutate a scratch copy, watch the property fail
// (SMI-6598's "revert the fix, watch it fail" rule, matching this repo's
// scripts/tests/ruflo-seed-manifest.test.ts convention for a generator/
// script rather than an application function.)
// ---------------------------------------------------------------------------

describe('cli-pin-drift-check.sh M-11 red-arm (scratch-copy mutation)', () => {
  const originalSource = readFileSync(SCRIPT, 'utf8')
  const originalMd5 = createHash('md5').update(originalSource).digest('hex')

  afterAll(() => {
    const finalSource = readFileSync(SCRIPT, 'utf8')
    const finalMd5 = createHash('md5').update(finalSource).digest('hex')
    expect(finalMd5).toBe(originalMd5)
  })

  /** Apply `mutate` to the real source, write the result to a scratch file, return its path. */
  function makeMutant(mutate: (src: string) => string): string {
    const mutated = mutate(originalSource)
    expect(mutated).not.toBe(originalSource)
    const dir = makeTmp('cli-pin-drift-mutant')
    const mutantPath = join(dir, 'cli-pin-drift-check-mutant.sh')
    writeFileSync(mutantPath, mutated, { mode: 0o755 })
    return mutantPath
  }

  function replaceOnce(src: string, needle: string, replacement: string): string {
    expect(src.split(needle).length - 1).toBe(1) // needle must be unique, or the mutation is ambiguous
    return src.replace(needle, replacement)
  }

  it('restoring the pre-fix early `exit 1` makes supabase/wrangler silently skip when the ruflo pin is missing', () => {
    const repo = makeFixtureRepo({ rufloPin: null })
    const npm = makeFakeNpm({
      supabase: { latest: '2.107.0', versions: ['2.107.0'] },
      wrangler: { latest: '4.112.0', versions: ['4.112.0'] },
    })
    const { scriptPath: gh } = makeFakeGh()

    // The exact pre-fix bug: `exit 1` immediately after detecting the
    // missing pin, before SUPABASE_PIN/WRANGLER_PIN are ever read.
    const mutantPath = makeMutant((src) =>
      replaceOnce(src, 'RUFLO_PIN_MISSING=1\n', 'RUFLO_PIN_MISSING=1\n  exit 1\n')
    )

    const home = makeTmp('cli-pin-drift-mutant-home')
    const result = spawnSync('bash', [mutantPath], {
      env: {
        ...process.env,
        SKILLSMITH_CLI_PIN_DRIFT_TEST: '1',
        SKILLSMITH_CLI_PIN_DRIFT_HOME: home,
        SKILLSMITH_CLI_PIN_DRIFT_REPO_ROOT: repo,
        SKILLSMITH_CLI_PIN_DRIFT_NPM_CMD: npm,
        SKILLSMITH_CLI_PIN_DRIFT_GH_CMD: gh,
      },
      encoding: 'utf8',
    })

    let log = ''
    try {
      const logDir = join(home, '.skillsmith', 'logs')
      log = readdirSync(logDir)
        .map((f) => readFileSync(join(logDir, f), 'utf8'))
        .join('\n')
    } catch {
      /* no log written under the mutant -- that itself is part of the failure */
    }

    expect(result.status).toBe(1)
    // Under the mutant, supabase/wrangler are silently skipped -- the
    // property under test (M-11's fix) FAILS to hold.
    expect(log).not.toContain('supabase:')
    expect(log).not.toContain('wrangler:')
  })
})
