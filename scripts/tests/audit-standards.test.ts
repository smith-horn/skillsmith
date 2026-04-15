/**
 * Tests for the pure helpers in scripts/audit-standards-helpers.mjs.
 *
 * Covers SMI-3987 (Check 11 dedup awareness via `satisfies`) and Check 23
 * cite-in-body filtering (via `extractCompletionIssues`), plus SMI-3986
 * (Check 23 worktree-aware `git rev-parse --git-common-dir` resolution).
 *
 * The pure helpers are imported via dynamic ESM import from a small
 * companion file, matching the convention used by
 * scripts/tests/check-supply-chain-pins.test.ts. The integration test for
 * `gitCommonDir` uses a real tmpdir-based git repo + worktree (the only
 * way to validate the SMI-3986 fix end-to-end).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Dynamic ESM import — exact convention from check-supply-chain-pins.test.ts
const helpers = (await import('../audit-standards-helpers.mjs')) as {
  parseSemver: (v: string) => [number, number, number] | null
  satisfies: (version: string, spec: string) => boolean
  extractCompletionIssues: (subject: string, body: string) => Set<string>
  parseTsExports: (content: string) => { names: Set<string>; starFrom: string[] }
  collectTsEntryExports: (
    entryPath: string,
    readFile: (p: string) => string | null,
    resolveModule: (fromFile: string, spec: string) => string | null
  ) => Set<string>
  extractSmokeTestRequiredArrays: (content: string) => { name: string; arrayIndex: number }[]
}

const {
  parseSemver,
  satisfies,
  extractCompletionIssues,
  parseTsExports,
  collectTsEntryExports,
  extractSmokeTestRequiredArrays,
} = helpers

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Pinned full body of squash-merge commit `8ec28dfa` (SMI-3984). Captured
 * via `git log -1 --format=%b 8ec28dfa > scripts/tests/fixtures/smi-3984-commit-body.txt`.
 *
 * Contains 9 SMI-3984 mentions and 1 SMI-3099 mention, none of which are
 * after a closes/fixes/resolves marker. The test asserts that
 * extractCompletionIssues returns ONLY the subject-line SMI ref (SMI-3984),
 * not any of the body cite mentions. This is the exact regression case from
 * the SMI-3984 retro that triggered SMI-3987.
 */
const FIXTURE_SMI_3984_BODY = readFileSync(
  join(__dirname, 'fixtures', 'smi-3984-commit-body.txt'),
  'utf-8'
)

describe('audit-standards-helpers: parseSemver', () => {
  it('parses major.minor.patch', () => {
    expect(parseSemver('1.2.3')).toEqual([1, 2, 3])
    expect(parseSemver('0.11.13')).toEqual([0, 11, 13])
    expect(parseSemver('100.200.300')).toEqual([100, 200, 300])
  })

  it('parses prerelease/build metadata as just the numeric prefix', () => {
    // sufficient for the override specs in root package.json — none use prereleases
    expect(parseSemver('1.2.3-rc.1')).toEqual([1, 2, 3])
    expect(parseSemver('1.2.3+build.42')).toEqual([1, 2, 3])
  })

  it('returns null for unparseable input', () => {
    expect(parseSemver('not-a-version')).toBeNull()
    expect(parseSemver('1.2')).toBeNull() // missing patch
    expect(parseSemver('')).toBeNull()
  })
})

