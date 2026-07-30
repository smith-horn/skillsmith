/**
 * @fileoverview Shared option/seam types for `sklx audit security`.
 * @module @skillsmith/cli/commands/audit-security.types
 *
 * Split out so `audit-security.action.ts` and `audit-security.mutate.ts` can
 * both depend on these shapes without a circular module reference.
 */

import type { ScanReport } from '@skillsmith/core'
import type { InventoryEntry } from '@skillsmith/mcp-server/audit'

// `| undefined` is added explicitly (not just `?`) on every optional field
// below because this repo's base tsconfig sets `exactOptionalPropertyTypes`
// -- under that flag, `foo?: string` forbids assigning a value that is
// EXPLICITLY `undefined` (only omitting the key is allowed), which the
// options-construction code in `audit-security.action.ts` needs to do when
// passing through a possibly-absent commander flag or seam.
export interface AuditSecurityOptions {
  json: boolean
  /** Also email the digest via the consent-gated `audit-notify` edge function. */
  email: boolean
  /** List candidate findings (human output only; `--json` always includes a bounded `candidates` page). Default false. */
  candidates?: boolean | undefined
  /** Max candidates shown in human output. Default 20. */
  limit?: number | undefined
  /** `--json` candidate page (1-indexed). Default 1. */
  page?: number | undefined
  /** Candidates per `--json` page. Default 200. */
  pageSize?: number | undefined
  /** Emit the complete uncapped candidate array. Requires `--json`; conflicts with `--page`. Default false. */
  allCandidates?: boolean | undefined
  /** Accept a candidate finding by its full 64-hex key. Requires `--reason`. */
  accept?: string | undefined
  /** Required with `--accept`: 1..500 chars. */
  reason?: string | undefined
  /** Revoke a previously accepted finding by its full 64-hex key. */
  revoke?: string | undefined
  /** List all currently stored acceptances. Default false. */
  listAccepted?: boolean | undefined
}

/** Non-exported test/CLI seam intersection -- mirrors `SecurityAuditSeams` on the mcp-server side (SMI-5883 §6). */
export interface AuditSecurityCliSeams {
  homeDir?: string | undefined
  baselinePath?: string | undefined
  acceptancePath?: string | undefined
  /** Inject a pre-computed inventory (test seam; mirrors `RunSecurityAuditOptions.inventory`). */
  inventory?: InventoryEntry[] | undefined
  readContent?: ((absPath: string) => string | null) | undefined
  auditId?: string | undefined
  scan?: ((skillId: string, content: string) => ScanReport) | undefined
}

/** Outcome of an `--email` push (also embedded in `--json` output). */
export interface EmailOutcome {
  ok: boolean
  sent: boolean
  reason?: string
  error?: string
}
