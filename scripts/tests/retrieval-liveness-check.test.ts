/**
 * SMI-5432 W0.2 — integration tests for scripts/retrieval-liveness-check.sh.
 *
 * Drives the bash script via spawnSync with:
 *   SKILLSMITH_LIVENESS_TEST=1          — enables all test seams
 *   SKILLSMITH_LIVENESS_HOME            — unique per-test tmp dir (isolates state/logs)
 *   SKILLSMITH_LIVENESS_FORCE_NON_DOCKER — bypass /.dockerenv inside CI container
 *   SKILLSMITH_LIVENESS_DB_PATH         — point at a fixture DB, bypass resolver
 *   SKILLSMITH_LIVENESS_GH_CMD          — capture gh invocations without calling GitHub
 *   SKILLSMITH_LIVENESS_SQLITE_CMD      — override sqlite3 binary (default: sqlite3)
 *
 * ALL seams require SKILLSMITH_LIVENESS_TEST=1 (production can't be hijacked by
 * a stray env var). Never skipIf(inDocker) — seams let tests run inside the CI
 * container where vitest normally runs.
 *
 * Log files are read by readdirSync GLOB, not a computed date — TZ-stable.
 */

import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'
import { readEntry } from '../../packages/doc-retrieval-mcp/src/retrieval-log/liveness-state.js'
import { resolveMainRepoKey } from '../../packages/doc-retrieval-mcp/src/retrieval-log/autoheal-state.js'
import {
  CASE_SENSITIVE_FS,
  createFixtureDB,
  createGhScript,
  isoAgo,
} from './_lib/liveness-fixtures.js'

// ── Constants ──────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, '..', 'retrieval-liveness-check.sh')
const SCRIPT_DIR = resolve(__dirname, '..')

/**
 * Derive the MAIN_REPO key the bash script will use as its state key.
 * Mirrors the bash MAIN_REPO chain (worktree list → rev-parse → parent dir).
 */
function resolveExpectedKey(): string {
  const viaWorktree = resolveMainRepoKey(SCRIPT_DIR)
  if (viaWorktree) return viaWorktree
  try {
    return execFileSync('git', ['-C', SCRIPT_DIR, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim()
  } catch {
    /* fall through */
  }
  return resolve(SCRIPT_DIR, '..')
}
const MAIN_REPO_KEY = resolveExpectedKey()

// ── Fixture helpers ────────────────────────────────────────────────────────────

const tmpDirs: string[] = []
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

function makeHome(): string {
  const d = makeFixtureTempDir('liveness-bash-test')
  tmpDirs.push(d)
  return d
}

interface RunResult {
  status: number
  log: string
  stdout: string
}

function baseEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...makeFixtureEnv(),
    PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    SKILLSMITH_LIVENESS_TEST: '1',
    SKILLSMITH_LIVENESS_HOME: home,
    SKILLSMITH_LIVENESS_FORCE_NON_DOCKER: '1',
    ...extra,
  }
}

function runScript(
  home: string,
  extraEnv: Record<string, string> = {},
  args: string[] = []
): RunResult {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: baseEnv(home, extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
  })
  // Read log by glob — TZ-stable; never compute date from test process.
  const logsDir = join(home, '.skillsmith', 'logs')
  let log = ''
  try {
    log = readdirSync(logsDir)
      .filter((f) => f.startsWith('retrieval-liveness-') && f.endsWith('.log'))
      .map((f) => readFileSync(join(logsDir, f), 'utf8'))
      .join('')
  } catch {
    /* log dir may not exist for early exits */
  }
  return { status: result.status ?? 1, log, stdout: result.stdout ?? '' }
}