describe('audit-standards-helpers: satisfies', () => {
  // ── caret ranges (^) on >=1.0.0 ──────────────────────────────────────────
  it('caret >=1.0.0: matches same major and ≥minor.patch', () => {
    expect(satisfies('8.18.0', '^8.18.0')).toBe(true)
    expect(satisfies('8.18.5', '^8.18.0')).toBe(true)
    expect(satisfies('8.19.0', '^8.18.0')).toBe(true)
  })

  it('caret >=1.0.0: rejects different major', () => {
    expect(satisfies('9.0.0', '^8.18.0')).toBe(false)
    expect(satisfies('7.99.99', '^8.18.0')).toBe(false)
  })

  it('caret >=1.0.0: rejects below floor', () => {
    expect(satisfies('8.17.0', '^8.18.0')).toBe(false)
    expect(satisfies('8.18.0', '^8.18.5')).toBe(false)
  })

  // ── caret on 0.x (locks minor) ──────────────────────────────────────────
  it('caret on 0.x: locks minor and matches ≥patch', () => {
    expect(satisfies('0.11.13', '^0.11.13')).toBe(true)
    expect(satisfies('0.11.15', '^0.11.13')).toBe(true)
    expect(satisfies('0.11.99', '^0.11.13')).toBe(true)
  })

  it('caret on 0.x: rejects different minor', () => {
    expect(satisfies('0.12.0', '^0.11.13')).toBe(false)
    expect(satisfies('0.10.99', '^0.11.13')).toBe(false)
  })

  it('caret on 0.x: rejects below patch floor', () => {
    expect(satisfies('0.11.12', '^0.11.13')).toBe(false)
  })

  // ── tilde ranges (~) ────────────────────────────────────────────────────
  it('tilde: locks minor, allows patch ≥ floor', () => {
    expect(satisfies('2.8.3', '~2.8.3')).toBe(true)
    expect(satisfies('2.8.4', '~2.8.3')).toBe(true)
    expect(satisfies('2.9.0', '~2.8.3')).toBe(false)
    expect(satisfies('2.8.2', '~2.8.3')).toBe(false)
  })

  // ── >= and > ────────────────────────────────────────────────────────────
  it('>= matches at floor and above', () => {
    expect(satisfies('3.972.3', '>=3.972.3')).toBe(true)
    expect(satisfies('4.0.0', '>=3.972.3')).toBe(true)
    expect(satisfies('3.972.2', '>=3.972.3')).toBe(false)
  })

  it('> matches strictly above floor', () => {
    expect(satisfies('1.0.1', '>1.0.0')).toBe(true)
    expect(satisfies('2.0.0', '>1.99.99')).toBe(true)
    expect(satisfies('1.0.0', '>1.0.0')).toBe(false)
  })

  // ── exact / literal ─────────────────────────────────────────────────────
  it('literal pin: exact match only', () => {
    expect(satisfies('8.18.0', '8.18.0')).toBe(true)
    expect(satisfies('8.18.1', '8.18.0')).toBe(false)
  })

  // ── graceful failure ────────────────────────────────────────────────────
  it('returns false for unparseable inputs', () => {
    expect(satisfies('invalid', '^1.0.0')).toBe(false)
    expect(satisfies('1.0.0', '^invalid')).toBe(false)
    expect(satisfies('invalid', '~1.0.0')).toBe(false)
    expect(satisfies('1.0.0', '>=invalid')).toBe(false)
  })

  // ── ground-truth: the 6 SMI-3984 overrides that Check 11 false-positived ─
  it('SMI-3984 ground truth: yaml@2.8.3 satisfies ^2.8.3', () => {
    expect(satisfies('2.8.3', '^2.8.3')).toBe(true)
  })

  it('SMI-3984 ground truth: ajv@8.18.0 satisfies ^8.18.0', () => {
    expect(satisfies('8.18.0', '^8.18.0')).toBe(true)
  })

  it('SMI-3984 ground truth: srvx@0.11.15 satisfies ^0.11.13', () => {
    expect(satisfies('0.11.15', '^0.11.13')).toBe(true)
  })

  it('SMI-3984 ground truth: minimatch@10.2.5 satisfies ^10.2.3', () => {
    expect(satisfies('10.2.5', '^10.2.3')).toBe(true)
  })

  it('SMI-3984 ground truth: smol-toml@1.6.1 satisfies ^1.6.1', () => {
    expect(satisfies('1.6.1', '^1.6.1')).toBe(true)
  })
})

