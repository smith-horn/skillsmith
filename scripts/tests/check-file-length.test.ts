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
// @ts-expect-error - .mjs script has no typings
import { parseIgnoreList, checkFiles, loadIgnoreList } from '../check-file-length.mjs'

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
  })

  it('returns an empty set for empty input', () => {
    expect(parseIgnoreList('').size).toBe(0)
  })
})

describe('loadIgnoreList', () => {
  it('returns an empty set when the ignore file is absent', () => {
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
    const { violations, skipped } = checkFiles([abs], new Set(), root)
    expect(violations).toHaveLength(1)
    expect(violations[0].relPath).toBe('src/big.ts')
    expect(violations[0].lineCount).toBe(600)
    expect(skipped).toHaveLength(0)
  })

  it('passes an under-limit file with no violations', () => {
    const abs = writeTsFile(root, 'src/small.ts', 300)
    const { violations, skipped, delistable } = checkFiles([abs], new Set(), root)
    expect(violations).toHaveLength(0)
    expect(skipped).toHaveLength(0)
    expect(delistable).toHaveLength(0)
  })

  it('skips an ignore-listed over-limit path instead of failing', () => {
    const abs = writeTsFile(root, 'supabase/functions/indexer/index.test.ts', 977)
    const ignoreList = new Set(['supabase/functions/indexer/index.test.ts'])
    const { violations, skipped } = checkFiles([abs], ignoreList, root)
    expect(violations).toHaveLength(0)
    expect(skipped).toHaveLength(1)
    expect(skipped[0].relPath).toBe('supabase/functions/indexer/index.test.ts')
  })

  it('matches an ABSOLUTE-path argument against a repo-relative ignore entry (C1)', () => {
    // lint-staged v16 passes absolute paths; the ignore file stores
    // repo-relative. A naive string-equality impl would treat the
    // absolute path as unmatched and fail the commit.
    const abs = writeTsFile(root, 'supabase/functions/indexer/index.test.ts', 977)
    expect(resolve(abs)).toBe(abs) // sanity: abs really is absolute
    const ignoreList = new Set(['supabase/functions/indexer/index.test.ts'])
    const { violations, skipped } = checkFiles([abs], ignoreList, root)
    expect(violations).toHaveLength(0)
    expect(skipped).toHaveLength(1)
  })

  it('re-enforces a grandfathered file once it drops below the limit (H1)', () => {
    const abs = writeTsFile(root, 'supabase/functions/indexer/index.test.ts', 420)
    const ignoreList = new Set(['supabase/functions/indexer/index.test.ts'])
    const { violations, skipped, delistable } = checkFiles([abs], ignoreList, root)
    expect(violations).toHaveLength(0)
    expect(skipped).toHaveLength(0)
    expect(delistable).toHaveLength(1)
    expect(delistable[0].relPath).toBe('supabase/functions/indexer/index.test.ts')
    expect(delistable[0].lineCount).toBe(420)
  })

  it('checks every file when the ignore-list is empty', () => {
    const abs = writeTsFile(root, 'supabase/functions/indexer/index.test.ts', 977)
    const { violations } = checkFiles([abs], new Set(), root)
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

  it('exits 0 and prints a skip notice for a grandfathered over-limit file (absolute path)', () => {
    writeFileSync(
      join(root, 'scripts', 'check-file-length.ignore'),
      '# SMI-4948 split follow-up\nsupabase/functions/indexer/index.test.ts\n',
      'utf8'
    )
    const abs = writeTsFile(root, 'supabase/functions/indexer/index.test.ts', 977)
    const { status, stdout } = runHook([abs])
    expect(status).toBe(0)
    expect(stdout).toContain('supabase/functions/indexer/index.test.ts: skipped (grandfathered')
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
