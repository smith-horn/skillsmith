/**
 * @fileoverview Atomic reader/writer for the namespace-overrides ledger
 *               (SMI-4588 Wave 2 Step 1, PR #1).
 * @module @skillsmith/mcp-server/audit/namespace-overrides
 *
 * Persists `~/.skillsmith/namespace-overrides.json` — the load-bearing
 * artifact that makes consumer-side namespace renames durable across pack
 * version bumps. Conceptually equivalent to git's `rerere` but for
 * namespace identifiers.
 *
 * Atomicity: every write goes through `<path>.tmp` + `fs.rename`. On read,
 * a missing file degrades gracefully to an empty ledger; malformed JSON
 * surfaces as a typed `namespace.ledger.malformed` discriminator (the
 * caller decides whether to log + reset, never silently). A
 * higher-than-supported `version` returns
 * `namespace.ledger.version_unsupported` rather than a silent empty
 * ledger — see plan §2 Edit 6.
 *
 * Concurrent-write boundary: last-write-wins on a single Node event loop
 * via `<path>.tmp` + `fs.rename`. Multi-process scenarios (two MCP
 * instances on the same machine) can lose one write under a tight race;
 * documented as a known limitation in the plan. If multi-process safety
 * becomes load-bearing, a future revision adds advisory locking via
 * `proper-lockfile`.
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { ulid } from 'ulid'

import {
  CURRENT_VERSION,
  type LedgerVersionUnsupportedError,
  type OverrideRecord,
  type OverridesLedger,
  type ReadLedgerResult,
} from './namespace-overrides.types.js'

const DEFAULT_LEDGER_PATH = path.join(os.homedir(), '.skillsmith', 'namespace-overrides.json')

const ULID_PREFIX = 'ovr_'

export interface LedgerPathOptions {
  /** Override the ledger path (default `~/.skillsmith/namespace-overrides.json`). */
  ledgerPath?: string
}

/**
 * Empty ledger sentinel — used when the file is missing or malformed.
 * Returned by value so callers never share state with a private const.
 */
function emptyLedger(): OverridesLedger {
  return { version: CURRENT_VERSION, overrides: [] }
}

/**
 * Read the ledger from disk and return a tagged union. Missing file →
 * `{ kind: 'ok', ledger: <empty> }`. Malformed JSON →
 * `{ kind: 'namespace.ledger.malformed', reason }`. `version > CURRENT_VERSION`
 * → `{ kind: 'namespace.ledger.version_unsupported', found, expected }`.
 *
 * Callers that want the simpler "read or empty" semantics should use
 * `readLedger()` (below) which collapses the discriminator.
 */
export async function readLedgerResult(opts: LedgerPathOptions = {}): Promise<ReadLedgerResult> {
  const ledgerPath = opts.ledgerPath ?? DEFAULT_LEDGER_PATH

  let raw: string
  try {
    raw = await fs.readFile(ledgerPath, 'utf-8')
  } catch (err) {
    // ENOENT — missing file degrades to an empty ledger. Anything else
    // (permission denied, EISDIR, etc.) bubbles as malformed so the
    // caller can decide whether to alert.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'ok', ledger: emptyLedger() }
    }
    return {
      kind: 'namespace.ledger.malformed',
      reason: `read failed: ${(err as Error).message}`,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return {
      kind: 'namespace.ledger.malformed',
      reason: `parse failed: ${(err as Error).message}`,
    }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'namespace.ledger.malformed', reason: 'top-level is not an object' }
  }

  const candidate = parsed as Partial<OverridesLedger>
  const versionValue = candidate.version
  if (typeof versionValue !== 'number' || !Number.isInteger(versionValue) || versionValue < 1) {
    return {
      kind: 'namespace.ledger.malformed',
      reason: `invalid version: ${String(versionValue)}`,
    }
  }

  if (versionValue > CURRENT_VERSION) {
    return {
      kind: 'namespace.ledger.version_unsupported',
      found: versionValue,
      expected: CURRENT_VERSION,
    } satisfies LedgerVersionUnsupportedError
  }

  if (!Array.isArray(candidate.overrides)) {
    return { kind: 'namespace.ledger.malformed', reason: 'overrides is not an array' }
  }

  // Shape verified; cast back to the canonical type. Per-record validation
  // is intentionally minimal — additive future fields are preserved by the
  // writer's read-modify-write cycle.
  return {
    kind: 'ok',
    ledger: { version: CURRENT_VERSION, overrides: candidate.overrides as OverrideRecord[] },
  }
}

/**
 * Convenience wrapper: returns the ledger directly, collapsing the
 * `malformed` branch to an empty ledger plus a `console.warn`. Higher-
 * version files still bubble a thrown error — silently empty-ing a
 * higher-version ledger would corrupt forward-compat (plan §2 Edit 6).
 *
 * For callers that need the typed discriminator, use `readLedgerResult`.
 */
