/**
 * SMI-5708 Item #14 — resolveDiffRange() no-op-vs-failure tests for
 * scripts/eval-baseline-validator.mjs, split out of
 * eval-baseline-validator.test.ts to keep that file under the 500-line
 * standard (audit:standards Check 3 / scripts/check-file-length.mjs).
 *
 * resolveDiffRange() must distinguish a genuine no-op (delete-only push, no
 * upstream configured at all) from an actual resolution failure (origin/main
 * not fetched, or an upstream that's configured but unresolvable) instead of
 * returning a bare `null` indistinguishable from the intentional no-op case
 * -- the same "silent pass when it can't verify" bug class Item #2 closed
 * one layer down in listChangedFiles().
 *
 * Two rounds of Opus + Codex review found real bugs in successive drafts:
 * round 1 made a delete-only stdin line short-circuit past an earlier
 * line's recorded resolution failure in the same multi-ref push (a real
 * `git push` can update several refs in one invocation, one line per ref).
 * Round 2 fixed that, but Codex found the fix still let a resolution
 * failure on one ref be silently overridden by a DIFFERENT ref's
 * successful resolution, in either stdin order -- fixed by making a
 * recorded failure take absolute priority over any resolved range,
 * regardless of which line comes first.
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
  baseSha: string
  headSha: string
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
  modifyFiles?: string[]
}): Fixture {
  const dir = makeFixtureTempDir('eval-validator-rangeres-test')
  const env = makeFixtureEnv()
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, env })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir, env })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, env })

  mkdirSync(join(dir, 'packages/doc-retrieval-mcp/eval'), { recursive: true })
  mkdirSync(join(dir, 'packages/doc-retrieval-mcp/src'), { recursive: true })
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  copyFileSync(VALIDATOR_SRC, join(dir, 'scripts/eval-baseline-validator.mjs'))

  writeFileSync(join(dir, BASELINE_REL), '{"prior":null,"current":null}\n', 'utf8')
  writeFileSync(join(dir, 'packages/doc-retrieval-mcp/src/rerank.ts'), '// initial\n')
  writeFileSync(join(dir, 'packages/doc-retrieval-mcp/src/search.ts'), '// initial\n')
  writeFileSync(join(dir, 'packages/doc-retrieval-mcp/src/corpus.config.json'), '{}\n')
  writeFileSync(join(dir, 'packages/doc-retrieval-mcp/eval/gold-set.json'), '[]\n')
  writeFileSync(join(dir, SIGNATURES_REL), '')

  execFileSync('git', ['add', '.'], { cwd: dir, env })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env })
  const baseSha = git(dir, 'rev-parse', 'HEAD')

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

  return { dir, baselineSha: shaOf(opts.baselineContent), baseSha, headSha }
}

function run(
  fixture: Fixture,
  opts: { canonical: boolean; stdinRefs?: string }
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

const ZEROS = '0000000000000000000000000000000000000000'

function newBranchStdin(fixture: Fixture): string {
  const head = git(fixture.dir, 'rev-parse', 'HEAD')
  return `refs/heads/feature ${head} refs/heads/feature ${ZEROS}\n`
}

describe('eval-baseline-validator resolveDiffRange no-op vs failure', () => {
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

  it('fails closed (canonical) when a new-branch push cannot resolve origin/main (not fetched)', () => {
    const f = track(
      setupRepo({
        baselineContent: '{"prior":null,"current":null}\n',
        modifyFiles: ['packages/doc-retrieval-mcp/src/rerank.ts'],
      })
    )
    // No `origin` remote exists in this isolated fixture repo, so the
    // merge-base lookup this stdin shape triggers fails exactly like an
    // unfetched origin/main would on a real machine.
    const r = run(f, { canonical: true, stdinRefs: newBranchStdin(f) })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('BLOCK (canonical mode)')
    expect(r.stderr).toContain('range-resolution failure')
    expect(r.stderr).toContain('merge-base origin/main failed')
  })

  it('treats no upstream configured at all as a genuine no-op, not a failure', () => {
    const f = track(
      setupRepo({
        baselineContent: '{"prior":null,"current":null}\n',
        modifyFiles: ['packages/doc-retrieval-mcp/src/rerank.ts'],
      })
    )
    // Empty stdin forces the fallback path; setupRepo() never configures an
    // upstream for its fixture branch, matching the genuine "this branch was
    // never pushed with -u" scenario the file's own header documents.
    const r = run(f, { canonical: true, stdinRefs: '' })
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
  })

  it('fails closed (canonical) when an upstream IS configured but cannot actually be resolved', () => {
    const f = track(
      setupRepo({
        baselineContent: '{"prior":null,"current":null}\n',
        modifyFiles: ['packages/doc-retrieval-mcp/src/rerank.ts'],
      })
    )
    // Hand-set the branch config keys directly (bypassing the ref-existence
    // check `git branch --set-upstream-to` would otherwise require) to
    // simulate "upstream configured, but the remote-tracking ref doesn't
    // actually exist" without needing a real remote/fetch in this isolated
    // fixture.
    git(f.dir, 'config', 'branch.main.remote', 'origin')
    git(f.dir, 'config', 'branch.main.merge', 'refs/heads/main')

    const r = run(f, { canonical: true, stdinRefs: '' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('BLOCK (canonical mode)')
    expect(r.stderr).toContain('range-resolution failure')
    expect(r.stderr).toContain('upstream resolution failed despite an upstream being configured')
  })

  it('warns (advisory) instead of blocking for the same configured-but-unresolvable upstream', () => {
    const f = track(
      setupRepo({
        baselineContent: '{"prior":null,"current":null}\n',
        modifyFiles: ['packages/doc-retrieval-mcp/src/rerank.ts'],
      })
    )
    git(f.dir, 'config', 'branch.main.remote', 'origin')
    git(f.dir, 'config', 'branch.main.merge', 'refs/heads/main')

    const r = run(f, { canonical: false, stdinRefs: '' })
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('WARN (advisory mode')
    expect(r.stderr).toContain('range-resolution failure')
  })

  // -------------------------------------------------------------------------
  // Multi-ref push: one failing ref must never be silently overridden by a
  // DIFFERENT ref's outcome in the same push, regardless of stdin order.
  // -------------------------------------------------------------------------

  it('a merge-base failure on one ref is not masked by a delete-only line for another ref (round 2, Codex finding)', () => {
    const f = track(
      setupRepo({
        baselineContent: '{"prior":null,"current":null}\n',
        modifyFiles: ['packages/doc-retrieval-mcp/src/rerank.ts'],
      })
    )
    const head = git(f.dir, 'rev-parse', 'HEAD')
    const stdin =
      `refs/heads/feature ${head} refs/heads/feature ${ZEROS}\n` +
      `refs/heads/old-branch ${ZEROS} refs/heads/old-branch ${head}\n`
    const r = run(f, { canonical: true, stdinRefs: stdin })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('merge-base origin/main failed')
  })

  it('a merge-base failure on one ref is not masked by a DIFFERENT ref resolving successfully, failure-then-success order (round 3, Codex finding)', () => {
    const f = track(
      setupRepo({
        baselineContent: '{"prior":null,"current":null}\n',
        modifyFiles: ['packages/doc-retrieval-mcp/src/rerank.ts'],
      })
    )
    const head = git(f.dir, 'rev-parse', 'HEAD')
    const stdin =
      `refs/heads/feature ${head} refs/heads/feature ${ZEROS}\n` +
      `refs/heads/existing ${head} refs/heads/existing ${f.baseSha}\n`
    const r = run(f, { canonical: true, stdinRefs: stdin })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('merge-base origin/main failed')
  })

  it('a merge-base failure on one ref is not masked by a DIFFERENT ref resolving successfully, success-then-failure order (round 3, Codex finding)', () => {
    const f = track(
      setupRepo({
        baselineContent: '{"prior":null,"current":null}\n',
        modifyFiles: ['packages/doc-retrieval-mcp/src/rerank.ts'],
      })
    )
    const head = git(f.dir, 'rev-parse', 'HEAD')
    const stdin =
      `refs/heads/existing ${head} refs/heads/existing ${f.baseSha}\n` +
      `refs/heads/feature ${head} refs/heads/feature ${ZEROS}\n`
    const r = run(f, { canonical: true, stdinRefs: stdin })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('merge-base origin/main failed')
  })
})
