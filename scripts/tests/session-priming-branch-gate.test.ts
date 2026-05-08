/**
 * SMI-4809: Branch-gate matrix for scripts/session-start-priming.sh.
 *
 * Pre-fix Gate 2 only matched literal-prefix `smi-*` / `wave-*`. The project's
 * standard `fix/smi-NNN-…`, `chore/smi-NNN-…`, `feat/smi-NNN-…` patterns
 * silently fell through to `emit_empty` — 6 primed rows / 307 sessions over
 * 7 days = 1.95% capture rate (SMI-4498 soak gate).
 *
 * Post-fix Gate 2 extracts `smi-NNN`/`wave-NNN` from anywhere in the branch
 * name. The deny list (main, hotfix-*, hotfix/*, dependabot/*, renovate/*,
 * release/*, revert/*) is checked first so embedded tokens in those branches
 * still don't prime.
 *
 * Detection mechanism: if the script reaches the `mkdir -p "$LOG_DIR"` line
 * (post-Gate-2, pre-Gate-4), the encoded log directory under $HOME exists
 * after the script returns. We redirect HOME to a per-test scratch dir so
 * we don't pollute the real ~/.claude/projects/. The query script is missing
 * inside the fixture's REPO_ROOT, so Gate 4 trips and exits cleanly without
 * touching the real writer DB.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HOOK_SCRIPT = join(__dirname, '..', 'session-start-priming.sh')

interface MatrixRow {
  branch: string
  primed: boolean
  reason: string
}

const MATRIX: MatrixRow[] = [
  // Controls — must continue to prime (regression guard for the existing behavior).
  { branch: 'smi-4809-foo', primed: true, reason: 'literal smi-N prefix (control)' },
  { branch: 'wave-1-bar', primed: true, reason: 'literal wave-N prefix (control)' },
  // Regression cases — pre-fix these silently skipped, post-fix must prime.
  { branch: 'fix/smi-4809-foo', primed: true, reason: 'fix/smi-N prefix (SMI-4809 regression)' },
  { branch: 'chore/smi-4809', primed: true, reason: 'chore/smi-N prefix (SMI-4809 regression)' },
  { branch: 'feat/wave-2-bar', primed: true, reason: 'feat/wave-N prefix (SMI-4809 regression)' },
  // Skip controls — must remain skipped.
  { branch: 'main', primed: false, reason: 'main is in deny list' },
  { branch: 'hotfix/urgent-fix', primed: false, reason: 'hotfix/* (slash form) is in deny list' },
  { branch: 'hotfix-1234', primed: false, reason: 'hotfix-* (dash form) is in deny list' },
  { branch: 'dependabot/npm/foo', primed: false, reason: 'dependabot/* is in deny list' },
  // Plan-review M1 additions — deny list must trump SMI extractor.
  {
    branch: 'release/smi-4809-hotfix',
    primed: false,
    reason: 'release/* deny-list trumps SMI extractor (plan-review H1)',
  },
  {
    branch: 'revert/smi-4809-foo',
    primed: false,
    reason: 'revert/* deny-list trumps SMI extractor (plan-review H1)',
  },
  // No-token cases — must not prime.
  { branch: 'release/v1.2.3', primed: false, reason: 'no smi/wave token' },
  { branch: 'fix/random-name', primed: false, reason: 'no smi/wave token' },
]

interface RunResult {
  exitCode: number | null
  stdout: string
  stderr: string
  /** Did the script reach the `mkdir -p "$LOG_DIR"` step? */
  reachedMkdir: boolean
}

function runHook(repo: string, branch: string, home: string): RunResult {
  // Build SessionStart JSON event the harness sends on stdin.
  const event = JSON.stringify({
    session_id: 'test-' + Math.random().toString(36).slice(2, 10),
    source: 'startup',
    cwd: repo,
    transcript_path: '',
  })

  // Run the bash hook directly (no Docker needed — pure shell script with
  // python3/git deps available on host). Strip GIT_DISCOVERY_VARS via
  // makeFixtureEnv so the spawned `git` inside the hook resolves the temp
  // repo via cwd-walk rather than this process's parent-worktree env.
  const env = makeFixtureEnv({ HOME: home })

  const proc = spawnSync('bash', [HOOK_SCRIPT], {
    cwd: repo,
    env,
    input: event,
    encoding: 'utf8',
    timeout: 10_000,
  })

  // The encoded LOG_DIR is $HOME/.claude/projects/-<repo-path-with-/-as--->
  // matching the bash sed: 's|^/|-|;s|/|-|g' (leading / → -, all other / → -).
  const encoded = repo.replace(/^\//, '-').replace(/\//g, '-')
  const logDir = join(home, '.claude', 'projects', encoded)

  return {
    exitCode: proc.status,
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
    reachedMkdir: existsSync(logDir),
  }
}

function setupFixtureRepo(branch: string): { repo: string; home: string } {
  const home = makeFixtureTempDir('smi-4809-home')
  const repo = makeFixtureTempDir('smi-4809-repo')
  const env = makeFixtureEnv()

  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo, env, stdio: 'pipe' })
  // Need at least one commit before we can checkout a non-main branch in some git versions.
  writeFileSync(join(repo, 'README.md'), '# fixture\n', 'utf8')
  execFileSync('git', ['add', 'README.md'], { cwd: repo, env, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, env, stdio: 'pipe' })

  if (branch !== 'main') {
    execFileSync('git', ['checkout', '-b', branch], { cwd: repo, env, stdio: 'pipe' })
  }

  // Ensure $HOME/.claude exists but NOT the encoded project dir — that's the
  // signal we're testing for.
  mkdirSync(join(home, '.claude'), { recursive: true })

  return { repo, home }
}