describe('audit-standards-helpers: extractCompletionIssues', () => {
  it('subject SMI ref counts as completion claim', () => {
    const result = extractCompletionIssues('fix: remediate vulns (SMI-3984) (#490)', '')
    expect([...result]).toEqual(['SMI-3984'])
  })

  it('multiple subject SMI refs all count', () => {
    const result = extractCompletionIssues('feat: ship (SMI-1, SMI-2)', '')
    expect([...result].sort()).toEqual(['SMI-1', 'SMI-2'])
  })

  it('subject SMI normalizes lowercase to uppercase', () => {
    const result = extractCompletionIssues('fix: smi-1234 cleanup', '')
    expect([...result]).toEqual(['SMI-1234'])
  })

  it('body SMI without closes marker is IGNORED (cite-in-body)', () => {
    const result = extractCompletionIssues(
      'fix: remediate vulns (SMI-3984)',
      'per SMI-3099 exact-pin doc'
    )
    expect([...result]).toEqual(['SMI-3984'])
    expect(result.has('SMI-3099')).toBe(false)
  })

  it('body SMI after closes: marker counts', () => {
    const result = extractCompletionIssues('fix: x', 'closes: SMI-1234')
    expect([...result]).toEqual(['SMI-1234'])
  })

  it('body SMI after Closes: marker (case-insensitive) counts', () => {
    const result = extractCompletionIssues('fix: x', 'Closes: SMI-1234')
    expect([...result]).toEqual(['SMI-1234'])
  })

  it('body SMI after fixes:/Fixed:/Resolved: markers all count', () => {
    expect([...extractCompletionIssues('fix: x', 'fixes: SMI-1')]).toEqual(['SMI-1'])
    expect([...extractCompletionIssues('fix: x', 'Fixed: SMI-2')]).toEqual(['SMI-2'])
    expect([...extractCompletionIssues('fix: x', 'Resolved: SMI-3')]).toEqual(['SMI-3'])
    expect([...extractCompletionIssues('fix: x', 'closed: SMI-4')]).toEqual(['SMI-4'])
    expect([...extractCompletionIssues('fix: x', 'resolves: SMI-5')]).toEqual(['SMI-5'])
  })

  it('comma-separated list after closes: all count', () => {
    const result = extractCompletionIssues('fix: x', 'Closes: SMI-1234, SMI-5678')
    expect([...result].sort()).toEqual(['SMI-1234', 'SMI-5678'])
  })

  it('multi-line markers (closes on one line, fixes on next) both count', () => {
    const result = extractCompletionIssues('fix: x', 'closes: SMI-1234\nfixes: SMI-5678')
    expect([...result].sort()).toEqual(['SMI-1234', 'SMI-5678'])
  })

  it('subject SMI + body closes-marker SMI: both count, cite-in-body refs do not', () => {
    const result = extractCompletionIssues('fix: x (SMI-1)', 'fixes: SMI-2\n\nreferences: SMI-3')
    expect([...result].sort()).toEqual(['SMI-1', 'SMI-2'])
    expect(result.has('SMI-3')).toBe(false)
  })

  it('bare marker (no colon) still matches — locks PERMISSIVE behavior (Open Q3)', () => {
    // GitHub linking syntax accepts bare keyword + SMI ref (e.g. "fix SMI-1234")
    const result = extractCompletionIssues('chore: x', 'fix SMI-1234')
    expect([...result]).toEqual(['SMI-1234'])
  })

  it('Co-Authored-By trailer is NOT a closing marker', () => {
    // Defensive: even if a co-author email contained "SMI-9999@example.com",
    // the regex requires a closing keyword prefix, so it would not match.
    const result = extractCompletionIssues(
      'fix: x (SMI-1)',
      'Co-Authored-By: Claude <noreply@anthropic.com>\nrefs: SMI-9999'
    )
    expect([...result]).toEqual(['SMI-1'])
    expect(result.has('SMI-9999')).toBe(false)
  })

  it('SMI ref inside a markdown code block without closes marker is ignored', () => {
    const body = 'See `SMI-1234` for context\n```\nper SMI-5678\n```'
    const result = extractCompletionIssues('fix: x', body)
    expect(result.size).toBe(0)
  })

  it('empty body returns empty set if subject has no SMI ref', () => {
    expect(extractCompletionIssues('fix: cleanup', '').size).toBe(0)
  })

  // ── PINNED REGRESSION FIXTURE: SMI-3984 squash commit body ──────────────
  it('PINNED REGRESSION (SMI-3984 ground truth): cite-in-body SMI-3099 is NOT counted', () => {
    // The SMI-3984 squash commit (8ec28dfa) body contains 9 SMI-3984 mentions
    // and 1 SMI-3099 mention, none after a closes marker. Only the subject's
    // SMI-3984 should be counted as a completion claim.
    const subject = 'fix(deps): remediate 33 npm audit findings (SMI-3984) (#490)'
    const result = extractCompletionIssues(subject, FIXTURE_SMI_3984_BODY)
    expect([...result]).toEqual(['SMI-3984'])
    expect(result.has('SMI-3099')).toBe(false)
  })
})

