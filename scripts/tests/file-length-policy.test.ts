/**
 * Tests for the shared file-length policy module (SMI-5992).
 *
 * scripts/file-length-policy.mjs exports MAX_LINES and
 * isExemptFromLengthCheck(path) — the threshold + test-file exemption
 * predicate shared between scripts/check-file-length.mjs (pre-commit,
 * hard-fail) and scripts/audit-standards.mjs Check 3 (CI, warn-only).
 * Scope and severity are deliberately NOT shared (SMI-5994 tracks that).
 *
 * The predicate is a deliberate decision (not an oversight): it matches
 * both `.test.` and `.spec.` — this repo's own test-file recognition
 * elsewhere (audit-standards.mjs's own Check 4, CLAUDE.md's "Test File
 * Locations" table) already treats `.spec.` as the same category as
 * `.test.`.
 */
import { describe, it, expect } from 'vitest'
import { MAX_LINES, isExemptFromLengthCheck } from '../file-length-policy.mjs'

describe('file-length-policy: MAX_LINES', () => {
  it('is the documented 500-line threshold', () => {
    expect(MAX_LINES).toBe(500)
  })
})

describe('file-length-policy: isExemptFromLengthCheck', () => {
  it('exempts a .test.ts path', () => {
    expect(isExemptFromLengthCheck('packages/core/src/foo.test.ts')).toBe(true)
  })

  it('exempts a .spec.ts path', () => {
    expect(isExemptFromLengthCheck('packages/mcp-server/src/bar.spec.ts')).toBe(true)
  })

  it('does not exempt a plain, non-test .ts path', () => {
    expect(isExemptFromLengthCheck('packages/core/src/foo.ts')).toBe(false)
  })

  it('exempts a .test.tsx path', () => {
    expect(isExemptFromLengthCheck('packages/website/src/components/Foo.test.tsx')).toBe(true)
  })

  it('exempts a .spec.tsx path', () => {
    expect(isExemptFromLengthCheck('packages/website/src/components/Bar.spec.tsx')).toBe(true)
  })

  it('does not exempt a .d.ts declaration file (no .test. or .spec. substring)', () => {
    expect(isExemptFromLengthCheck('packages/core/dist/foo.d.ts')).toBe(false)
  })

  it('exempts an absolute path containing .test.', () => {
    expect(isExemptFromLengthCheck('/repo/packages/core/src/foo.test.ts')).toBe(true)
  })

  it('exempts a .sh test file (pre-commit also scans .sh)', () => {
    expect(isExemptFromLengthCheck('scripts/tests/deploy.test.sh')).toBe(true)
  })

  it('does NOT exempt a non-test file living under a marker-like directory name (code-review finding)', () => {
    // packages/foo.test.fixtures/ is a real directory NAME, not a test file —
    // matching the full path here would wrongly exempt runtime.ts, which is
    // a genuine production file and should still be length-checked.
    expect(isExemptFromLengthCheck('packages/foo.test.fixtures/src/runtime.ts')).toBe(false)
  })

  it('does NOT exempt a non-test file under a .spec.-named directory', () => {
    expect(isExemptFromLengthCheck('packages/bar.spec.data/src/loader.ts')).toBe(false)
  })

  it('still exempts a real test file that happens to live under such a directory', () => {
    expect(isExemptFromLengthCheck('packages/foo.test.fixtures/src/runtime.test.ts')).toBe(true)
  })
})
