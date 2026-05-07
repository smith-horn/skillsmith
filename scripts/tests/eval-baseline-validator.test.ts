/**
 * SMI-4764 Wave 0 — Tests for scripts/eval-baseline-validator.mjs
 *
 * The validator is invoked from the pre-push hook with pushed-ref data on
 * stdin. We exercise it as a black box: write fixture files, set env, pipe
 * stdin, observe exit code + stderr.
 *
 * Each scenario builds an isolated temp git repo that replicates the path
 * layout (packages/doc-retrieval-mcp/eval/{baseline.json,.signatures.log},
 * scripts/), copies the validator script in, and execs it from there.
 *
 * SMI-4693: every git invocation in this file routes through makeFixtureEnv()
 * to prevent GIT_DISCOVERY_VARS from redirecting the spawn into the parent
 * worktree's .git.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { rmSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const VALIDATOR_SRC = join(REPO_ROOT, 'scripts', 'eval-baseline-validator.mjs')

const BASELINE_REL = 'packages/doc-retrieval-mcp/eval/baseline.json'
const SIGNATURES_REL = 'packages/doc-retrieval-mcp/eval/.signatures.log'

interface Fixture {
  dir: string
  baselineSha: string
}

function shaOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: makeFixtureEnv() }).trim()
}

function setupRepo(opts: {
  baselineContent: string
  signatureLines?: string[]
  // files modified between base and head (relative paths from repo root)
  modifyFiles?: string[]
}): Fixture {
  const dir = makeFixtureTempDir('eval-validator-test')
  const env = makeFixtureEnv()
  // Init repo, configure user
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, env })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir, env })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, env })

  // Layout
  mkdirSync(join(dir, 'packages/doc-retrieval-mcp/eval'), { recursive: true })
  mkdirSync(join(dir, 'packages/doc-retrieval-mcp/src'), { recursive: true })
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  copyFileSync(VALIDATOR_SRC, join(dir, 'scripts/eval-baseline-validator.mjs'))

  // Initial baseline + ranking files (older content)
  writeFileSync(join(dir, BASELINE_REL), '{"prior":null,"current":null}\n', 'utf8')
  writeFileSync(join(dir, 'packages/doc-retrieval-mcp/src/rerank.ts'), '// initial\n')
  writeFileSync(join(dir, 'packages/doc-retrieval-mcp/src/search.ts'), '// initial\n')
  writeFileSync(join(dir, 'packages/doc-retrieval-mcp/src/corpus.config.json'), '{}\n')
  writeFileSync(join(dir, 'packages/doc-retrieval-mcp/eval/gold-set.json'), '[]\n')
  writeFileSync(join(dir, SIGNATURES_REL), '')

  execFileSync('git', ['add', '.'], { cwd: dir, env })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env })
  const baseSha = git(dir, 'rev-parse', 'HEAD')

  // Apply HEAD-side changes
  writeFileSync(join(dir, BASELINE_REL), opts.baselineContent, 'utf8')
  if (opts.signatureLines !== undefined) {
    writeFileSync(
      join(dir, SIGNATURES_REL),
      opts.signatureLines.length === 0 ? '' : opts.signatureLines.join('\n') + '\n',
      'utf8'
    )
  }
  for (const f of opts.modifyFiles ?? []) {
    writeFileSync(join(dir, f), `// modified ${Date.now()}\n`, 'utf8')
  }

  execFileSync('git', ['add', '-A'], { cwd: dir, env })
  execFileSync('git', ['commit', '-q', '-m', 'change'], { cwd: dir, env })
  const headSha = git(dir, 'rev-parse', 'HEAD')

  // Stdin synthesis happens in run() below using HEAD~1..HEAD; the explicit
  // shas just exist here to assert the layout is wired correctly.
  void headSha
  void baseSha

  return { dir, baselineSha: shaOf(opts.baselineContent) }
}

function run(
  fixture: Fixture,
  opts: {
    canonical: boolean
    stdinRefs?: string // pre-formed stdin; if absent we synthesize from git
  }
): { status: number; stderr: string; stdout: string } {
  const dir = fixture.dir
  let stdin = opts.stdinRefs
  if (stdin === undefined) {
    const head = git(dir, 'rev-parse', 'HEAD')
    const base = git(dir, 'rev-parse', 'HEAD~1')
    stdin = `refs/heads/main ${head} refs/heads/main ${base}\n`
  }
  const result = spawnSync('node', [join(dir, 'scripts/eval-baseline-validator.mjs')], {
    cwd: dir,
    input: stdin,
    encoding: 'utf8',
    env: {
      ...makeFixtureEnv(),
      SKILLSMITH_EVAL_CANONICAL: opts.canonical ? 'true' : '',
    },
  })
  return {
    status: result.status ?? -1,
    stderr: result.stderr,
    stdout: result.stdout,
  }
}

function freshSignatureLine(sha: string, ageMs = 0): string {
  const ts = new Date(Date.now() - ageMs).toISOString()
  return `${sha}\t${ts}\t0000000000000000000000000000000000000000`
}

describe('eval-baseline-validator', () => {
  let fixtures: Fixture[] = []
  beforeEach(() => {
    fixtures = []
  })
  afterEach(() => {
    for (const f of fixtures) {
      rmSync(f.dir, { recursive: true, force: true })
    }
  })

  function track(f: Fixture): Fixture {
    fixtures.push(f)
    return f
  }

  it('is a no-op when no ranking files are in the diff', () => {
    const f = track(
      setupRepo({
        baselineContent: '{"prior":null,"current":0.5}\n',
        // No ranking files modified — but baseline did change. Validator
        // should not fire because the *trigger* is ranking-file changes.
        modifyFiles: [],
      })
    )
    const r = run(f, { canonical: true })
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
  })

  it('rejects when ranking file changed but baseline is missing from diff (canonical)', () => {
    const f = track(
      setupRepo({
        // Baseline content unchanged (still original content) — diff won't include it.
        baselineContent: '{"prior":null,"current":null}\n',
        modifyFiles: ['packages/doc-retrieval-mcp/src/rerank.ts'],
      })
    )
    const r = run(f, { canonical: true })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('baseline.json is not in this push')
    expect(r.stderr).toContain('RETRIEVAL_EVAL_REAL=1')
  })

  it('warns but allows in advisory mode for the same scenario', () => {
    const f = track(
      setupRepo({
        baselineContent: '{"prior":null,"current":null}\n',
        modifyFiles: ['packages/doc-retrieval-mcp/src/rerank.ts'],
      })
    )
    const r = run(f, { canonical: false })
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('advisory mode')
    expect(r.stderr).toContain('baseline.json is not in this push')
  })

  it('rejects when baseline.json sha has no signature (canonical)', () => {
    const newBaseline = '{"prior":0.4,"current":0.42}\n'
    const f = track(
      setupRepo({
        baselineContent: newBaseline,
        signatureLines: [], // empty log
        modifyFiles: ['packages/doc-retrieval-mcp/src/rerank.ts'],
      })
    )
    const r = run(f, { canonical: true })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('hand-edited or stale')
  })

  it('passes when baseline + fresh signature + ranking-file change (canonical)', () => {
    const newBaseline = '{"prior":0.4,"current":0.42}\n'
    const sha = shaOf(newBaseline)
    const f = track(
      setupRepo({
        baselineContent: newBaseline,
        signatureLines: [freshSignatureLine(sha)],
        modifyFiles: ['packages/doc-retrieval-mcp/src/rerank.ts'],
      })
    )
    const r = run(f, { canonical: true })
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
  })

  it('rejects stale signature on ranking-only change beyond 7d (canonical)', () => {
    const newBaseline = '{"prior":0.4,"current":0.42}\n'
    const sha = shaOf(newBaseline)
    const eightDaysMs = 8 * 24 * 60 * 60 * 1000
    const f = track(
      setupRepo({
        baselineContent: newBaseline,
        signatureLines: [freshSignatureLine(sha, eightDaysMs)],
        modifyFiles: ['packages/doc-retrieval-mcp/src/rerank.ts'],
      })
    )
    const r = run(f, { canonical: true })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('stale')
    expect(r.stderr).toContain('7d')
  })

  it('rejects stale signature on corpus change beyond 24h (canonical)', () => {
    const newBaseline = '{"prior":0.4,"current":0.42}\n'
    const sha = shaOf(newBaseline)
    const thirtyHoursMs = 30 * 60 * 60 * 1000
    const f = track(
      setupRepo({
        baselineContent: newBaseline,
        signatureLines: [freshSignatureLine(sha, thirtyHoursMs)],
        modifyFiles: ['packages/doc-retrieval-mcp/src/corpus.config.json'],
      })
    )
    const r = run(f, { canonical: true })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('stale')
    expect(r.stderr).toContain('24h')
  })

  it('rejects stale signature on gold-set.json change beyond 24h (canonical)', () => {
    const newBaseline = '{"prior":0.4,"current":0.42}\n'
    const sha = shaOf(newBaseline)
    const thirtyHoursMs = 30 * 60 * 60 * 1000
    const f = track(
      setupRepo({
        baselineContent: newBaseline,
        signatureLines: [freshSignatureLine(sha, thirtyHoursMs)],
        modifyFiles: ['packages/doc-retrieval-mcp/eval/gold-set.json'],
      })
    )
    const r = run(f, { canonical: true })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('24h')
  })

  it('uses the tighter 24h window when both ranking and corpus changes are present', () => {
    const newBaseline = '{"prior":0.4,"current":0.42}\n'
    const sha = shaOf(newBaseline)
    // 5 days old: passes the 7d window but exceeds 24h. With corpus in the
    // diff, the validator must use the 24h window.
    const fiveDaysMs = 5 * 24 * 60 * 60 * 1000
    const f = track(
      setupRepo({
        baselineContent: newBaseline,
        signatureLines: [freshSignatureLine(sha, fiveDaysMs)],
        modifyFiles: [
          'packages/doc-retrieval-mcp/src/rerank.ts',
          'packages/doc-retrieval-mcp/eval/gold-set.json',
        ],
      })
    )
    const r = run(f, { canonical: true })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('24h')
  })

  it('warns but allows stale signature in advisory mode', () => {
    const newBaseline = '{"prior":0.4,"current":0.42}\n'
    const sha = shaOf(newBaseline)
    const eightDaysMs = 8 * 24 * 60 * 60 * 1000
    const f = track(
      setupRepo({
        baselineContent: newBaseline,
        signatureLines: [freshSignatureLine(sha, eightDaysMs)],
        modifyFiles: ['packages/doc-retrieval-mcp/src/rerank.ts'],
      })
    )
    const r = run(f, { canonical: false })
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('advisory mode')
    expect(r.stderr).toContain('stale')
  })

  it('handles delete-only push (local_sha all-zero) as no-op', () => {
    const f = track(
      setupRepo({
        baselineContent: '{"prior":null,"current":null}\n',
        modifyFiles: ['packages/doc-retrieval-mcp/src/rerank.ts'],
      })
    )
    const stdin = 'refs/heads/foo 0000000000000000000000000000000000000000 refs/heads/foo abc123\n'
    const r = run(f, { canonical: true, stdinRefs: stdin })
    expect(r.status).toBe(0)
  })
})
