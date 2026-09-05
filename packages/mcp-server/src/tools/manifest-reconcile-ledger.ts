/**
 * @fileoverview Atomic reader/writer for the manifest-reconcile ledger
 *               (SMI-6343 Wave 4, C7).
 * @module @skillsmith/mcp-server/tools/manifest-reconcile-ledger
 *
 * Persists `~/.skillsmith/manifest-reconcile-ledger.json` — see
 * `manifest-reconcile-ledger.types.ts`'s module header for why this is a
 * NEW ledger rather than a reuse of `undo_apply`'s session stack.
 *
 * Atomicity: every write goes through `<path>.tmp.<random>` + `fs.rename`
 * (mirrors `namespace-overrides.ts`'s per-call-unique-tmp shape — a fixed
 * `<path>.tmp` would race two concurrent writers on the rename target). On
 * read, a missing file degrades gracefully to an empty ledger; malformed
 * JSON surfaces as a typed `manifest.reconcile.ledger_malformed`
 * discriminator; a higher-than-supported `version` returns
 * `manifest.reconcile.ledger_version_unsupported` rather than a silent
 * empty ledger.
 *
 * No advisory file lock: like `namespace-overrides.json`, this ledger is
 * written at human-initiated-repair cadence, not install-hot-path
 * cadence, and the atomic rename makes a torn read impossible. The
 * MANIFEST itself is still protected by `ManifestManager`'s real lock —
 * this ledger only records what that locked write did.
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { ulid } from 'ulid'

import {
  CURRENT_LEDGER_VERSION,
  type ManifestReconcileLedger,
  type ManifestReconcileLedgerEntry,
  type ManifestReconcileMutatingAction,
  type ReadReconcileLedgerResult,
  type ReconcileLedgerVersionUnsupportedError,
} from './manifest-reconcile-ledger.types.js'

const ULID_PREFIX = 'mrc_'

export interface ReconcileLedgerPathOptions {
  /** Override the ledger path (default `~/.skillsmith/manifest-reconcile-ledger.json`). */
  ledgerPath?: string
}

/**
 * Default ledger path resolver. Re-evaluates `os.homedir()` on every call
 * (mirrors `namespace-overrides.ts`'s `defaultLedgerPath` — a
 * captured-at-module-load constant would freeze the path to the spawning
 * process's home directory and silently route all writes there).
 */
function defaultLedgerPath(): string {
  return path.join(os.homedir(), '.skillsmith', 'manifest-reconcile-ledger.json')
}

function emptyLedger(): ManifestReconcileLedger {
  return { version: CURRENT_LEDGER_VERSION, entries: [] }
}

/**
 * Read the ledger from disk and return a tagged union. Missing file ->
 * `{ kind: 'ok', ledger: <empty> }`. Malformed JSON ->
 * `{ kind: 'manifest.reconcile.ledger_malformed', reason }`.
 * `version > CURRENT_LEDGER_VERSION` ->
 * `{ kind: 'manifest.reconcile.ledger_version_unsupported', found, expected }`.
 */
export async function readReconcileLedgerResult(
  opts: ReconcileLedgerPathOptions = {}
): Promise<ReadReconcileLedgerResult> {
  const ledgerPath = opts.ledgerPath ?? defaultLedgerPath()

  let raw: string
  try {
    raw = await fs.readFile(ledgerPath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'ok', ledger: emptyLedger() }
    }
    return {
      kind: 'manifest.reconcile.ledger_malformed',
      reason: `read failed: ${(err as Error).message}`,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return {
      kind: 'manifest.reconcile.ledger_malformed',
      reason: `parse failed: ${(err as Error).message}`,
    }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'manifest.reconcile.ledger_malformed', reason: 'top-level is not an object' }
  }

  const candidate = parsed as Partial<ManifestReconcileLedger>
  const versionValue = candidate.version
  if (typeof versionValue !== 'number' || !Number.isInteger(versionValue) || versionValue < 1) {
    return {
      kind: 'manifest.reconcile.ledger_malformed',
      reason: `invalid version: ${String(versionValue)}`,
    }
  }

  if (versionValue > CURRENT_LEDGER_VERSION) {
    return {
      kind: 'manifest.reconcile.ledger_version_unsupported',
      found: versionValue,
      expected: CURRENT_LEDGER_VERSION,
    } satisfies ReconcileLedgerVersionUnsupportedError
  }

  if (!Array.isArray(candidate.entries)) {
    return { kind: 'manifest.reconcile.ledger_malformed', reason: 'entries is not an array' }
  }

  return {
    kind: 'ok',
    ledger: {
      version: CURRENT_LEDGER_VERSION,
      entries: candidate.entries as ManifestReconcileLedgerEntry[],
    },
  }
}

/**
 * Convenience wrapper: returns the ledger directly, collapsing the
 * `malformed` branch to an empty ledger plus a `console.warn`. A
 * higher-version file still bubbles a thrown error — silently emptying a
 * higher-version ledger would corrupt forward-compat.
 */
