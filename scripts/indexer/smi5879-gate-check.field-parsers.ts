/**
 * Generic JSON field-level parsers shared by the two G-1 disposition-ledger
 * shape validators (`smi5879-gate-check.ledger-validation.ts` for entries,
 * `smi5879-gate-check.disposition-batch.ts` for `DispositionBatch`/
 * `DispositionBatchStratum`). Deliberately dependency-free of both — each of
 * those two files imports from here, never from each other, to avoid a
 * circular import (the ledger validator needs `parseDispositionBatch`, and
 * both need these primitives).
 * @module scripts/indexer/smi5879-gate-check.field-parsers
 *
 * Plan: docs/internal/implementation/smi-6444-g1-bulk-disposition-plan.md
 *   Item 3's "explicit field parsing, never pass-through" convention,
 *   applied uniformly here rather than duplicated per call site.
 */

import type { RevocationInfo } from './smi5879-gate-check.types.ts'

export type Field<T> = { ok: true; value: T } | { ok: false; reason: string }

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function reqString(raw: unknown, label: string): Field<string> {
  return typeof raw === 'string' && raw.length > 0
    ? { ok: true, value: raw }
    : { ok: false, reason: `${label} must be a non-empty string` }
}

export function reqIso8601(raw: unknown, label: string): Field<string> {
  return typeof raw === 'string' && !Number.isNaN(Date.parse(raw))
    ? { ok: true, value: raw }
    : { ok: false, reason: `${label} must be an ISO 8601 timestamp string` }
}

export function reqNonNegInt(raw: unknown, label: string): Field<number> {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0
    ? { ok: true, value: raw }
    : { ok: false, reason: `${label} must be a non-negative integer` }
}

export function reqOneOf<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  label: string
): Field<T> {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw)
    ? { ok: true, value: raw as T }
    : { ok: false, reason: `${label} must be one of ${allowed.join('|')}` }
}

/** `raw === undefined` short-circuits to a successful `undefined` — every
 *  optional field in this schema is OMITTED when absent, never defaulted. */
export function optField<T>(
  raw: unknown,
  parse: (raw: unknown, label: string) => Field<T>,
  label: string
): Field<T | undefined> {
  return raw === undefined ? { ok: true, value: undefined } : parse(raw, label)
}

/** `population_cohort_counts`/`subtype_counts` shape: a plain object whose
 *  every value is a non-negative integer. */
export function reqCountRecord(raw: unknown, label: string): Field<Record<string, number>> {
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} must be an object` }
  const result: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw)) {
    const parsed = reqNonNegInt(value, `${label}.${key}`)
    if (!parsed.ok) return parsed
    result[key] = parsed.value
  }
  return { ok: true, value: result }
}

/** `selected_ids`/`unavailable_ids`/`mismatched_ids` shape: an array of
 *  non-empty strings, sorted ascending with no duplicates (Item 7). */
export function reqIdList(raw: unknown, label: string): Field<string[]> {
  if (!Array.isArray(raw)) return { ok: false, reason: `${label} must be an array` }
  const ids: string[] = []
  let prev: string | undefined
  for (const [i, item] of raw.entries()) {
    if (typeof item !== 'string' || item.length === 0) {
      return { ok: false, reason: `${label}[${i}] must be a non-empty string` }
    }
    if (prev !== undefined && !(item > prev)) {
      return { ok: false, reason: `${label} must be sorted ascending with no duplicates` }
    }
    prev = item
    ids.push(item)
  }
  return { ok: true, value: ids }
}

export function isSubset(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(b)
  return a.every((id) => set.has(id))
}

export function isDisjoint(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(b)
  return a.every((id) => !set.has(id))
}

/** Shared by a revoked `DispositionRecord.revoked` and a revoked
 *  `DispositionBatch.revoked` (Item 3/7/8) — identical shape, one parser. */
export function parseRevocationInfo(raw: unknown, label: string): Field<RevocationInfo> {
  if (!isPlainObject(raw)) return { ok: false, reason: `${label} is not an object` }
  const revokedBy = reqString(raw['revoked_by'], `${label}.revoked_by`)
  if (!revokedBy.ok) return revokedBy
  const revokedAt = reqIso8601(raw['revoked_at'], `${label}.revoked_at`)
  if (!revokedAt.ok) return revokedAt
  const reason = reqString(raw['reason'], `${label}.reason`)
  if (!reason.ok) return reason
  return {
    ok: true,
    value: { revoked_by: revokedBy.value, revoked_at: revokedAt.value, reason: reason.value },
  }
}