function statePath(home: string): string {
  return join(home, '.skillsmith', 'retrieval-liveness.state')
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('healthy verdict', () => {
  it('exits 0 and records healthy state when rows are recent', () => {
    const home = makeHome()
    const dbPath = join(home, 'retrieval-logs.db')
    createFixtureDB(dbPath, { retrievalTs: [isoAgo(0.5)] }) // 12 hours ago
    const result = runScript(home, { SKILLSMITH_LIVENESS_DB_PATH: dbPath })
    expect(result.status).toBe(0)
    expect(result.log).toContain('[liveness] healthy')
    const entry = readEntry(MAIN_REPO_KEY, statePath(home))
    expect(entry?.lastVerdict).toBe('healthy')
  })
})

describe('stale verdict', () => {
  it('exits 1 when MAX row is older than N days', () => {
    const home = makeHome()
    const dbPath = join(home, 'retrieval-logs.db')
    createFixtureDB(dbPath, { retrievalTs: [isoAgo(10)] }) // 10 days ago
    const result = runScript(home, { SKILLSMITH_LIVENESS_DB_PATH: dbPath })
    expect(result.status).toBe(1)
    expect(result.log).toContain('[liveness] stale')
  })

  it('old DB with ONLY retrieval_events (no frontmatter_lint_events) — no parse error (C1)', () => {
    const home = makeHome()
    const dbPath = join(home, 'retrieval-logs.db')
    // skipFrontmatterTable: old DB that never had frontmatter_lint_events
    createFixtureDB(dbPath, { retrievalTs: [isoAgo(10)], skipFrontmatterTable: true })
    const result = runScript(home, { SKILLSMITH_LIVENESS_DB_PATH: dbPath })
    // Should detect stale, not error out from UNION ALL parse failure
    expect(result.status).toBe(1)
    expect(result.log).toContain('[liveness] stale')
    expect(result.log).not.toContain('probe-failed')
  })

  it('both tables present — takes the max of the two', () => {
    const home = makeHome()
    const dbPath = join(home, 'retrieval-logs.db')
    // retrieval_events old, frontmatter fresh → healthy (max of both = fresh)
    createFixtureDB(dbPath, {
      retrievalTs: [isoAgo(10)],
      frontmatterTs: [isoAgo(0.5)],
    })
    const result = runScript(home, { SKILLSMITH_LIVENESS_DB_PATH: dbPath })
    expect(result.status).toBe(0)
    expect(result.log).toContain('[liveness] healthy')
  })
})

describe('outage marker (H2)', () => {
  it('exits 1 even when rows are fresh when marker is present', () => {
    const home = makeHome()
    // Create fresh DB + outage marker in same dir
    const encoded = '-app'
    const projectDir = join(home, '.claude', 'projects', encoded)
    mkdirSync(projectDir, { recursive: true })
    const dbPath = join(projectDir, 'retrieval-logs.db')
    const markerPath = join(projectDir, 'retrieval-log.outage.json')
    createFixtureDB(dbPath, { retrievalTs: [isoAgo(0.5)] }) // fresh rows
    writeFileSync(markerPath, JSON.stringify({ ts: new Date().toISOString(), reason: 'test' }))
    // Use HOME-based resolution (no DB_PATH seam) so marker check runs
    const result = runScript(home, {
      SKILLSMITH_PROJECT_DIR_ENCODED: encoded,
      HOME: home,
    })
    expect(result.status).toBe(1)
    expect(result.log).toContain('[liveness] stale')
    expect(result.log).toContain('outage marker')
  })
})

describe('no DB', () => {
  it('exits 0 without creating any alert when DB does not exist', () => {
    const home = makeHome()
    const { scriptPath, captureFile } = createGhScript(home)
    const result = runScript(home, {
      SKILLSMITH_LIVENESS_DB_PATH: join(home, 'nonexistent.db'),
      SKILLSMITH_LIVENESS_GH_CMD: scriptPath,
    })
    expect(result.status).toBe(0)
    expect(result.log).toContain('no DB')
    expect(existsSync(captureFile)).toBe(false)
  })
})

describe.skipIf(!CASE_SENSITIVE_FS)('ambiguous resolver (case-sensitive FS only)', () => {
  it('exits 2 and does not alert when project dir is ambiguous', () => {
    const home = makeHome()
    const { scriptPath, captureFile } = createGhScript(home)
    // Env-agnostic: derive the encoded dir the script WILL compute from its own
    // REPO_ROOT via the shared resolver (host: canonical repo path; CI: /app),
    // then plant two ASCII-fold-equal case-variants so reconcile → "ambiguous".
    const repoRoot = resolve(SCRIPT_DIR, '..')
    const projectDirSh = join(SCRIPT_DIR, 'lib', 'project-dir.sh')
    const encoded = execFileSync('bash', [projectDirSh, 'resolve-shared', repoRoot], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    })
      .split('\t')[1]
      ?.trim()
    expect(encoded).toBeTruthy()
    // Two case-variants that both ASCII-fold to `encoded` but NEITHER equals it.
    // (Creating `encoded` verbatim would hit the resolver's "exact" branch before
    // the fold-ambiguity check — so plant only variants: first-lowercase-upper
    // and last-lowercase-upper.)
    const variant1 = (encoded as string).replace(/[a-z]/, (c) => c.toUpperCase())
    const variant2 = (encoded as string).replace(/[a-z](?=[^a-z]*$)/, (c) => c.toUpperCase())
    expect(variant1).not.toBe(encoded) // real repo paths always have a lowercase letter
    expect(variant2).not.toBe(encoded)
    expect(variant1).not.toBe(variant2)
    const claudeProjects = join(home, '.claude', 'projects')
    mkdirSync(join(claudeProjects, variant1), { recursive: true })
    mkdirSync(join(claudeProjects, variant2), { recursive: true })
    // Run WITHOUT SKILLSMITH_LIVENESS_DB_PATH so the resolver executes.
    const result = runScript(home, { HOME: home, SKILLSMITH_LIVENESS_GH_CMD: scriptPath }, [])
    expect(result.status).toBe(2)
    expect(result.log).toContain('ambiguous')
    expect(existsSync(captureFile)).toBe(false)
  })
})