describe('audit-standards Check 23: NON_SOURCE_PREFIXES (conventional commit type/scope)', () => {
  // The NON_SOURCE_PREFIXES regex is defined inside the Check 23 scope block
  // and is not exported. We re-implement it here for unit-test coverage. The
  // re-implementation must stay in sync with the version in audit-standards.mjs.
  const NON_SOURCE_PREFIXES = /^((docs|chore|ci|test|refactor|style)(\(.+\))?|[a-z]+\(deps\))!?:/i

  it('matches docs/chore/ci/test/refactor/style without scope', () => {
    expect(NON_SOURCE_PREFIXES.test('docs: update readme')).toBe(true)
    expect(NON_SOURCE_PREFIXES.test('chore: bump version')).toBe(true)
    expect(NON_SOURCE_PREFIXES.test('ci: update workflow')).toBe(true)
    expect(NON_SOURCE_PREFIXES.test('test: add coverage')).toBe(true)
    expect(NON_SOURCE_PREFIXES.test('refactor: simplify')).toBe(true)
    expect(NON_SOURCE_PREFIXES.test('style: format')).toBe(true)
  })

  it('matches docs/chore/etc with scope', () => {
    expect(NON_SOURCE_PREFIXES.test('docs(api): update')).toBe(true)
    expect(NON_SOURCE_PREFIXES.test('chore(release): 1.0')).toBe(true)
    expect(NON_SOURCE_PREFIXES.test('refactor(core): split')).toBe(true)
  })

  it('matches breaking change marker (!)', () => {
    expect(NON_SOURCE_PREFIXES.test('chore!: drop node 14')).toBe(true)
    expect(NON_SOURCE_PREFIXES.test('docs(api)!: rename')).toBe(true)
  })

  it('matches deps-scoped commits regardless of type (SMI-3987)', () => {
    // The fix that enables this test: deps-scoped commits with any type
    // (fix, feat, build, etc.) legitimately modify package.json without
    // source files. Without this branch, the SMI-3984 merge commit
    // (subject `fix(deps): remediate 33 npm audit findings (SMI-3984) (#490)`)
    // would still be flagged by Check 23 because `fix(deps):` is not in the
    // base prefix list and the commit has no source-file changes.
    expect(NON_SOURCE_PREFIXES.test('fix(deps): bump vite')).toBe(true)
    expect(NON_SOURCE_PREFIXES.test('feat(deps): add new package')).toBe(true)
    expect(NON_SOURCE_PREFIXES.test('build(deps): update lockfile')).toBe(true)
    expect(NON_SOURCE_PREFIXES.test('chore(deps): bump dependencies')).toBe(true)
  })

  it('does NOT match feat/fix/perf/build without deps scope', () => {
    // These types should still trigger source-file requirement
    expect(NON_SOURCE_PREFIXES.test('feat: add api')).toBe(false)
    expect(NON_SOURCE_PREFIXES.test('fix: bug')).toBe(false)
    expect(NON_SOURCE_PREFIXES.test('perf: optimize')).toBe(false)
    expect(NON_SOURCE_PREFIXES.test('feat(api): new endpoint')).toBe(false)
    expect(NON_SOURCE_PREFIXES.test('fix(server): handle null')).toBe(false)
  })
})

