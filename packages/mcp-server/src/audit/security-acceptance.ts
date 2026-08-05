/**
 * @fileoverview Local security-acceptance store: fingerprinting, keying, and
 *               a bounded, TOCTOU-free, fail-open load. (SMI-5883 Wave 2)
 * @module @skillsmith/mcp-server/audit/security-acceptance
 *
 * Atomic mutation (accept/revoke) lives in `security-acceptance.mutate.ts` --
 * split out to stay under the 500-line file gate. This module owns:
 *   - `findingFingerprint` / `computeAcceptKey` -- canonical, injective keying.
 *   - `loadAcceptanceStore` -- bounded, TOCTOU-free, fail-open (never throws;
 *     a corrupt/oversized/unparseable store degrades to "empty, all findings
 *     shown" with a structured warning, mirroring `security-baseline.ts`'s
 *     fail-safe contract).
 *   - `computeStoreDigest` -- the self-consistency checksum (NOT a keyed MAC
 *     -- see D-12: an attacker who can write this file can already write the
 *     scanned content itself, so cryptographic integrity here is theater).
 */

import * as crypto from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { SecurityFinding } from '@skillsmith/core'

import {
  ACCEPTANCE_STORE_VERSION,
  MAX_RECORDS,
  MAX_STORE_BYTES,
  emptyAcceptanceStore,
} from './security-acceptance.types.js'
import type {
  AcceptanceRecord,
  AcceptanceStore,
  AcceptanceWarning,
} from './security-acceptance.types.js'

/** Absolute path to the acceptance store, `~/.skillsmith/audits/security-acceptance.json`. Mirrors `defaultBaselinePath()`. */
export function defaultAcceptancePath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.skillsmith', 'audits', 'security-acceptance.json')
}

// ---------------------------------------------------------------------------
// Finding fingerprint -- canonical, injective serialization (§3b, R4)
// ---------------------------------------------------------------------------

/**
 * Fixed-length, fixed-order 9-tuple over primitives only. `undefined`
 * optionals normalize to `null` (never `''`), so the map stays injective on
 * the original tuple: `{location: undefined}` and `{location: ''}` MUST
 * produce different fingerprints.
 */
export function fingerprintTuple(
  f: SecurityFinding
): ReadonlyArray<string | number | boolean | null> {
  return [
    f.type,
    f.severity,
    f.category ?? null,
    f.message,
    f.location ?? null,
    Number.isInteger(f.lineNumber) ? (f.lineNumber as number) : null,
    f.filePath ?? null,
    f.evidenceType ?? null,
    f.inDocumentationContext ?? null,
  ]
}

/**
 * A canonical `JSON.stringify` over a fixed-length array of primitives is
 * injective: string values escape `"` and `\`, so no value can emit an
 * unescaped `,` that could be mistaken for an element boundary; the array is
 * always exactly 9 elements (each a non-undefined primitive), so no element
 * can shift position. Distinct 9-tuples therefore always produce distinct
 * canonical strings. Hashing is over the UTF-8 BYTE BUFFER explicitly, not
 * an implicitly-encoded string.
 */
export function findingFingerprint(f: SecurityFinding): string {
  const canonical = JSON.stringify(fingerprintTuple(f))
  return crypto.createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex')
}

// ---------------------------------------------------------------------------
// Accept key -- full 256-bit, never truncated (§3c, D-8)
// ---------------------------------------------------------------------------

/**
 * Full 256 bits, 64 hex characters, never truncated anywhere -- not in the
 * store, not in `--json`, not in the human output, not in `--accept`
 * parsing. No prefix matching (D-8): prefix resolution would reintroduce
 * the same ambiguity class `findingFingerprint`'s canonical serialization
 * closes, and it interacts badly with uncapped candidate resolution (a
 * prefix unique among RENDERED candidates need not be unique among ALL
 * candidates).
 */
export function computeAcceptKey(p: {
  contentDigest: string
  findingFingerprint: string
  rulesetVersion: string
}): string {
  const canonical = JSON.stringify([
    ACCEPTANCE_STORE_VERSION,
    p.contentDigest,
    p.findingFingerprint,
    p.rulesetVersion,
  ])
  return crypto.createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex')
}

const ACCEPT_KEY_RE = /^[0-9a-f]{64}$/

/** `--accept`/`--revoke` validate the key format BEFORE touching the store -- no lock taken, no file read on a malformed key. */
export function isValidAcceptKeyFormat(key: string): boolean {
  return ACCEPT_KEY_RE.test(key)
}

// ---------------------------------------------------------------------------
// Self-consistency checksum (§3d, G-b, D-12)
// ---------------------------------------------------------------------------