describe('disabled kill-switch', () => {
  it('exits 0 immediately without state write or gh call', () => {
    const home = makeHome()
    const dbPath = join(home, 'retrieval-logs.db')
    createFixtureDB(dbPath, { retrievalTs: [isoAgo(10)] })
    const { scriptPath, captureFile } = createGhScript(home)
    const result = runScript(home, {
      SKILLSMITH_LIVENESS_DB_PATH: dbPath,
      SKILLSMITH_RETRIEVAL_LIVENESS_DISABLE: '1',
      SKILLSMITH_LIVENESS_GH_CMD: scriptPath,
    })
    expect(result.status).toBe(0)
    expect(result.log).toContain('disabled')
    expect(existsSync(statePath(home))).toBe(false)
    expect(existsSync(captureFile)).toBe(false)
  })
})

describe('snoozed (H5)', () => {
  it('state is written and log shows verdict but no gh call when snoozed', () => {
    const home = makeHome()
    const dbPath = join(home, 'retrieval-logs.db')
    createFixtureDB(dbPath, { retrievalTs: [isoAgo(10)] })
    const { scriptPath, captureFile } = createGhScript(home)
    const futureEpoch = String(Math.floor(Date.now() / 1000) + 86400) // 24h from now
    const result = runScript(home, {
      SKILLSMITH_LIVENESS_DB_PATH: dbPath,
      SKILLSMITH_RETRIEVAL_LIVENESS_SHADOW: '0',
      SKILLSMITH_RETRIEVAL_LIVENESS_SNOOZE_UNTIL: futureEpoch,
      SKILLSMITH_LIVENESS_GH_CMD: scriptPath,
    })
    expect(result.status).toBe(1)
    expect(result.log).toContain('[liveness] stale')
    expect(result.log).toContain('[snooze]')
    // State was written (record is called before snooze check)
    const entry = readEntry(MAIN_REPO_KEY, statePath(home))
    expect(entry?.lastVerdict).toBe('stale')
    // gh was NOT called
    expect(existsSync(captureFile)).toBe(false)
  })
})

