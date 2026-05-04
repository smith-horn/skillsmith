/**
 * @fileoverview Audit exclusions loader + matcher + tier-revalidation gate
 * (SMI-4590 Wave 4 PR 3).
 * @module @skillsmith/core/audit/exclusions
 *
 * Reads `~/.skillsmith/audit-exclusions.json` and provides {@link isExcluded}
 * for the inventory collision detector to filter known-acceptable findings,
 * plus {@link tierAllowsAuditMode} — the write-time / re-resolution gate the
 * CLI (PR 5) and session-start hook (PR 6) call before persisting or
 * applying a user-selected `audit_mode`.
 *
 * Failure modes (decision #13 verbatim):
 *   - Missing file → empty config; nothing filtered.
 *   - Unreadable / malformed JSON → warn-and-empty; no exception.
 *   - Unknown `version` → warn-and-empty (forward-compat).
 *
 * Exclusion match is exact-string per `kind`. No glob / prefix support in
 * v1 — keep the surface small until users ask.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { getConfigDir } from '../config/index.js'
import type { AuditMode, Tier } from '../config/audit-mode.js'

import type {
  ExcludableEntry,
  ExclusionEntry,
  ExclusionsConfig,
} from './exclusions.types.js'

const EXCLUSIONS_FILE = 'audit-exclusions.json'

/** Empty default returned when the file is missing or unreadable. */
const EMPTY_CONFIG: ExclusionsConfig = { version: 1, exclusions: [] }

/**
 * Resolve the absolute path to the exclusions file. Defaults to
 * `~/.skillsmith/audit-exclusions.json`. Tests pass `configDir` to
 * isolate.
 */
export function getExclusionsPath(opts?: { configDir?: string }): string {
  return join(opts?.configDir ?? getConfigDir(), EXCLUSIONS_FILE)
}

export interface LoadExclusionsOptions {
  /**
   * Override the file path. Defaults to {@link getExclusionsPath}().
   * Test harnesses pass a temp-dir path; production callers should leave
   * unset.
   */
  configPath?: string
}

/** Load the exclusions config. Never throws; failures degrade to empty. */
export async function loadExclusions(
  opts: LoadExclusionsOptions = {},
): Promise<ExclusionsConfig> {
  const path = opts.configPath ?? getExclusionsPath()

  let raw: string
  try {
    raw = await fs.readFile(path, 'utf-8')
  } catch (err) {
    // ENOENT is the expected hot path for users who haven't authored a
    // file yet. Other read errors (permissions etc.) also fail open —
    // exclusions are an opt-in suppression mechanism, never load-bearing.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[audit-exclusions] read failed for ${path}: ${(err as Error).message}`)
    }
    return EMPTY_CONFIG
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.warn(`[audit-exclusions] malformed JSON at ${path} — ignoring file`)
    return EMPTY_CONFIG
  }

  if (!isExclusionsConfig(parsed)) {
    console.warn(
      `[audit-exclusions] unrecognized schema at ${path} (expected version: 1) — ignoring file`,
    )
    return EMPTY_CONFIG
  }
  return parsed
}

function isExclusionsConfig(v: unknown): v is ExclusionsConfig {
  if (!v || typeof v !== 'object') return false
  const obj = v as Record<string, unknown>
  if (obj.version !== 1) return false
  if (!Array.isArray(obj.exclusions)) return false
  return obj.exclusions.every(isExclusionEntry)
}

function isExclusionEntry(v: unknown): v is ExclusionEntry {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  if (typeof e.reason !== 'string' || e.reason.length === 0) return false
  if (e.kind === 'command') {
    return typeof e.identifier === 'string' && e.identifier.length > 0
  }
  if (e.kind === 'skill') {
    return typeof e.skillId === 'string' && e.skillId.length > 0
  }
  return false
}

/** True when `entry` matches any exclusion in `config`. Exact-match only. */
export function isExcluded(entry: ExcludableEntry, config: ExclusionsConfig): boolean {
  return config.exclusions.some((excl) => {
    if (excl.kind === 'command' && entry.kind === 'command') {
      return excl.identifier === entry.commandIdentifier
    }
    if (excl.kind === 'skill' && entry.kind === 'skill') {
      return excl.skillId === entry.skillId
    }
    return false
  })
}

/**
 * Tier-revalidation gate for `audit_mode` writes (Wave 4 plan §8).
 *
 * Applied at three points (defense-in-depth):
 *   1. CLI write-time: `sklx config set audit_mode <value>` (PR 5)
 *      rejects with typed error `audit.mode.tier_ineligible` when this
 *      returns false.
 *   2. Session-start hook (PR 6): re-resolves to `'preventative'` when
 *      a manually-edited config violates the gate.
 *   3. Detector entry-point: hardening boundary in case (1) and (2)
 *      both miss.
 *
 * Eligibility table:
 *
 *   |              | preventative | power_user | governance | off |
 *   |--------------|:------------:|:----------:|:----------:|:---:|
 *   | community    |      ✓       |     ✗      |     ✗      |  ✓  |
 *   | individual   |      ✓       |     ✗      |     ✗      |  ✓  |
 *   | team         |      ✓       |     ✓      |     ✗      |  ✓  |
 *   | enterprise   |      ✓       |     ✓      |     ✓      |  ✓  |
 *
 * `'off'` is allowed for all tiers — turning the audit off is a user
 * preference, not a paid capability.
 */
export function tierAllowsAuditMode(tier: Tier, mode: AuditMode): boolean {
  if (mode === 'preventative' || mode === 'off') return true
  if (mode === 'power_user') return tier === 'team' || tier === 'enterprise'
  if (mode === 'governance') return tier === 'enterprise'
  return false
}