/**
 * sha256 over `JSON.stringify([version, revision, records])`. Detects
 * accidental corruption (a truncated write, a partially-flushed file, a
 * hand-edit that left the digest stale). This is an UNKEYED digest -- it
 * provides self-consistency only, NOT authenticity and NOT tamper-resistance
 * (D-12). Anyone who can write this file can recompute the digest; do not
 * describe it as anti-tamper.
 */
export function computeStoreDigest(store: {
  version: number
  revision: number
  records: AcceptanceRecord[]
}): string {
  const canonical = JSON.stringify([store.version, store.revision, store.records])
  return crypto.createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex')
}

// ---------------------------------------------------------------------------
// Bounded, TOCTOU-free read (§3d, G-c)
// ---------------------------------------------------------------------------

/**
 * Single-inode bounded read: `fstat` THE FD (not the path), refuse above
 * {@link MAX_STORE_BYTES}, read from the same fd -- the size check and the
 * read observe the same inode, and the read is independently capped, so
 * even a file that grows between `fstat` and `read` cannot deliver
 * unbounded bytes.
 *
 * `'absent'` is ONLY `ENOENT` (the normal first-run case -- empty store, no
 * warning). Any OTHER `openSync` failure (EACCES, EMFILE, a symlink loop,
 * ...) is `'errored'`, distinct from absent, so `loadAcceptanceStore` can
 * warn rather than silently treating "permission denied" as "never
 * accepted anything." `fstatSync`/`readSync` failures (and a `closeSync`
 * failure on an otherwise-successful read, which must not discard already-
 * read data) are likewise converted to a return value here -- this
 * function's whole reason to exist is that `loadAcceptanceStore` NEVER
 * throws (code-review round 2: the two-step openSync-then-separate-catch
 * shape left everything below the initial open unguarded).
 */
function readStoreBounded(
  storePath: string
): { kind: 'absent' } | { kind: 'errored' } | { kind: 'oversized' } | { kind: 'ok'; text: string } {
  let fd: number
  try {
    fd = openSync(storePath, 'r')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'errored' }
  }
  try {
    const st = fstatSync(fd)
    if (st.size > MAX_STORE_BYTES) return { kind: 'oversized' }
    const buf = Buffer.allocUnsafe(MAX_STORE_BYTES + 1)
    const n = readSync(fd, buf, 0, MAX_STORE_BYTES + 1, 0)
    if (n > MAX_STORE_BYTES) return { kind: 'oversized' }
    return { kind: 'ok', text: buf.subarray(0, n).toString('utf8') }
  } catch {
    return { kind: 'errored' }
  } finally {
    try {
      closeSync(fd)
    } catch {
      // Best-effort close -- a close failure here must not override an
      // already-computed 'ok'/'oversized'/'errored' result above.
    }
  }
}

function isValidAcceptanceRecord(r: unknown): r is AcceptanceRecord {
  if (typeof r !== 'object' || r === null) return false
  const o = r as Record<string, unknown>
  if (!isValidAcceptKeyFormat(String(o['acceptKey']))) return false
  if (typeof o['sourcePath'] !== 'string' || typeof o['identifier'] !== 'string') return false
  if (
    !ACCEPT_KEY_RE.test(String(o['contentDigest'])) ||
    !ACCEPT_KEY_RE.test(String(o['findingFingerprint']))
  )
    return false
  if (typeof o['rulesetVersion'] !== 'string') return false
  // Code-review round 2 finding 3: shape validation alone is not enough --
  // matching (security-audit.candidates.ts) resolves purely on `acceptKey`,
  // never re-deriving it from the record's own (contentDigest,
  // findingFingerprint, rulesetVersion) triple. Without this check, an
  // internally-INCONSISTENT record (a correctly-formatted 64-hex acceptKey
  // that does not actually match its own triple) would still load, and
  // could suppress a completely unrelated finding if its acceptKey value
  // happened to collide with that finding's own, honestly-computed key.
  if (
    computeAcceptKey({
      contentDigest: o['contentDigest'] as string,
      findingFingerprint: o['findingFingerprint'] as string,
      rulesetVersion: o['rulesetVersion'],
    }) !== o['acceptKey']
  )
    return false
  if (typeof o['acceptedAt'] !== 'string' || Number.isNaN(Date.parse(o['acceptedAt']))) return false
  if (typeof o['reason'] !== 'string' || o['reason'].length < 1 || o['reason'].length > 500)
    return false
  const display = o['display']
  if (typeof display !== 'object' || display === null) return false
  const d = display as Record<string, unknown>
  if (
    typeof d['type'] !== 'string' ||
    typeof d['severity'] !== 'string' ||
    typeof d['message'] !== 'string'
  )
    return false
  if (d['location'] !== null && typeof d['location'] !== 'string') return false
  if (d['lineNumber'] !== null && typeof d['lineNumber'] !== 'number') return false
  return true
}