describe('session-start-priming.sh Gate 2 (SMI-4809)', () => {
  // Track temp dirs to clean up.
  const tempDirs: string[] = []

  afterEach(() => {
    for (const d of tempDirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  })

  for (const row of MATRIX) {
    const label = `${row.primed ? 'primes' : 'skips'} on ${row.branch}: ${row.reason}`
    it(label, () => {
      const { repo, home } = setupFixtureRepo(row.branch)
      tempDirs.push(repo, home)

      const result = runHook(repo, row.branch, home)

      // The script is best-effort and always exits 0.
      expect(result.exitCode, `stderr was:\n${result.stderr}`).toBe(0)

      // The actual gate signal: did Gate 2 let the script reach the LOG_DIR mkdir?
      if (row.primed) {
        expect(
          result.reachedMkdir,
          `Expected hook to pass Gate 2 for branch=${row.branch}, but $LOG_DIR was not created.\n` +
            `stdout: ${result.stdout}\nstderr: ${result.stderr}`
        ).toBe(true)
      } else {
        expect(
          result.reachedMkdir,
          `Expected hook to skip at Gate 2 for branch=${row.branch}, but $LOG_DIR was created.\n` +
            `stdout: ${result.stdout}\nstderr: ${result.stderr}`
        ).toBe(false)
      }

      // Regardless of primed/skipped, every code path emits a SessionStart JSON
      // payload to stdout — the harness validator requires `hookEventName`.
      expect(result.stdout).toMatch(/"hookEventName"\s*:\s*"SessionStart"/)
    })
  }

  it('does not prime when source != startup (Gate 1 still fires post-fix)', () => {
    const { repo, home } = setupFixtureRepo('smi-4809-foo')
    tempDirs.push(repo, home)

    const event = JSON.stringify({
      session_id: 'test-resumed-001',
      source: 'resume', // <-- not startup
      cwd: repo,
      transcript_path: '',
    })
    const proc = spawnSync('bash', [HOOK_SCRIPT], {
      cwd: repo,
      env: makeFixtureEnv({ HOME: home }),
      input: event,
      encoding: 'utf8',
      timeout: 10_000,
    })

    const encoded = repo.replace(/^\//, '-').replace(/\//g, '-')
    const logDir = join(home, '.claude', 'projects', encoded)

    expect(proc.status).toBe(0)
    expect(existsSync(logDir)).toBe(false) // Gate 1 still rejects, doesn't reach Gate 2
  })

  it('skips on detached HEAD (empty branch — covered by deny-list "" arm)', () => {
    // Detached-HEAD repos report empty string from \`git branch --show-current\`.
    // The deny list explicitly matches \`""\` so the hook must short-circuit before
    // the SMI extractor — guarding against future extractor changes that could
    // misinterpret an empty string.
    const { repo, home } = setupFixtureRepo('smi-4809-foo')
    tempDirs.push(repo, home)

    // Detach HEAD so \`git branch --show-current\` returns empty.
    execFileSync('git', ['checkout', '--detach', 'HEAD'], {
      cwd: repo,
      env: makeFixtureEnv(),
      stdio: 'pipe',
    })

    const event = JSON.stringify({
      session_id: 'test-detached-001',
      source: 'startup',
      cwd: repo,
      transcript_path: '',
    })
    const proc = spawnSync('bash', [HOOK_SCRIPT], {
      cwd: repo,
      env: makeFixtureEnv({ HOME: home }),
      input: event,
      encoding: 'utf8',
      timeout: 10_000,
    })

    const encoded = repo.replace(/^\//, '-').replace(/\//g, '-')
    const logDir = join(home, '.claude', 'projects', encoded)

    expect(proc.status).toBe(0)
    expect(existsSync(logDir)).toBe(false) // empty branch is in deny list
  })
})
