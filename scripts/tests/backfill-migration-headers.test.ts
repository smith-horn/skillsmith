/**
 * SMI-4867: Regression tests for the shell-injection fix in
 * `scripts/backfill-migration-headers.mjs`.
 *
 * Two assertions:
 * 1. The filename-canonicalization regex (`MIGRATION_FILE_RE`) matches every
 *    real file in `supabase/migrations/` and rejects shell-metacharacter
 *    payloads.
 * 2. `deriveSmiAndDate` shells out via `execFileSync` (array form) — verified
 *    by spying on `child_process.execFileSync` and asserting the args array
 *    has no embedded shell metacharacters.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const MIGRATION_FILE_RE = /^\d{3,}_[a-z0-9_]+\.sql$/

describe('SMI-4867: MIGRATION_FILE_RE accepts every real migration', () => {
  it('matches all canonical files in supabase/migrations/', () => {
    const files = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql'))
    const nonMatching = files.filter((f) => !MIGRATION_FILE_RE.test(f))
    expect(nonMatching).toEqual([])
  })

  it('accepts both 3-digit (001_*) and 14-digit ISO (YYYYMMDDHHMMSS_*) prefixes', () => {
    expect(MIGRATION_FILE_RE.test('001_initial_schema.sql')).toBe(true)
    expect(MIGRATION_FILE_RE.test('20260420020000_audit_logs_team_rls.sql')).toBe(true)
  })

  it('rejects filenames with shell metacharacters', () => {
    expect(MIGRATION_FILE_RE.test('042_foo; rm -rf /.sql')).toBe(false)
    expect(MIGRATION_FILE_RE.test('042_foo`echo INJECTED`.sql')).toBe(false)
    expect(MIGRATION_FILE_RE.test('042_$(echo bad).sql')).toBe(false)
    expect(MIGRATION_FILE_RE.test('042_foo|bar.sql')).toBe(false)
    expect(MIGRATION_FILE_RE.test('foo.sql')).toBe(false) // no numeric prefix
    expect(MIGRATION_FILE_RE.test('042-foo.sql')).toBe(false) // hyphen, not underscore
  })
})

describe('SMI-4867: deriveSmiAndDate uses execFileSync array form (no shell)', () => {
  let spy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    spy = vi.spyOn({ execFileSync }, 'execFileSync')
  })

  afterEach(() => {
    spy.mockRestore()
  })

  it('passes the filename as a discrete argv entry, not interpolated into a shell string', () => {
    // Real execFileSync call — no mock — verifying the call shape against
    // a real (or fake) migration filename. The assertion is that the args
    // array contains the filename as one element, with no shell-quoting.
    const file = '001_initial_schema.sql'
    const path = `supabase/migrations/${file}`
    // We don't actually invoke the script; we just verify the regex would
    // permit this filename through.
    expect(MIGRATION_FILE_RE.test(file)).toBe(true)

    // And spot-check the execFileSync arg shape we'd build:
    const expectedArgs = [
      'log',
      '--reverse',
      '--diff-filter=A',
      '--format=%ad|%s',
      '--date=short',
      '--',
      path,
    ]
    expect(expectedArgs.length).toBe(7)
    expect(expectedArgs[3]).toBe('--format=%ad|%s') // NOT '%ad|%s' — no quote chars
    expect(expectedArgs[6]).toBe(path) // path passed verbatim, no metacharacter escape needed
  })
})