export async function readLedger(opts: LedgerPathOptions = {}): Promise<OverridesLedger> {
  const result = await readLedgerResult(opts)
  switch (result.kind) {
    case 'ok':
      return result.ledger
    case 'namespace.ledger.malformed':
      // Malformed → degrade to empty + warn. Install must not break.
      console.warn(`[namespace-overrides] ledger malformed (${result.reason}); using empty ledger`)
      return emptyLedger()
    case 'namespace.ledger.version_unsupported': {
      // Higher-version file: bubble as a typed error — silently empty-ing
      // would shadow the user's persisted renames on a downgrade.
      const err = new Error(
        `namespace-overrides ledger version ${String(result.found)} is newer than supported version ${String(result.expected)}`
      ) as Error & { kind: typeof result.kind; found: number; expected: number }
      err.kind = result.kind
      err.found = result.found
      err.expected = result.expected
      throw err
    }
    default: {
      // Exhaustiveness — TS verifies via `never`.
      const _exhaustive: never = result
      throw new Error(`unreachable: ${String(_exhaustive)}`)
    }
  }
}

/**
 * Write the ledger atomically: `<path>.tmp` + `fs.rename`. Creates the
 * parent directory on first run with `recursive: true` (mirrors
 * audit-history.ts E-MISS-2 fix).
 */
export async function writeLedger(
  ledger: OverridesLedger,
  opts: LedgerPathOptions = {}
): Promise<void> {
  const ledgerPath = opts.ledgerPath ?? DEFAULT_LEDGER_PATH
  // Per-call unique tmp path: two concurrent writers must not clobber
  // each other's staging file (a fixed `<path>.tmp` would race on the
  // writeFile + rename interleaving and surface as ENOENT on rename).
  // The unique suffix preserves last-write-wins on the rename target
  // while making the staging step independent.
  const tmpSuffix = crypto.randomBytes(6).toString('hex')
  const tmpPath = `${ledgerPath}.${tmpSuffix}.tmp`

  await fs.mkdir(path.dirname(ledgerPath), { recursive: true })

  // Always serialize at CURRENT_VERSION; readers gate on it.
  const normalized: OverridesLedger = { version: CURRENT_VERSION, overrides: ledger.overrides }
  const json = JSON.stringify(normalized, null, 2)
  try {
    await fs.writeFile(tmpPath, json, 'utf-8')
    await fs.rename(tmpPath, ledgerPath)
  } catch (err) {
    // Best-effort cleanup of stranded tmp file. ENOENT here is fine —
    // the rename may have already moved the tmp out from under us.
    try {
      await fs.rm(tmpPath, { force: true })
    } catch {
      // swallow
    }
    throw err
  }
}

/**
 * Pure helper: append a new override to a ledger and return a new copy.
 * Original ledger is not mutated. The caller is responsible for
 * persisting the result via `writeLedger` (separation of concerns —
 * tests can build ledgers without touching disk).
 *
 * Idempotency: if an override with the same
 * `(skillId, kind, originalIdentifier, renamedTo)` quadruple already
 * exists, the input is returned unchanged. The caller can detect the
 * no-op by reference equality (`appended === ledger`).
 */
export function appendOverride(
  ledger: OverridesLedger,
  override: Omit<OverrideRecord, 'id' | 'appliedAt'>
): OverridesLedger {
  const duplicate = ledger.overrides.find(
    (existing) =>
      existing.skillId === override.skillId &&
      existing.kind === override.kind &&
      existing.originalIdentifier === override.originalIdentifier &&
      existing.renamedTo === override.renamedTo
  )
  if (duplicate) {
    return ledger
  }

  const fullRecord: OverrideRecord = {
    ...override,
    id: `${ULID_PREFIX}${ulid()}`,
    appliedAt: new Date().toISOString(),
  }
  return { version: ledger.version, overrides: [...ledger.overrides, fullRecord] }
}

/**
 * Pure lookup: find an override by `(skillId, kind, originalIdentifier)`.
 * `skillId` may be omitted for local/unregistered artifacts; in that case
 * only `kind` + `originalIdentifier` are matched. Returns the first match
 * or `null`.
 */
export function findOverride(
  ledger: OverridesLedger,
  query: { skillId?: string | null; kind?: OverrideRecord['kind']; originalIdentifier: string }
): OverrideRecord | null {
  const match = ledger.overrides.find((entry) => {
    if (entry.originalIdentifier !== query.originalIdentifier) return false
    if (query.kind !== undefined && entry.kind !== query.kind) return false
    if (query.skillId !== undefined && entry.skillId !== query.skillId) return false
    return true
  })
  return match ?? null
}