describe('audit-standards Check 23: gitCommonDir worktree integration', () => {
  let tmpRoot: string | null = null

  beforeAll(() => {
    // Sanity check: git is installed in the test environment
    try {
      execSync('git --version', { stdio: 'ignore' })
    } catch {
      throw new Error('git is required for the worktree integration test')
    }
  })

  afterEach(() => {
    if (tmpRoot && existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
    tmpRoot = null
  })

  it('SMI-3986: git rev-parse --git-common-dir resolves to main .git from inside a worktree', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'audit-standards-worktree-'))
    const main = join(tmpRoot, 'main')
    const wt = join(tmpRoot, 'wt')

    // Create a fresh main repo + one commit
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 't@example.com',
    }
    execSync(`git init --quiet "${main}"`, { env })
    execSync(`git -C "${main}" commit --allow-empty -m init --quiet`, { env })
    execSync(`git -C "${main}" worktree add --quiet "${wt}"`, { env })

    // Inside the worktree, .git is a FILE (not a directory)
    expect(existsSync(join(wt, '.git'))).toBe(true)
    const dotGitContent = readFileSync(join(wt, '.git'), 'utf-8')
    expect(dotGitContent).toMatch(/^gitdir:/)

    // The fix: git rev-parse --git-common-dir resolves to main's .git
    const commonDir = execSync('git rev-parse --git-common-dir', {
      cwd: wt,
      encoding: 'utf-8',
    }).trim()

    // Normalize: --git-common-dir may be relative (to wt) OR absolute. Use
    // path.resolve, which honors absolute paths and otherwise resolves
    // relative to wt. realpathSync collapses any /private/var <-> /var
    // symlinks (macOS tmpdir).
    const resolved = realpathSync(resolve(wt, commonDir))
    const expected = realpathSync(join(main, '.git'))
    expect(resolved).toBe(expected)

    // The shallow file is what the audit-standards Check 23 actually checks for
    expect(existsSync(join(resolved, 'shallow'))).toBe(false)
  })
})

// ============================================================================
// SMI-4193: Smoke-test export drift (Check 29)
// ============================================================================

describe('parseTsExports', () => {
  it('extracts named exports from export { ... }', () => {
    const src = `export { Foo, Bar as Baz, type Qux } from './x.js'\nexport { Alone }`
    const { names, starFrom } = parseTsExports(src)
    expect([...names].sort()).toEqual(['Alone', 'Baz', 'Foo', 'Qux'])
    expect(starFrom).toEqual([])
  })

  it('extracts function/const/class/enum/interface/type declarations', () => {
    const src = `
      export function foo() {}
      export async function asyncFoo() {}
      export const bar = 1
      export class Baz {}
      export enum MyEnum {}
      export interface MyIface {}
      export type MyType = string
    `
    const { names } = parseTsExports(src)
    expect([...names].sort()).toEqual(
      ['MyEnum', 'MyIface', 'MyType', 'asyncFoo', 'bar', 'Baz', 'foo'].sort()
    )
  })

  it('records export * from chains in starFrom, not names', () => {
    const src = `export * from './exports/services.js'\nexport * from './exports/repositories.js'`
    const { names, starFrom } = parseTsExports(src)
    expect(names.size).toBe(0)
    expect(starFrom).toEqual(['./exports/services.js', './exports/repositories.js'])
  })

  it('ignores exports inside block comments (SMI-4189 pattern)', () => {
    const src = `/* export { Removed } from './old.js' */\nexport { Kept }`
    const { names } = parseTsExports(src)
    expect([...names]).toEqual(['Kept'])
  })
})