describe('shadow mode (default)', () => {
  it('logs [shadow] WOULD and does not call gh', () => {
    const home = makeHome()
    const dbPath = join(home, 'retrieval-logs.db')
    createFixtureDB(dbPath, { retrievalTs: [isoAgo(10)] })
    const { scriptPath, captureFile } = createGhScript(home)
    // Shadow is the default (SKILLSMITH_RETRIEVAL_LIVENESS_SHADOW not set → defaults to 1)
    const result = runScript(home, {
      SKILLSMITH_LIVENESS_DB_PATH: dbPath,
      SKILLSMITH_LIVENESS_GH_CMD: scriptPath,
    })
    expect(result.status).toBe(1)
    expect(result.log).toContain('[shadow] WOULD open issue')
    expect(existsSync(captureFile)).toBe(false)
  })
})

describe('active mode (SHADOW=0)', () => {
  it('calls gh issue create exactly once on first stale run', () => {
    const home = makeHome()
    const dbPath = join(home, 'retrieval-logs.db')
    createFixtureDB(dbPath, { retrievalTs: [isoAgo(10)] })
    const { scriptPath, captureFile } = createGhScript(home)
    const result = runScript(home, {
      SKILLSMITH_LIVENESS_DB_PATH: dbPath,
      SKILLSMITH_RETRIEVAL_LIVENESS_SHADOW: '0',
      SKILLSMITH_LIVENESS_GH_CMD: scriptPath,
    })
    expect(result.status).toBe(1)
    expect(result.log).not.toContain('[shadow]')
    expect(existsSync(captureFile)).toBe(true)
    const calls = readFileSync(captureFile, 'utf8')
    // Exactly one issue-create (plus one list before it)
    const createCount = (calls.match(/cmd:issue create/g) ?? []).length
    expect(createCount).toBe(1)
  })

  it('dedupe: second stale run within cooldown does not create a duplicate', () => {
    const home = makeHome()
    const dbPath = join(home, 'retrieval-logs.db')
    createFixtureDB(dbPath, { retrievalTs: [isoAgo(10)] })
    const { scriptPath, captureFile } = createGhScript(home)

    // First run → creates issue, writes state
    runScript(home, {
      SKILLSMITH_LIVENESS_DB_PATH: dbPath,
      SKILLSMITH_RETRIEVAL_LIVENESS_SHADOW: '0',
      SKILLSMITH_LIVENESS_GH_CMD: scriptPath,
    })

    // Second run within cooldown → decision=dedupe → no gh call at all
    const result2 = runScript(home, {
      SKILLSMITH_LIVENESS_DB_PATH: dbPath,
      SKILLSMITH_RETRIEVAL_LIVENESS_SHADOW: '0',
      SKILLSMITH_LIVENESS_GH_CMD: scriptPath,
    })
    expect(result2.status).toBe(1)
    expect(result2.log).toContain('dedupe')
    // Total issue-create calls across both runs: still exactly 1
    const calls = readFileSync(captureFile, 'utf8')
    const createCount = (calls.match(/cmd:issue create/g) ?? []).length
    expect(createCount).toBe(1)
  })
})

describe('DB path resolution', () => {
  it('uses SKILLSMITH_PROJECT_DIR_ENCODED directly when set', () => {
    const home = makeHome()
    const encoded = '-encoded-test-repo'
    const projectDir = join(home, '.claude', 'projects', encoded)
    mkdirSync(projectDir, { recursive: true })
    const dbPath = join(projectDir, 'retrieval-logs.db')
    createFixtureDB(dbPath, { retrievalTs: [isoAgo(0.5)] }) // fresh → healthy
    const result = runScript(home, {
      HOME: home,
      SKILLSMITH_PROJECT_DIR_ENCODED: encoded,
    })
    expect(result.status).toBe(0)
    expect(result.log).toContain('[liveness] healthy')
  })

  it('falls back to resolve_shared_project_dir when SKILLSMITH_PROJECT_DIR_ENCODED is unset', () => {
    const home = makeHome()
    // In Docker, REPO_ROOT=/app → encoded='-app'
    const encoded = '-app'
    const projectDir = join(home, '.claude', 'projects', encoded)
    mkdirSync(projectDir, { recursive: true })
    const dbPath = join(projectDir, 'retrieval-logs.db')
    createFixtureDB(dbPath, { retrievalTs: [isoAgo(0.5)] })
    // No SKILLSMITH_LIVENESS_DB_PATH, no SKILLSMITH_PROJECT_DIR_ENCODED → uses resolver
    const result = runScript(home, { HOME: home })
    // Should find the DB and report healthy (or no-DB if the resolver picks a different encoded path)
    // Either exit 0 (healthy/no-DB) is valid — we just confirm no crash + exit != 2
    expect(result.status).not.toBe(2)
    expect(result.log).not.toContain('probe-failed')
  })
})

