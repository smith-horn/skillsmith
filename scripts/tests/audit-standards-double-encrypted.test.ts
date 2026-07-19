/**
 * Tests for the SMI-5740 fix to audit-standards.mjs Check 18
 * ("No Double-Encrypted Files", SMI-2607).
 *
 * Covers `parseGitCryptEncryptedFiles` and `classifyGitCryptScanResult` in
 * audit-standards-helpers.mjs — the pure parsing/decision layer for
 * `git-crypt status` output. Check 18 itself provides the I/O layer
 * (execSync + isGitCryptEncrypted + warn/fail/pass), which, per this repo's
 * established convention (see audit-standards-migration-ordering.test.ts's
 * own note on Check 50), is exercised by actually running the script rather
 * than unit-tested in isolation.
 *
 * The git-crypt magic-header byte check itself (`isGitCryptEncrypted`) is
 * already covered by scripts/tests/check-supply-chain-pins.test.ts and is
 * not re-tested here — this file adds only the one additional case (a
 * binary, non-GITCRYPT-header buffer) that documents the specific regression
 * Check 18's `binaryExtensions` allowlist removal must not reintroduce.
 */
import { describe, expect, it } from 'vitest'

const helpers = (await import('../audit-standards-helpers.mjs')) as {
  parseGitCryptEncryptedFiles: (status: string) => string[]
  classifyGitCryptScanResult: (
    encryptedCount: number,
    doubleEncryptedCount: number
  ) => 'locked' | 'double-encrypted' | 'clean'
}
const { parseGitCryptEncryptedFiles, classifyGitCryptScanResult } = helpers

const pinsMod = (await import('../ci/check-supply-chain-pins.mjs')) as {
  isGitCryptEncrypted: (p: string) => boolean
}
const { isGitCryptEncrypted } = pinsMod

describe('parseGitCryptEncryptedFiles (SMI-5740)', () => {
  it('excludes "not encrypted:" lines even though they contain the substring "encrypted:"', () => {
    const status = [
      '    encrypted: supabase/functions/_shared/api-key-auth.ts',
      'not encrypted: scripts/tests/indexer/parity.test.ts',
    ].join('\n')
    expect(parseGitCryptEncryptedFiles(status)).toEqual([
      'supabase/functions/_shared/api-key-auth.ts',
    ])
  })

  it('handles leading whitespace before "encrypted:"', () => {
    const status = '        encrypted: supabase/migrations/030_foo.sql'
    expect(parseGitCryptEncryptedFiles(status)).toEqual(['supabase/migrations/030_foo.sql'])
  })

  it('ignores empty and trailing blank lines', () => {
    const status = '\n    encrypted: a.ts\n\n\n'
    expect(parseGitCryptEncryptedFiles(status)).toEqual(['a.ts'])
  })

  it('preserves spaces inside the path (does not whitespace-split the path)', () => {
    const status = '    encrypted: supabase/functions/has space/index.ts'
    expect(parseGitCryptEncryptedFiles(status)).toEqual(['supabase/functions/has space/index.ts'])
  })

  it('handles CRLF line endings', () => {
    const status = '    encrypted: a.ts\r\nnot encrypted: b.ts\r\n'
    expect(parseGitCryptEncryptedFiles(status)).toEqual(['a.ts'])
  })

  it('returns an empty array when nothing is encrypted', () => {
    const status = 'not encrypted: a.ts\nnot encrypted: b.ts'
    expect(parseGitCryptEncryptedFiles(status)).toEqual([])
  })

  it('returns multiple paths in the order git-crypt reported them', () => {
    const status = ['    encrypted: a.ts', 'not encrypted: b.ts', '    encrypted: c.ts'].join('\n')
    expect(parseGitCryptEncryptedFiles(status)).toEqual(['a.ts', 'c.ts'])
  })
})

describe('classifyGitCryptScanResult (SMI-5740 — locked vs. double-encrypted)', () => {
  it('classifies as clean when nothing is encrypted', () => {
    expect(classifyGitCryptScanResult(0, 0)).toBe('clean')
  })

  it('classifies as clean when encrypted files exist but none are ciphertext on disk', () => {
    expect(classifyGitCryptScanResult(5, 0)).toBe('clean')
  })

  it('classifies as double-encrypted when only some encrypted-scope files are ciphertext', () => {
    expect(classifyGitCryptScanResult(5, 2)).toBe('double-encrypted')
  })

  it('classifies as locked when ALL encrypted-scope files are still ciphertext', () => {
    expect(classifyGitCryptScanResult(377, 377)).toBe('locked')
  })

  it('documents the known single-file limitation: 1-of-1 reads as locked, not anomaly', () => {
    // With exactly one encrypted-scope file total, a genuine single-file
    // double-encryption anomaly is indistinguishable from a locked repo.
    // Not a concern for this repo's real scope (dozens of files), but pinned
    // here so the tradeoff can't silently regress unnoticed.
    expect(classifyGitCryptScanResult(1, 1)).toBe('locked')
  })

  it('does not misclassify zero encrypted-scope files as locked', () => {
    // encryptedCount === 0 must never satisfy the "all" condition trivially.
    expect(classifyGitCryptScanResult(0, 0)).not.toBe('locked')
  })
})

describe('isGitCryptEncrypted post-binaryExtensions-removal regression (SMI-5740)', () => {
  it('returns false for a binary (non-GITCRYPT-header) buffer written to disk', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'smi-5740-'))
    try {
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const p = join(dir, 'image.png')
      writeFileSync(p, pngHeader)
      // Previously exempted by Check 18's binaryExtensions allowlist purely by
      // extension; now must be correctly not-flagged by the byte-signature
      // check itself, with no allowlist involved.
      expect(isGitCryptEncrypted(p)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
