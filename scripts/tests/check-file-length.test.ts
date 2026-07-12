/**
 * Tests for the pre-commit file-length hook and its grandfather
 * ignore-list (SMI-4397).
 *
 * The hook has had zero tests until now. Coverage targets every case the
 * SMI-4397 plan enumerates:
 *   - over-limit file fails (enforcement intact)
 *   - under-limit file passes
 *   - ignore-listed over-limit path is skipped
 *   - an ABSOLUTE-path argument matches a repo-relative ignore entry
 *     (the plan-review C1 failure mode — fails a naive string-equality impl)
 *   - comment / blank / trailing-whitespace / CRLF lines tolerated
 *   - a grandfathered file now UNDER 500 lines re-enters enforcement (H1)
 *   - absent ignore-list degrades gracefully (all files checked)
 *
 * Fixtures use temp directories (Date.now() + random suffix), never real
 * repo files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import picomatch from 'picomatch'
// @ts-expect-error - .mjs script has no typings
import { parseIgnoreList, checkFiles, loadIgnoreList } from '../check-file-length.mjs'
// @ts-expect-error - .js config has no typings
import lintStagedConfig from '../../lint-staged.config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = resolve(__dirname, '..', 'check-file-length.mjs')

/** Create a unique temp directory for a fixture repo. */
function makeTempDir(): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return mkdtempSync(join(tmpdir(), `check-file-length-${suffix}-`))
}

/** Build a .ts file with exactly `lines` lines under `root`. */
function writeTsFile(root: string, relPath: string, lines: number): string {
  const abs = join(root, relPath)
  mkdirSync(dirname(abs), { recursive: true })
  // `lines` lines == `lines - 1` newline characters via split('\n').length.
  const body = Array.from({ length: lines }, (_, i) => `const x${i} = ${i}`).join('\n')
  writeFileSync(abs, body, 'utf8')
  return abs
}

/**
 * Build a .sh file with exactly `lines` lines under `root` (SMI-5658 .sh
 * routing coverage). Content need not be valid bash since the hook only
 * counts lines; a shebang + comment-body reads plausibly.
 */
function writeShFile(root: string, relPath: string, lines: number): string {
  const abs = join(root, relPath)
  mkdirSync(dirname(abs), { recursive: true })
  const contentLines = [
    '#!/usr/bin/env bash',
    ...Array.from({ length: Math.max(lines - 1, 0) }, (_, i) => `# line ${i}`),
  ]
  writeFileSync(abs, contentLines.join('\n'), 'utf8')
  return abs
}

describe('parseIgnoreList', () => {
  it('tolerates comments, blank lines, trailing whitespace, and CRLF', () => {
    const raw = [
      '# header comment',
      '',
      '   ',
      '# SMI-4948 split follow-up',
      'supabase/functions/indexer/index.test.ts   ', // trailing whitespace
      'supabase/functions/_shared/ops-report-templates.ts\r', // CRLF
      '#trailing comment',
    ].join('\n')

    const entries = parseIgnoreList(raw)

    expect(entries.has('supabase/functions/indexer/index.test.ts')).toBe(true)
    expect(entries.has('supabase/functions/_shared/ops-report-templates.ts')).toBe(true)
    expect(entries.has('# header comment')).toBe(false)
    expect(entries.size).toBe(2)
    // SMI-5658 Step 6: each entry carries the SMI ref from its immediately
    // preceding `# SMI-XXXX split follow-up` comment (or null if absent).
    expect(entries.get('supabase/functions/indexer/index.test.ts')).toBe('SMI-4948')
    expect(entries.get('supabase/functions/_shared/ops-report-templates.ts')).toBe(null)
  })

  it('does not leak a ref from a parenthesized "cleared" block onto a later comment-less path', () => {
    // SMI-5658 Step 6: SMI_FOLLOW_UP_RE only matches `# SMI-XXXX split
    // follow-up` immediately after '#\s*' — a cleared block's leading
    // '(' (the real ignore file's convention for historical entries,
    // e.g. "# (SMI-5036 split follow-up cleared ...)") must NOT match,
    // or its ref would attach to an unrelated path below it.
    const raw = [
      '# (SMI-9999 split follow-up cleared 2026-08-01: foo was split)',
      '',
      'packages/core/tests/no-preceding-comment.test.ts',
    ].join('\n')

    const entries = parseIgnoreList(raw)

    expect(entries.get('packages/core/tests/no-preceding-comment.test.ts')).toBe(null)
  })

  it('returns an empty map for empty input', () => {
    expect(parseIgnoreList('').size).toBe(0)
  })
})

