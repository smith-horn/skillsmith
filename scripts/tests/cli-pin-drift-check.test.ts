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
import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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

/** Fixture repo: a .mcp.json + root package.json + packages/website/package.json. */
function makeFixtureRepo(opts: {
  rufloPin?: string
  supabasePin?: string
  wranglerPin?: string
}): string {
  const dir = makeTmp('cli-pin-drift-repo')
  writeFileSync(
    join(dir, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        ruflo: { command: 'npx', args: [`ruflo@${opts.rufloPin ?? '3.14.2'}`, 'mcp', 'start'] },
      },
    })
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