/**
 * Load the acceptance store. NEVER throws: absent, unreadable, over-sized,
 * invalid-JSON, wrong-version, or digest-mismatched all degrade to an EMPTY
 * store (nothing suppressed -- fails toward SHOWING findings) with a
 * structured warning naming the cause (except "absent", which is the
 * ordinary first-run case and warns nothing). Malformed individual records
 * are dropped (their own warning, with a count) rather than failing the
 * whole store; valid records beyond {@link MAX_RECORDS} (oldest first) are
 * also dropped, with a distinct warning -- the two causes mean different
 * things to the user (corruption vs a limit) so they are never conflated.
 */
export function loadAcceptanceStore(storePath: string): {
  store: AcceptanceStore
  warnings: AcceptanceWarning[]
} {
  const warnings: AcceptanceWarning[] = []
  const bounded = readStoreBounded(storePath)
  if (bounded.kind === 'absent') {
    return { store: emptyAcceptanceStore(), warnings }
  }
  if (bounded.kind === 'errored') {
    warnings.push({
      code: 'acceptance_store_unreadable',
      message:
        'The acceptance store could not be read (a filesystem error occurred) -- treating it as empty. Findings that were accepted will re-appear; repair or remove the store to recover them.',
    })
    return { store: emptyAcceptanceStore(), warnings }
  }
  if (bounded.kind === 'oversized') {
    warnings.push({
      code: 'acceptance_store_oversized',
      message: `The acceptance store exceeds ${MAX_STORE_BYTES} bytes and could not be read safely -- treating it as empty. Findings that were accepted will re-appear; repair or remove the store to recover them.`,
    })
    return { store: emptyAcceptanceStore(), warnings }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(bounded.text)
  } catch {
    warnings.push({
      code: 'acceptance_store_unreadable',
      message:
        'The acceptance store could not be parsed as JSON -- treating it as empty. Findings that were accepted will re-appear; repair or remove the store to recover them.',
    })
    return { store: emptyAcceptanceStore(), warnings }
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as Record<string, unknown>)['version'] !== ACCEPTANCE_STORE_VERSION ||
    typeof (parsed as Record<string, unknown>)['revision'] !== 'number' ||
    typeof (parsed as Record<string, unknown>)['storeDigest'] !== 'string' ||
    !Array.isArray((parsed as Record<string, unknown>)['records'])
  ) {
    warnings.push({
      code: 'acceptance_store_unreadable',
      message:
        'The acceptance store has an unrecognized shape or version -- treating it as empty. Findings that were accepted will re-appear; repair or remove the store to recover them.',
    })
    return { store: emptyAcceptanceStore(), warnings }
  }

  const shell = parsed as { version: 1; revision: number; storeDigest: string; records: unknown[] }
  const expectedDigest = computeStoreDigest({
    version: shell.version,
    revision: shell.revision,
    records: shell.records as AcceptanceRecord[],
  })
  if (expectedDigest !== shell.storeDigest) {
    warnings.push({
      code: 'acceptance_store_digest_mismatch',
      message:
        'The acceptance store failed its self-consistency check (a truncated write or hand-edit likely left it stale) -- treating it as empty. Findings that were accepted will re-appear; repair or remove the store to recover them.',
    })
    return { store: emptyAcceptanceStore(), warnings }
  }

  const validRecords: AcceptanceRecord[] = []
  let malformedCount = 0
  for (const r of shell.records) {
    if (isValidAcceptanceRecord(r)) validRecords.push(r)
    else malformedCount += 1
  }
  if (malformedCount > 0) {
    warnings.push({
      code: 'acceptance_records_malformed',
      count: malformedCount,
      message: `${malformedCount} acceptance record(s) were malformed and ignored -- those findings will re-appear. Re-accept them if still intended.`,
    })
  }

  // Deterministic trim: newest-first, keep MAX_RECORDS. Fails closed (fewer suppressions).
  validRecords.sort((a, b) =>
    a.acceptedAt < b.acceptedAt ? 1 : a.acceptedAt > b.acceptedAt ? -1 : 0
  )
  let kept = validRecords
  if (validRecords.length > MAX_RECORDS) {
    const overCapacity = validRecords.length - MAX_RECORDS
    kept = validRecords.slice(0, MAX_RECORDS)
    warnings.push({
      code: 'acceptance_records_over_capacity',
      count: overCapacity,
      message: `${overCapacity} valid acceptance record(s) beyond the ${MAX_RECORDS}-record limit were not loaded (oldest first) -- those findings will re-appear. Revoke stale acceptances with 'sklx audit security --revoke <key>'.`,
    })
  }

  return {
    store: {
      version: ACCEPTANCE_STORE_VERSION,
      revision: shell.revision,
      storeDigest: shell.storeDigest,
      records: kept,
    },
    warnings,
  }
}