describe('loadIgnoreList', () => {
  it('returns an empty map when the ignore file is absent', () => {
    const dir = makeTempDir()
    try {
      const entries = loadIgnoreList(join(dir, 'does-not-exist.ignore'))
      expect(entries.size).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('checkFiles', () => {
  let root: string

  beforeEach(() => {
    root = makeTempDir()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('flags an over-limit file as a violation', () => {
    const abs = writeTsFile(root, 'src/big.ts', 600)
    const { violations, skipped } = checkFiles([abs], new Map(), root)
    expect(violations).toHaveLength(1)
    expect(violations[0].relPath).toBe('src/big.ts')
    expect(violations[0].lineCount).toBe(600)
    expect(skipped).toHaveLength(0)
  })

  it('passes an under-limit file with no violations', () => {
    const abs = writeTsFile(root, 'src/small.ts', 300)
    const { violations, skipped, delistable } = checkFiles([abs], new Map(), root)
    expect(violations).toHaveLength(0)
    expect(skipped).toHaveLength(0)
    expect(delistable).toHaveLength(0)
  })

  it('skips an ignore-listed over-limit path instead of failing', () => {
    const abs = writeTsFile(root, 'supabase/functions/indexer/index.test.ts', 977)
    const ignoreList = new Map([['supabase/functions/indexer/index.test.ts', 'SMI-4948']])
    const { violations, skipped } = checkFiles([abs], ignoreList, root)
    expect(violations).toHaveLength(0)
    expect(skipped).toHaveLength(1)
    expect(skipped[0].relPath).toBe('supabase/functions/indexer/index.test.ts')
    expect(skipped[0].smiRef).toBe('SMI-4948')
  })

  it('matches an ABSOLUTE-path argument against a repo-relative ignore entry (C1)', () => {
    // lint-staged v16 passes absolute paths; the ignore file stores
    // repo-relative. A naive string-equality impl would treat the
    // absolute path as unmatched and fail the commit.
    const abs = writeTsFile(root, 'supabase/functions/indexer/index.test.ts', 977)
    expect(resolve(abs)).toBe(abs) // sanity: abs really is absolute
    const ignoreList = new Map([['supabase/functions/indexer/index.test.ts', 'SMI-4948']])
    const { violations, skipped } = checkFiles([abs], ignoreList, root)
    expect(violations).toHaveLength(0)
    expect(skipped).toHaveLength(1)
  })

  it('re-enforces a grandfathered file once it drops below the limit (H1)', () => {
    const abs = writeTsFile(root, 'supabase/functions/indexer/index.test.ts', 420)
    const ignoreList = new Map([['supabase/functions/indexer/index.test.ts', 'SMI-4948']])
    const { violations, skipped, delistable } = checkFiles([abs], ignoreList, root)
    expect(violations).toHaveLength(0)
    expect(skipped).toHaveLength(0)
    expect(delistable).toHaveLength(1)
    expect(delistable[0].relPath).toBe('supabase/functions/indexer/index.test.ts')
    expect(delistable[0].lineCount).toBe(420)
  })

  it('checks every file when the ignore-list is empty', () => {
    const abs = writeTsFile(root, 'supabase/functions/indexer/index.test.ts', 977)
    const { violations } = checkFiles([abs], new Map(), root)
    expect(violations).toHaveLength(1)
  })
})

/**
 * End-to-end exercise of the script as lint-staged invokes it: spawn the
 * real .mjs against a temp repo whose scripts/check-file-length.ignore is
 * a fixture. The script resolves repoRoot from its own location, so the
 * script copy must live inside the fixture repo.
 */
describe('check-file-length.mjs (end-to-end)', () => {
  let root: string

  beforeEach(() => {
    root = makeTempDir()
    mkdirSync(join(root, 'scripts'), { recursive: true })
    cpSync(SCRIPT_PATH, join(root, 'scripts', 'check-file-length.mjs'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function runHook(args: string[]): { status: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync(
        'node',
        [join(root, 'scripts', 'check-file-length.mjs'), ...args],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      )
      return { status: 0, stdout, stderr: '' }
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string }
      return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
    }
  }

  it('exits 0 with no arguments', () => {
    expect(runHook([]).status).toBe(0)
  })

  it('exits 1 for a non-grandfathered over-limit file', () => {
    const abs = writeTsFile(root, 'packages/core/src/foo.ts', 600)
    const { status, stderr } = runHook([abs])
    expect(status).toBe(1)
    expect(stderr).toContain('packages/core/src/foo.ts')
    expect(stderr).toContain('600 lines')
  })

  it('exits 1 for a non-grandfathered over-limit .sh file (SMI-5658 routing)', () => {
    const abs = writeShFile(root, 'scripts/oversized.sh', 600)
    const { status, stderr } = runHook([abs])
    expect(status).toBe(1)
    expect(stderr).toContain('scripts/oversized.sh')
    expect(stderr).toContain('600 lines')
  })

  it('exits 0 and prints a skip notice naming the correct SMI ref for a grandfathered over-limit file (absolute path)', () => {
    // SMI-5658 Step 6: the ignore file's own `# SMI-XXXX split follow-up`
    // comment must drive the message, not a hardcoded issue number. Uses
    // SMI-5211, one of the two live ignore-list entries.
    writeFileSync(
      join(root, 'scripts', 'check-file-length.ignore'),
      '# SMI-5211 split follow-up\nsupabase/functions/indexer/index.test.ts\n',
      'utf8'
    )
    const abs = writeTsFile(root, 'supabase/functions/indexer/index.test.ts', 977)
    const { status, stdout } = runHook([abs])
    expect(status).toBe(0)
    expect(stdout).toContain(
      'supabase/functions/indexer/index.test.ts: skipped (grandfathered — SMI-5211 split pending)'
    )
  })

  it('exits 0 and prints the generic fallback notice when a grandfathered path has no preceding SMI comment', () => {
    // SMI-5658 Step 6 defensive fallback: a grandfathered path added
    // without the ignore-list's own `# SMI-XXXX split follow-up`
    // convention still gets skipped, but the message degrades gracefully
    // instead of naming a wrong/hardcoded issue.
    writeFileSync(
      join(root, 'scripts', 'check-file-length.ignore'),
      'supabase/functions/indexer/index.test.ts\n',
      'utf8'
    )
    const abs = writeTsFile(root, 'supabase/functions/indexer/index.test.ts', 977)
    const { status, stdout } = runHook([abs])
    expect(status).toBe(0)
    expect(stdout).toContain(
      'supabase/functions/indexer/index.test.ts: skipped (grandfathered — see scripts/check-file-length.ignore for the tracking issue)'
    )
  })

  it('exits 0 and prints an eligible-to-de-list notice once a grandfathered file is under the limit (H1)', () => {
    writeFileSync(
      join(root, 'scripts', 'check-file-length.ignore'),
      '# SMI-4948 split follow-up\nsupabase/functions/indexer/index.test.ts\n',
      'utf8'
    )
    const abs = writeTsFile(root, 'supabase/functions/indexer/index.test.ts', 410)
    const { status, stdout } = runHook([abs])
    expect(status).toBe(0)
    expect(stdout).toContain('eligible to de-list')
  })

  it('still fails an over-limit file when the ignore-list file is absent', () => {
    const abs = writeTsFile(root, 'supabase/functions/indexer/index.test.ts', 977)
    const { status } = runHook([abs])
    expect(status).toBe(1)
  })
})

/**
 * Guards the routing layer directly, not just the script (SMI-5658
 * plan-review resolution): a future revert of the glob key from
 * '*.{ts,sh}' back to '*.ts' would leave the script-level tests above
 * green while silently reintroducing the SMI-5658 bug. Uses picomatch
 * with the same option set lint-staged itself passes
 * (node_modules/lint-staged/lib/matchFiles.js: dot, matchBase,
 * posixSlashes, strictBrackets) so this test's notion of a "match"
 * doesn't diverge from lint-staged's real behavior (e.g. dotfiles).
 */
describe('lint-staged.config.js glob', () => {
  const config = lintStagedConfig as Record<string, unknown>

  /**
   * Every lint-staged.config.js key whose glob matches `filename`, using
   * the same picomatch options lint-staged itself uses. A single filename
   * can legitimately match more than one key (e.g. a .ts file matches
   * both the eslint/prettier key and the length-check key) — do not
   * assume a unique match.
   */
  function matchingKeys(filename: string): string[] {
    return Object.keys(config).filter((pattern) => {
      const isMatch = picomatch(pattern, {
        dot: true,
        matchBase: !pattern.includes('/'),
        posixSlashes: true,
        strictBrackets: true,
      })
      return isMatch(filename)
    })
  }

  it('routes a .sh path through the length-check key (SMI-5658)', () => {
    const keys = matchingKeys('foo.sh')
    expect(keys).toContain('*.{ts,sh}')

    const tasks = config['*.{ts,sh}'] as string[]
    expect(tasks).toContain('node scripts/check-file-length.mjs')
  })

  it('still routes a .ts path through the length-check key (no regression)', () => {
    const keys = matchingKeys('foo.ts')
    expect(keys).toContain('*.{ts,sh}')
  })
})
