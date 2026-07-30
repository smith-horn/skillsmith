/**
 * @fileoverview Unit tests for the security-acceptance store (SMI-5883 §9).
 * @module @skillsmith/mcp-server/audit/security-acceptance.test
 *
 * Covers H-3 (stale-acceptance invalidation via the key, tested at the
 * fingerprint/key level), H-7 (corrupt-store fail-open), and H-14
 * (fingerprint boundary shift / injective serialization), plus the store
 * load/mutate mechanics those hazards depend on.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { SecurityFinding } from '@skillsmith/core'
import { SCANNER_RULESET_VERSION } from '@skillsmith/core'

import {
  computeAcceptKey,
  computeStoreDigest,
  findingFingerprint,
  fingerprintTuple,
  isValidAcceptKeyFormat,
  loadAcceptanceStore,
} from './security-acceptance.js'
import { acceptFinding, revokeAcceptance } from './security-acceptance.mutate.js'
import { MAX_RECORDS, MAX_STORE_BYTES } from './security-acceptance.types.js'
import type { AcceptanceRecord } from './security-acceptance.types.js'

let tmpDir: string
let storePath: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-acceptance-'))
  storePath = path.join(tmpDir, 'security-acceptance.json')
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function finding(overrides: Partial<SecurityFinding> = {}): SecurityFinding {
  return {
    type: 'jailbreak',
    severity: 'high',
    message: 'msg',
    ...overrides,
  }
}

// Records built with the REAL current ruleset version so they survive the
// mutation path's on-write GC (which drops any record whose rulesetVersion
// !== SCANNER_RULESET_VERSION) -- tests that specifically exercise a STALE
// ruleset version pass one explicitly via `overrides`.
//
// `acceptKey` is auto-derived from the ACTUAL (possibly overridden)
// contentDigest/findingFingerprint/rulesetVersion, not from hardcoded
// defaults -- code-review round 2 finding 3 added a check that a stored
// record's acceptKey must match its own triple, and a test fixture whose
// acceptKey was computed from different values than its own fields is
// exactly the internally-inconsistent shape that check now (correctly)
// rejects. A caller may still override `acceptKey` explicitly (e.g. to test
// a genuinely malformed/inconsistent record on purpose).
function record(overrides: Partial<AcceptanceRecord> = {}): AcceptanceRecord {
  const contentDigest = overrides.contentDigest ?? 'a'.repeat(64)
  const fp = overrides.findingFingerprint ?? findingFingerprint(finding())
  const rulesetVersion = overrides.rulesetVersion ?? SCANNER_RULESET_VERSION
  const acceptKey =
    overrides.acceptKey ??
    computeAcceptKey({ contentDigest, findingFingerprint: fp, rulesetVersion })
  return {
    acceptKey,
    sourcePath: '/skills/foo/SKILL.md',
    identifier: 'foo',
    contentDigest,
    findingFingerprint: fp,
    rulesetVersion,
    display: {
      type: 'jailbreak',
      severity: 'high',
      message: 'msg',
      location: null,
      lineNumber: null,
    },
    acceptedAt: '2026-07-01T00:00:00.000Z',
    reason: 'reviewed, false positive',
    ...overrides,
  }
}

// --- H-14: fingerprint boundary shift / injective serialization -----------

describe('findingFingerprint -- injective serialization (H-14)', () => {
  it('(a) category/message boundary shift does not collide', () => {
    const a = finding({ category: 'a|b', message: 'c' })
    const b = finding({ category: 'a', message: 'b|c' })
    expect(findingFingerprint(a)).not.toBe(findingFingerprint(b))
  })

  it('(b) the same boundary-shift class with : and NUL as separator candidates', () => {
    const a1 = finding({ category: 'a:b', message: 'c' })
    const b1 = finding({ category: 'a', message: 'b:c' })
    expect(findingFingerprint(a1)).not.toBe(findingFingerprint(b1))

    const a2 = finding({ category: 'a\0b', message: 'c' })
    const b2 = finding({ category: 'a', message: 'b\0c' })
    expect(findingFingerprint(a2)).not.toBe(findingFingerprint(b2))
  })

  it('(c) a JSON-syntax injection attempt in message does not collide with a real field split', () => {
    const a = finding({ message: 'x","y' })
    const b = finding({ message: 'x', location: 'y' })
    expect(findingFingerprint(a)).not.toBe(findingFingerprint(b))
  })

  it('(d) absent location normalizes to null, not "" -- must differ', () => {
    const a = finding({ location: undefined })
    const b = finding({ location: '' })
    expect(findingFingerprint(a)).not.toBe(findingFingerprint(b))
  })

  it('(e) absent lineNumber normalizes to null, not 0 -- must differ', () => {
    const a = finding({ lineNumber: undefined })
    const b = finding({ lineNumber: 0 })
    expect(findingFingerprint(a)).not.toBe(findingFingerprint(b))
  })

  it('fingerprintTuple always has exactly 9 elements', () => {
    expect(fingerprintTuple(finding())).toHaveLength(9)
    expect(fingerprintTuple(finding({ category: undefined, filePath: undefined }))).toHaveLength(9)
  })

  it('property: 5000 finding pairs, each guaranteed-distinct by construction, never collide', () => {
    // Each finding embeds its own loop index into `message`, so every 9-tuple
    // is guaranteed distinct BY CONSTRUCTION (unlike drawing every field from
    // a tiny alphabet, which would legitimately produce the odd genuine
    // duplicate tuple by chance -- that would be a correct non-collision,
    // not a bug, and would make this property test flaky/meaningless). The
    // adversarial alphabet still stresses every OTHER field's escaping.
    const alphabet = [' ', '\\', ',', '[', ']', '{', '}', ':', '"', '\0', '\uD800', 'a', 'b', '|']
    const rand = (): string =>
      Array.from(
        { length: 1 + Math.floor(Math.random() * 6) },
        () => alphabet[Math.floor(Math.random() * alphabet.length)]
      ).join('')
    const seen = new Set<string>()
    for (let i = 0; i < 5000; i++) {
      const f = finding({
        category: Math.random() < 0.5 ? rand() : undefined,
        message: `${rand()}#${i}`,
        location: Math.random() < 0.5 ? rand() : undefined,
        lineNumber: Math.random() < 0.5 ? Math.floor(Math.random() * 1000) : undefined,
        filePath: Math.random() < 0.5 ? rand() : undefined,
        severity: (['low', 'medium', 'high', 'critical'] as const)[Math.floor(Math.random() * 4)],
      })
      expect(fingerprintTuple(f)).toHaveLength(9)
      const fp = findingFingerprint(f)
      expect(seen.has(fp)).toBe(false)
      seen.add(fp)
    }
    expect(seen.size).toBe(5000)
  })
})

// --- H-3: stale acceptance invalidation (via the key's own composition) ---

describe('computeAcceptKey -- INV-3 (any invalidating change yields a different key)', () => {
  it('a content-digest change yields a different key', () => {
    const fp = findingFingerprint(finding())
    const k1 = computeAcceptKey({
      contentDigest: 'a'.repeat(64),
      findingFingerprint: fp,
      rulesetVersion: 'v1',
    })
    const k2 = computeAcceptKey({
      contentDigest: 'b'.repeat(64),
      findingFingerprint: fp,
      rulesetVersion: 'v1',
    })
    expect(k1).not.toBe(k2)
  })

  it('a finding-message change (new fingerprint) yields a different key', () => {
    const digest = 'a'.repeat(64)
    const k1 = computeAcceptKey({
      contentDigest: digest,
      findingFingerprint: findingFingerprint(finding()),
      rulesetVersion: 'v1',
    })
    const k2 = computeAcceptKey({
      contentDigest: digest,
      findingFingerprint: findingFingerprint(finding({ message: 'a different message' })),
      rulesetVersion: 'v1',
    })
    expect(k1).not.toBe(k2)
  })

  it('a ruleset-version change yields a different key', () => {
    const digest = 'a'.repeat(64)
    const fp = findingFingerprint(finding())
    const k1 = computeAcceptKey({
      contentDigest: digest,
      findingFingerprint: fp,
      rulesetVersion: 'v1',
    })
    const k2 = computeAcceptKey({
      contentDigest: digest,
      findingFingerprint: fp,
      rulesetVersion: 'v2',
    })
    expect(k1).not.toBe(k2)
  })

  it('validates the 64-hex format', () => {
    expect(isValidAcceptKeyFormat('a'.repeat(64))).toBe(true)
    expect(isValidAcceptKeyFormat('a'.repeat(63))).toBe(false)
    expect(isValidAcceptKeyFormat('g'.repeat(64))).toBe(false)
  })
})

// --- H-7: corrupt/oversized/malformed store -> fail open, never throw ----

describe('loadAcceptanceStore -- fail-open (H-7)', () => {
  it('absent file -> empty store, no warning', () => {
    const { store, warnings } = loadAcceptanceStore(storePath)
    expect(store.records).toEqual([])
    expect(warnings).toEqual([])
  })

  it('garbage bytes -> empty store, acceptance_store_unreadable', () => {
    fs.writeFileSync(storePath, 'not json {{{')
    const { store, warnings } = loadAcceptanceStore(storePath)
    expect(store.records).toEqual([])
    expect(warnings.map((w) => w.code)).toContain('acceptance_store_unreadable')
  })

  it('truncated JSON -> empty store, acceptance_store_unreadable', () => {
    fs.writeFileSync(storePath, '{"version":1,"revision":0,"records":[')
    const { store, warnings } = loadAcceptanceStore(storePath)
    expect(store.records).toEqual([])
    expect(warnings.map((w) => w.code)).toContain('acceptance_store_unreadable')
  })

  it('wrong version -> empty store, acceptance_store_unreadable', () => {
    fs.writeFileSync(
      storePath,
      JSON.stringify({ version: 99, revision: 0, storeDigest: '', records: [] })
    )
    const { store, warnings } = loadAcceptanceStore(storePath)
    expect(store.records).toEqual([])
    expect(warnings.map((w) => w.code)).toContain('acceptance_store_unreadable')
  })

  it('mismatched storeDigest -> empty store, acceptance_store_digest_mismatch', () => {
    const shell = { version: 1 as const, revision: 0, records: [record()] }
    fs.writeFileSync(storePath, JSON.stringify({ ...shell, storeDigest: 'deadbeef' }))
    const { store, warnings } = loadAcceptanceStore(storePath)
    expect(store.records).toEqual([])
    expect(warnings.map((w) => w.code)).toContain('acceptance_store_digest_mismatch')
  })

  it('5 MiB file -> empty store, acceptance_store_oversized, never throws', () => {
    const huge = 'x'.repeat(MAX_STORE_BYTES + 1024)
    fs.writeFileSync(storePath, huge)
    expect(() => loadAcceptanceStore(storePath)).not.toThrow()
    const { store, warnings } = loadAcceptanceStore(storePath)
    expect(store.records).toEqual([])
    expect(warnings.map((w) => w.code)).toContain('acceptance_store_oversized')
  })

  it('a filesystem error past open() (fstat/read) never throws -- degrades to empty store, acceptance_store_unreadable (code-review round 2)', () => {
    // Round 2 finding 1: the original readStoreBounded caught ONLY openSync
    // failures; an fstatSync/readSync/closeSync error below that point
    // escaped uncaught and crashed the whole CLI. `openSync` on a directory
    // succeeds on POSIX, but `readSync`ing a directory fd reliably fails with
    // EISDIR -- a real, deterministic way to exercise the past-open failure
    // path without mocking node:fs.
    fs.mkdirSync(storePath) // storePath now names a directory, not a file
    expect(() => loadAcceptanceStore(storePath)).not.toThrow()
    const { store, warnings } = loadAcceptanceStore(storePath)
    expect(store.records).toEqual([])
    expect(warnings.map((w) => w.code)).toContain('acceptance_store_unreadable')
  })

  it('a non-ENOENT open() failure is distinguished from absent -- still degrades to empty store with a warning, not silent absence', () => {
    // Round 2 finding 1's other half: the original catch swallowed EVERY
    // openSync error as "absent, no warning" -- indistinguishable from the
    // ordinary first-run case. Only ENOENT should mean absent. EACCES can't
    // be exercised portably here (this repo's own containers run as root,
    // which bypasses permission bits) -- ENAMETOOLONG is a root-independent
    // way to force a real, non-ENOENT openSync failure: a path component
    // over NAME_MAX (255 on ext4 and most Linux filesystems).
    const tooLongPath = path.join(tmpDir, 'x'.repeat(1000))
    expect(() => loadAcceptanceStore(tooLongPath)).not.toThrow()
    const { store, warnings } = loadAcceptanceStore(tooLongPath)
    expect(store.records).toEqual([])
    expect(warnings.map((w) => w.code)).toContain('acceptance_store_unreadable')
  })

  it('a well-formed store round-trips through save + load with a valid digest', () => {
    const r = record()
    const shell = { version: 1 as const, revision: 3, records: [r] }
    const storeDigest = computeStoreDigest(shell)
    fs.writeFileSync(storePath, JSON.stringify({ ...shell, storeDigest }))
    const { store, warnings } = loadAcceptanceStore(storePath)
    expect(warnings).toEqual([])
    expect(store.revision).toBe(3)
    expect(store.records).toHaveLength(1)
    expect(store.records[0]?.acceptKey).toBe(r.acceptKey)
  })

  it('malformed records within an otherwise-valid store are dropped individually with a count', () => {
    const good = record()
    const bad = { ...record(), acceptKey: 'not-hex' }
    const shell = { version: 1 as const, revision: 0, records: [good, bad] }
    const storeDigest = computeStoreDigest(
      shell as unknown as { version: number; revision: number; records: AcceptanceRecord[] }
    )
    fs.writeFileSync(storePath, JSON.stringify({ ...shell, storeDigest }))
    const { store, warnings } = loadAcceptanceStore(storePath)
    expect(store.records).toHaveLength(1)
    expect(store.records[0]?.acceptKey).toBe(good.acceptKey)
    const w = warnings.find((x) => x.code === 'acceptance_records_malformed')
    expect(w?.count).toBe(1)
  })

  it('an internally-inconsistent record (well-formatted acceptKey that does not match its own triple) is dropped as malformed (code-review round 2)', () => {
    // Matching (security-audit.candidates.ts) resolves purely on acceptKey,
    // never re-deriving it from the record's own (contentDigest,
    // findingFingerprint, rulesetVersion). Without this check, a record like
    // this one -- correctly SHAPED, but whose acceptKey does not actually
    // correspond to its own fields -- would load successfully and could
    // suppress a completely unrelated finding if its acceptKey value ever
    // collided with that finding's own, honestly-computed key.
    const good = record()
    const inconsistent = record({
      // A well-formed 64-hex key, but NOT computeAcceptKey() of the fields below.
      acceptKey: 'f'.repeat(64),
      contentDigest: 'c'.repeat(64),
    })
    const shell = { version: 1 as const, revision: 0, records: [good, inconsistent] }
    const storeDigest = computeStoreDigest(shell)
    fs.writeFileSync(storePath, JSON.stringify({ ...shell, storeDigest }))
    const { store, warnings } = loadAcceptanceStore(storePath)
    expect(store.records).toHaveLength(1)
    expect(store.records[0]?.acceptKey).toBe(good.acceptKey)
    const w = warnings.find((x) => x.code === 'acceptance_records_malformed')
    expect(w?.count).toBe(1)
  })
})

// --- Mutation mechanics: accept / revoke -----------------------------------

describe('acceptFinding / revokeAcceptance', () => {
  it('accept then load round-trips the record', () => {
    const r = record()
    const outcome = acceptFinding(storePath, r)
    expect(outcome.ok).toBe(true)
    const { store } = loadAcceptanceStore(storePath)
    expect(store.records).toHaveLength(1)
    expect(store.records[0]?.acceptKey).toBe(r.acceptKey)
    expect(store.revision).toBe(1)
  })

  it('re-accepting the same key overwrites, never duplicates', () => {
    const r = record()
    acceptFinding(storePath, r)
    acceptFinding(storePath, { ...r, reason: 'updated reason' })
    const { store } = loadAcceptanceStore(storePath)
    expect(store.records).toHaveLength(1)
    expect(store.records[0]?.reason).toBe('updated reason')
  })

  it('revoke removes a stored record', () => {
    const r = record()
    acceptFinding(storePath, r)
    const outcome = revokeAcceptance(storePath, r.acceptKey)
    expect(outcome.ok).toBe(true)
    const { store } = loadAcceptanceStore(storePath)
    expect(store.records).toEqual([])
  })

  it('revoke a key not present -> key_not_found, store unchanged', () => {
    const r = record()
    acceptFinding(storePath, r)
    const outcome = revokeAcceptance(storePath, 'f'.repeat(64))
    expect(outcome.ok).toBe(false)
    expect(outcome.code).toBe('key_not_found')
    const { store } = loadAcceptanceStore(storePath)
    expect(store.records).toHaveLength(1)
  })

  it('a write GCs records whose rulesetVersion no longer matches SCANNER_RULESET_VERSION', async () => {
    const { SCANNER_RULESET_VERSION } = await import('@skillsmith/core')
    const stale = record({ rulesetVersion: 'ancient-version' })
    const shell = { version: 1 as const, revision: 0, records: [stale] }
    fs.writeFileSync(
      storePath,
      JSON.stringify({ ...shell, storeDigest: computeStoreDigest(shell) })
    )

    const fresh = record({
      contentDigest: 'c'.repeat(64),
      findingFingerprint: findingFingerprint(finding({ message: 'other' })),
      rulesetVersion: SCANNER_RULESET_VERSION,
    })
    const outcome = acceptFinding(storePath, fresh)
    expect(outcome.ok).toBe(true)
    expect(outcome.warnings.map((w) => w.code)).toContain('acceptance_records_ruleset_expired')

    const { store } = loadAcceptanceStore(storePath)
    expect(store.records.map((r) => r.acceptKey)).toEqual([fresh.acceptKey])
  })

  it('a foreign write landing in the gap between the pre-read and the lock is reported, not lost', () => {
    const r1 = record()
    acceptFinding(storePath, r1) // establishes revision 1

    const r2 = record({
      contentDigest: 'b'.repeat(64),
      findingFingerprint: findingFingerprint(finding({ message: 'second' })),
    })

    // Inject a foreign (lock-bypassing) write into the exact gap the
    // foreign-writer detector exists to catch: after acceptFinding's own
    // unlocked pre-read, before it acquires the lock.
    const outcome = acceptFinding(storePath, r2, () => {
      const { store: current } = loadAcceptanceStore(storePath)
      const bumped = {
        version: 1 as const,
        revision: current.revision + 5,
        records: current.records,
      }
      fs.writeFileSync(
        storePath,
        JSON.stringify({ ...bumped, storeDigest: computeStoreDigest(bumped) })
      )
    })

    expect(outcome.ok).toBe(true) // no data lost -- proceeds against current contents
    expect(outcome.warnings.map((w) => w.code)).toContain('acceptance_store_foreign_revision')
    const { store: after } = loadAcceptanceStore(storePath)
    expect(after.records.map((r) => r.acceptKey).sort()).toEqual(
      [r1.acceptKey, r2.acceptKey].sort()
    )
  })

  it('accepting a genuinely new finding when the store is already at MAX_RECORDS never writes more than MAX_RECORDS (code-review round 2)', () => {
    // Round 2 finding: loadAcceptanceStore's cap is load-time only -- a fresh
    // accept when the store was already AT the cap used to WRITE
    // MAX_RECORDS + 1 records, contradicting the "<=500 by construction"
    // invariant the CLI documents, until the next load happened to re-trim
    // it. Seed a store already at exactly MAX_RECORDS via direct file write
    // (bypassing the lock, since this is single-threaded setup, not a race).
    const seeded: AcceptanceRecord[] = []
    for (let i = 0; i < MAX_RECORDS; i++) {
      seeded.push(
        record({
          contentDigest: i.toString(16).padStart(64, '0'),
          findingFingerprint: findingFingerprint(finding({ message: `seed-${i}` })),
          acceptedAt: new Date(2026, 0, 1 + i).toISOString(),
        })
      )
    }
    const shell = { version: 1 as const, revision: 0, records: seeded }
    fs.writeFileSync(
      storePath,
      JSON.stringify({ ...shell, storeDigest: computeStoreDigest(shell) })
    )

    const fresh = record({
      contentDigest: 'f'.repeat(64),
      findingFingerprint: findingFingerprint(finding({ message: 'the new one' })),
      acceptedAt: new Date(2026, 1, 1).toISOString(), // newest -- must survive the cap
    })
    const outcome = acceptFinding(storePath, fresh)
    expect(outcome.ok).toBe(true)
    expect(outcome.warnings.map((w) => w.code)).toContain('acceptance_records_over_capacity')

    // Read the RAW on-disk file directly -- not through loadAcceptanceStore,
    // which would silently re-apply its own trim and mask a write-time bug.
    const onDisk: { records: unknown[] } = JSON.parse(fs.readFileSync(storePath, 'utf-8'))
    expect(onDisk.records).toHaveLength(MAX_RECORDS)
    const { store } = loadAcceptanceStore(storePath)
    expect(store.records.some((r) => r.acceptKey === fresh.acceptKey)).toBe(true)
  })
})