describe('collectTsEntryExports', () => {
  it('walks export * chains and unions all names', () => {
    const files: Record<string, string> = {
      '/src/index.ts': `export * from './barrel.js'\nexport { Direct }`,
      '/src/barrel.ts': `export { Nested1, Nested2 }`,
    }
    const readFile = (p: string) => files[p] ?? null
    const resolveModule = (from: string, spec: string) => {
      if (from === '/src/index.ts' && spec === './barrel.js') return '/src/barrel.ts'
      return null
    }
    const result = collectTsEntryExports('/src/index.ts', readFile, resolveModule)
    expect([...result].sort()).toEqual(['Direct', 'Nested1', 'Nested2'])
  })

  it('tolerates unresolvable barrels without throwing', () => {
    const files: Record<string, string> = {
      '/src/index.ts': `export * from './missing.js'\nexport { Kept }`,
    }
    const readFile = (p: string) => files[p] ?? null
    const resolveModule = () => null
    const result = collectTsEntryExports('/src/index.ts', readFile, resolveModule)
    expect([...result]).toEqual(['Kept'])
  })

  it('guards against circular export * chains', () => {
    const files: Record<string, string> = {
      '/a.ts': `export * from './b.js'\nexport { FromA }`,
      '/b.ts': `export * from './a.js'\nexport { FromB }`,
    }
    const readFile = (p: string) => files[p] ?? null
    const resolveModule = (_from: string, spec: string) =>
      spec === './a.js' ? '/a.ts' : spec === './b.js' ? '/b.ts' : null
    const result = collectTsEntryExports('/a.ts', readFile, resolveModule)
    expect([...result].sort()).toEqual(['FromA', 'FromB'])
  })
})

describe('extractSmokeTestRequiredArrays', () => {
  it('captures names from every required array with stable arrayIndex', () => {
    const src = `
      const required = ['A', 'B', 'C']
      // later
      const required = [
        'D',
        'E'
      ]
    `
    const out = extractSmokeTestRequiredArrays(src)
    expect(out).toEqual([
      { name: 'A', arrayIndex: 0 },
      { name: 'B', arrayIndex: 0 },
      { name: 'C', arrayIndex: 0 },
      { name: 'D', arrayIndex: 1 },
      { name: 'E', arrayIndex: 1 },
    ])
  })

  it('ignores required arrays that appear only inside comments', () => {
    const src = `// const required = ['Commented']\nconst required = ['Real']`
    const out = extractSmokeTestRequiredArrays(src)
    expect(out).toEqual([{ name: 'Real', arrayIndex: 0 }])
  })

  it('returns empty array when no required declarations exist', () => {
    const src = `const something = ['NotRequired']`
    expect(extractSmokeTestRequiredArrays(src)).toEqual([])
  })

  it('detects SMI-4189 regression: CategoryRepository drift against a mock core', () => {
    // Simulates the exact pattern that shipped in smoke-test@0.4.4 and caused
    // the failed republish. The `required` array references `CategoryRepository`,
    // but the mock core only exports `SkillRepository`.
    const smokeSrc = `const required = ['SkillRepository', 'CategoryRepository', 'createDatabaseSync']`
    const files: Record<string, string> = {
      '/core/index.ts': `export { SkillRepository, createDatabaseSync }`,
    }
    const coreExports = collectTsEntryExports(
      '/core/index.ts',
      (p) => files[p] ?? null,
      () => null
    )
    const entries = extractSmokeTestRequiredArrays(smokeSrc)
    const missing = entries.filter((e) => !coreExports.has(e.name))
    expect(missing.map((m) => m.name)).toEqual(['CategoryRepository'])
  })
})