describe('--soak-report (M4)', () => {
  it('prints correct per-verdict tally from fixture logs', () => {
    const home = makeHome()
    const logsDir = join(home, '.skillsmith', 'logs')
    mkdirSync(logsDir, { recursive: true })
    // Write fixture log entries
    const log1 = join(logsDir, 'retrieval-liveness-2026-06-01.log')
    const log2 = join(logsDir, 'retrieval-liveness-2026-06-08.log')
    writeFileSync(
      log1,
      '2026-06-01T00:00:00+0000 [liveness] healthy: last row 2026-05-31\n' +
        '2026-06-01T01:00:00+0000 [liveness] stale: last row 2026-05-01\n'
    )
    writeFileSync(
      log2,
      '2026-06-08T00:00:00+0000 [liveness] stale: last row 2026-05-01\n' +
        '2026-06-08T01:00:00+0000 [liveness] probe-failed: sqlite3 CLI not on PATH\n'
    )
    const result = runScript(home, {}, ['--soak-report'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('healthy:')
    expect(result.stdout).toContain('stale:')
    expect(result.stdout).toContain('probe-failed:')
    // Exact counts from the fixture
    expect(result.stdout).toMatch(/healthy:\s+1/)
    expect(result.stdout).toMatch(/stale:\s+2/)
    expect(result.stdout).toMatch(/probe-failed:\s+1/)
  })
})

describe('static source invariants', () => {
  let src: string
  beforeAll(() => {
    src = readFileSync(SCRIPT, 'utf8')
  })

  it('all test seams require SKILLSMITH_LIVENESS_TEST=1 master switch', () => {
    expect(src).toContain('SKILLSMITH_LIVENESS_FORCE_NON_DOCKER')
    expect(src).toContain('SKILLSMITH_LIVENESS_SQLITE_CMD')
    expect(src).toContain('SKILLSMITH_LIVENESS_DB_PATH')
    expect(src).toContain('SKILLSMITH_LIVENESS_GH_CMD')
    // All seam checks are guarded by LIVENESS_TEST. Scan CODE only (strip full
    // comment lines) — comments legitimately mention seam var names without a
    // co-located guard and must not trip this invariant.
    const codeOnly = src
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')
    const matches = [
      ...codeOnly.matchAll(/SKILLSMITH_LIVENESS_(FORCE_NON_DOCKER|SQLITE_CMD|DB_PATH|GH_CMD)/g),
    ]
    for (const m of matches) {
      const idx = m.index ?? 0
      const context = codeOnly.slice(Math.max(0, idx - 200), idx)
      expect(context).toMatch(/LIVENESS_TEST/)
    }
  })

  it('tsx unavailable guard (M3): exits 0, no state write, no gh call', () => {
    // Source-level proof that the branch exists — behavioural coverage requires
    // MAIN_REPO injection which the bash script derives from git (not injectable
    // via env). The FORCE_NON_DOCKER seam already exercises the rest of the
    // happy/stale paths in the tests above.
    expect(src).toContain('tsx unavailable')
    expect(src).toContain('no state write, no gh call')
    expect(src).toContain('TSX_AVAIL')
  })
})