export async function readReconcileLedger(
  opts: ReconcileLedgerPathOptions = {}
): Promise<ManifestReconcileLedger> {
  const result = await readReconcileLedgerResult(opts)
  switch (result.kind) {
    case 'ok':
      return result.ledger
    case 'manifest.reconcile.ledger_malformed':
      console.warn(
        `[manifest-reconcile-ledger] ledger malformed (${result.reason}); using empty ledger`
      )
      return emptyLedger()
    case 'manifest.reconcile.ledger_version_unsupported': {
      const err = new Error(
        `manifest-reconcile-ledger version ${String(result.found)} is newer than supported version ${String(result.expected)}`
      ) as Error & { kind: typeof result.kind; found: number; expected: number }
      err.kind = result.kind
      err.found = result.found
      err.expected = result.expected
      throw err
    }
    default: {
      const _exhaustive: never = result
      throw new Error(`unreachable: ${String(_exhaustive)}`)
    }
  }
}

/**
 * Write the ledger atomically: `<path>.<random>.tmp` + `fs.rename`.
 * Creates the parent directory on first run.
 */
export async function writeReconcileLedger(
  ledger: ManifestReconcileLedger,
  opts: ReconcileLedgerPathOptions = {}
): Promise<void> {
  const ledgerPath = opts.ledgerPath ?? defaultLedgerPath()
  const tmpSuffix = crypto.randomBytes(6).toString('hex')
  const tmpPath = `${ledgerPath}.${tmpSuffix}.tmp`

  await fs.mkdir(path.dirname(ledgerPath), { recursive: true })

  const normalized: ManifestReconcileLedger = {
    version: CURRENT_LEDGER_VERSION,
    entries: ledger.entries,
  }
  const json = JSON.stringify(normalized, null, 2)
  try {
    await fs.writeFile(tmpPath, json, 'utf-8')
    await fs.rename(tmpPath, ledgerPath)
  } catch (err) {
    try {
      await fs.rm(tmpPath, { force: true })
    } catch {
      // best-effort cleanup
    }
    throw err
  }
}

/**
 * Append a new entry to the ledger and persist it. Returns the full
 * entry (including the generated `id`/`appliedAt`) so the caller can echo
 * `ledgerEntryId` back to the caller for a later precise `revert`.
 */
export async function appendReconcileLedgerEntry(
  input: {
    manifestPath: string
    manifestKey: string
    name: string
    client: string
    action: ManifestReconcileMutatingAction
    beforeState: Record<string, unknown>
    afterState: Record<string, unknown> | null
    reason: string
  },
  opts: ReconcileLedgerPathOptions = {}
): Promise<ManifestReconcileLedgerEntry> {
  const ledger = await readReconcileLedger(opts)
  const entry: ManifestReconcileLedgerEntry = {
    id: `${ULID_PREFIX}${ulid()}`,
    manifestPath: input.manifestPath,
    manifestKey: input.manifestKey,
    name: input.name,
    client: input.client,
    action: input.action,
    beforeState: input.beforeState,
    afterState: input.afterState,
    appliedAt: new Date().toISOString(),
    reason: input.reason,
  }
  await writeReconcileLedger({ version: ledger.version, entries: [...ledger.entries, entry] }, opts)
  return entry
}

/**
 * Remove a ledger entry by id and persist the result. Used by a
 * successful revert (C7's idempotency: the entry being gone is what makes
 * a second revert of the same id a no-op success rather than an error).
 */
export async function removeReconcileLedgerEntry(
  entryId: string,
  opts: ReconcileLedgerPathOptions = {}
): Promise<void> {
  const ledger = await readReconcileLedger(opts)
  const filtered = ledger.entries.filter((e) => e.id !== entryId)
  if (filtered.length === ledger.entries.length) return // already gone; no-op
  await writeReconcileLedger({ version: ledger.version, entries: filtered }, opts)
}

/**
 * Find every ledger entry matching `(name, client, manifestPath)`,
 * most-recent-first. Used by `revert` when the caller supplies
 * `name`/`client` instead of an explicit `ledgerEntryId` — see
 * `apply-manifest-reconcile.ts`'s revert action for the disambiguation
 * policy this feeds (0 matches -> idempotent no-op, 1 -> revert it, 2+ ->
 * `manifest.reconcile.revert_ambiguous`). Filtering on `manifestPath` too
 * (not just `name`/`client`) matters under ADR-139: the same `(name,
 * client)` pair can be reconciled independently at global AND workspace
 * scope, and a by-name revert must only ever match entries from the
 * SAME manifest the caller's own scope resolution points at.
 */
export function findReconcileLedgerEntriesFor(
  ledger: ManifestReconcileLedger,
  name: string,
  client: string,
  manifestPath: string
): ManifestReconcileLedgerEntry[] {
  return ledger.entries
    .filter((e) => e.name === name && e.client === client && e.manifestPath === manifestPath)
    .sort((a, b) => b.appliedAt.localeCompare(a.appliedAt))
}
