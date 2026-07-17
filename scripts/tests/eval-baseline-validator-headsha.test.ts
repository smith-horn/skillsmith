/**
 * SMI-5708 Item #5 — headSha ancestor-check tests for
 * scripts/eval-baseline-validator.mjs, split out of
 * eval-baseline-validator.test.ts to keep that file under the 500-line
 * standard (audit:standards Check 3 / scripts/check-file-length.mjs).
 *
 * The signature's recorded headSha must be the current HEAD, or an ancestor
 * of it -- not required to match exactly. This closes the gap where a
 * hand-edited baseline.json + an independently-computed matching sha256 line
 * (with ANY headSha) would previously pass purely on content-hash equality.
 * The exact-match case is covered in the sibling file's "passes when
 * baseline + fresh signature + ranking-file change" test -- these exercise
 * the ancestor-tolerant case (SMI-2597 wave-branch-stacking: a later commit
 * on the same branch shouldn't false-reject a still-valid signature) and the
 * rejection case (a real commit that is genuinely unrelated to this
 * history), plus the multi-entry selection fix (Codex review finding, High):
 * the pre-fix lookup returned only the FIRST matching content-hash line, so
 * an older entry's stale/non-ancestor headSha could shadow a later, valid
 * entry for the SAME content-hash.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { rmSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs'
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
  const dir = makeFixtureTempDir('eval-validator-headsha-test')
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

function freshSignatureLine(sha: string, headSha: string, ageMs = 0): string {
  const ts = new Date(Date.now() - ageMs).toISOString()
  return `${sha}\t${ts}\t${headSha}`
}

function writeSignatureLog(fixture: Fixture, lines: string[]): void {
  writeFileSync(
    join(fixture.dir, SIGNATURES_REL),
    lines.length === 0 ? '' : lines.join('\n') + '\n',
    'utf8'
  )
}

describe('eval-baseline-validator headSha ancestor check (SMI-5708 Item #5)', () => {
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

  it('accepts a signature whose headSha is an ancestor of current HEAD, not just an exact match', () => {
    const newBaseline = '{"prior":0.4,"current":0.42}\n'
    const sha = shaOf(newBaseline)
    const f = track(
      setupRepo({
        baselineContent: newBaseline,
        modifyFiles: ['packages/doc-retrieval-mcp/src/rerank.ts'],
      })
    )
    const commitA = f.headSha // the "change" commit: introduces baseline.json + the ranking-file diff
    const env = makeFixtureEnv()

    // Record the signature against A, then advance HEAD with a further
    // commit B that does not touch baseline.json again -- simulating the
    // routine case (SMI-2597 wave-branch-stacking: a later commit lands on
    // top of A on the same branch, a genuine descendant -- not an actual
    // rebase/amend, which would produce a sibling of A instead) where the
    // validated commit's sha changes after the signature was
    // recorded, without baseline.json itself changing.
    writeSignatureLog(f, [freshSignatureLine(sha, commitA)])
    writeFileSync(join(f.dir, 'packages/doc-retrieval-mcp/UNRELATED_BUMP.md'), '# unrelated\n')
    execFileSync('git', ['add', '-A'], { cwd: f.dir, env })
    execFileSync('git', ['commit', '-q', '-m', 'unrelated child commit'], { cwd: f.dir, env })
    const commitB = git(f.dir, 'rev-parse', 'HEAD')
    expect(commitB).not.toBe(commitA)

    // Diff from the ORIGINAL base through B, so both the ranking-file change
    // and the baseline.json change (both introduced in A) are visible in the
    // range the validator inspects -- run()'s default HEAD~1 synthesis would
    // only see B vs A and miss them.
    const stdin = `refs/heads/main ${commitB} refs/heads/main ${f.baseSha}\n`
    const r = run(f, { canonical: true, stdinRefs: stdin })
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
  })

  function setupNonAncestorFixture(): { f: Fixture; unrelatedSha: string } {
    const newBaseline = '{"prior":0.4,"current":0.42}\n'
    const sha = shaOf(newBaseline)
    const f = track(
      setupRepo({
        baselineContent: newBaseline,
        modifyFiles: ['packages/doc-retrieval-mcp/src/rerank.ts'],
      })
    )
    const env = makeFixtureEnv()

    // Branch off the ORIGINAL base (pre-"change" commit) and commit there --
    // a sibling of the "change" commit (f.headSha), never merged into main's
    // history. A real, resolvable commit, but not reachable from main's HEAD.
    execFileSync('git', ['checkout', '-q', '-b', 'unrelated', f.baseSha], { cwd: f.dir, env })
    writeFileSync(join(f.dir, 'packages/doc-retrieval-mcp/UNRELATED_BRANCH.md'), '# unrelated\n')
    execFileSync('git', ['add', '-A'], { cwd: f.dir, env })
    execFileSync('git', ['commit', '-q', '-m', 'unrelated branch commit'], { cwd: f.dir, env })
    const unrelatedSha = git(f.dir, 'rev-parse', 'HEAD')

    // Back to main -- HEAD is f.headSha again, unrelatedSha is a sibling, not
    // an ancestor.
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: f.dir, env })
    expect(git(f.dir, 'rev-parse', 'HEAD')).toBe(f.headSha)

    writeSignatureLog(f, [freshSignatureLine(sha, unrelatedSha)])
    return { f, unrelatedSha }
  }

  it('rejects (canonical) a signature whose headSha is a real commit but not an ancestor of current HEAD', () => {
    const { f } = setupNonAncestorFixture()
    const r = run(f, { canonical: true })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('BLOCK (canonical mode)')
    expect(r.stderr).toContain('current HEAD')
    expect(r.stderr).toContain('ancestor')
  })

  it('warns but allows the same non-ancestor-headSha scenario in advisory mode', () => {
    const { f } = setupNonAncestorFixture()
    const r = run(f, { canonical: false })
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('advisory mode')
    expect(r.stderr).toContain('current HEAD')
    expect(r.stderr).toContain('ancestor')
  })

  // Codex review finding, High: the pre-fix lookup returned only the FIRST
  // matching content-hash line. The same baseline.json content can
  // legitimately be re-signed more than once within the log's 15-line FIFO
  // window (e.g. re-running the eval after a commit that didn't change
  // ranking/corpus/gold-set), so an older entry's stale/non-ancestor headSha
  // must not shadow a later entry's valid one for the SAME content-hash.
  it('accepts when an OLDER entry for the same content-hash has a non-ancestor headSha but a LATER entry is valid', () => {
    const { f, unrelatedSha } = setupNonAncestorFixture()
    const newBaseline = readFileSync(join(f.dir, BASELINE_REL), 'utf8')
    const sha = shaOf(newBaseline)

    // Two log lines, same content-hash: the older (first) entry is the
    // already-written non-ancestor one; append a second, later entry whose
    // headSha IS the current HEAD (a real exact match).
    writeSignatureLog(f, [
      freshSignatureLine(sha, unrelatedSha),
      freshSignatureLine(sha, f.headSha),
    ])

    const r = run(f, { canonical: true })
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
  })

  it('rejects when ALL entries for the same content-hash have a non-ancestor headSha (canonical)', () => {
    const { f, unrelatedSha } = setupNonAncestorFixture()
    const newBaseline = readFileSync(join(f.dir, BASELINE_REL), 'utf8')
    const sha = shaOf(newBaseline)

    // Two entries, same content-hash, BOTH non-ancestor -- confirms the fix
    // doesn't just optimistically pass whenever more than one entry exists.
    writeSignatureLog(f, [
      freshSignatureLine(sha, unrelatedSha),
      freshSignatureLine(sha, unrelatedSha),
    ])

    const r = run(f, { canonical: true })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('BLOCK (canonical mode)')
    expect(r.stderr).toContain('ancestor')
  })
})
