/**
 * @fileoverview `apply_manifest_reconcile` MCP tool (SMI-6343 Wave 4).
 * @module @skillsmith/mcp-server/tools/apply-manifest-reconcile
 *
 * Plan: docs/internal/implementation/smi-6343-manifest-hygiene.md
 * ("4. Reconciliation tool (Wave 4, stacked on Wave 3 — AC#1, AC#2, and
 * ADR-144 §6's writer)"). Trust-model philosophy: ADR-144 §3 (never
 * convert uncertainty into a registry identity) and ADR-145
 * (docs/internal/adr/145-manifest-provenance-as-second-trust-axis.md —
 * `provenance` is a second trust axis, orthogonal to `source`).
 *
 * Community tier. Repairs a corrupted or ambiguous `~/.skillsmith/
 * manifest.json` entry through a supported path — never a hand-edit —
 * closing AC#1/AC#2 and writing the `verifiedAt` field ADR-144 §6's
 * blanket trust-downgrade needs a way back out of.
 *
 * Actions:
 *   - `mark_local`  — clears registry tracking: `source: 'unknown'` +
 *     `provenance: 'local'`, written atomically in one locked update
 *     (ADR-145 §2 — these two fields are never written independently).
 *   - `relink`      — sets `id`/`source` to an explicitly supplied,
 *     registry-validated pair + `provenance: 'registry'`. Never infers an
 *     identity (ADR-144 §3) — does NOT set `verifiedAt` (asserting an
 *     identity is not verifying content).
 *   - `drop_entry`  — hard-removes an entry whose `installPath` no longer
 *     resolves (M7: renamed from `forget`, which read as reversible — this
 *     is a hard delete, recoverable only via `revert`).
 *   - `verify`      — (C3) runs the Wave 2 comparison for one entry or
 *     every entry (batch by default) and writes `verifiedAt` only on a
 *     match; a mismatch leaves the entry untouched.
 *   - `revert`      — (C7) durable, cross-session undo of a prior
 *     reconcile action on ONE entry, via a dedicated ledger
 *     (`~/.skillsmith/manifest-reconcile-ledger.json`) modeled on
 *     `rename-engine.revert.ts` — NOT `undo_apply`, which is rejected as
 *     the undo mechanism for this tool (session-scoped, whole-file hash
 *     guard hostile to the manifest's 7 independent writers, unlocked
 *     writer — see the plan's C7 subsection).
 */

import { z } from 'zod'

import {
  CLIENT_IDS,
  InvalidScopeValueError,
  UnsatisfiableWorkspaceScopeError,
  type ClientId,
} from '@skillsmith/core/install'
import { withTelemetry } from '@skillsmith/core/telemetry'

import type { ToolContext } from '../context.js'
import { getToolContext } from '../context.js'
import {
  runDropEntry,
  runMarkLocal,
  runRelink,
  runRevert,
  runVerify,
} from './apply-manifest-reconcile.actions.js'
import { describeReconcileError } from './apply-manifest-reconcile.errors.js'
import { ReconcileGuardError, resolveReconcileScope } from './apply-manifest-reconcile.helpers.js'
import type {
  ApplyManifestReconcileInput,
  ApplyManifestReconcileResponse,
} from './apply-manifest-reconcile.types.js'

// SMI-5982-style enum derivation (mirrors install.types.ts / uninstall.ts) —
// derives from the same source of truth `resolveClientId` validates
// against, so this Zod enum cannot silently drift from the real client list.
const CLIENT_ID_ENUM_VALUES = CLIENT_IDS as unknown as [ClientId, ...ClientId[]]

export const applyManifestReconcileInputSchema = z
  .object({
    action: z.enum(['mark_local', 'relink', 'drop_entry', 'verify', 'revert']),
    name: z.string().min(1).optional(),
    client: z.enum(CLIENT_ID_ENUM_VALUES).optional(),
    scope: z.enum(['global', 'workspace']).optional(),
    cwd: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
    ledgerEntryId: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (['mark_local', 'relink', 'drop_entry'].includes(value.action) && !value.name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['name'],
        message: `'name' is required when action === '${value.action}'`,
      })
    }
    if (value.action === 'relink' && (!value.id || !value.source)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['id'],
        message: "relink requires BOTH 'id' and 'source'",
      })
    }
    if (value.action !== 'relink' && (value.id !== undefined || value.source !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['id'],
        message: "'id'/'source' are only valid when action === 'relink'",
      })
    }
    if (value.action === 'revert' && !value.name && !value.ledgerEntryId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ledgerEntryId'],
        message: "revert requires either 'ledgerEntryId' or 'name'",
      })
    }
  })

/**
 * MCP tool schema for `apply_manifest_reconcile`. Hand-written JSON Schema
 * mirroring {@link applyManifestReconcileInputSchema} so the tool is
 * client-discoverable via ListTools. Keep in sync with the Zod schema.
 */
export const applyManifestReconcileToolSchema = {
  name: 'apply_manifest_reconcile',
  description:
    "[Skillsmith — Maintain stage] Repair a corrupted or ambiguous ~/.skillsmith/manifest.json entry through a supported path — MUTATES the manifest (with a pre-mutation backup and a durable, revertible ledger entry). Use after skill_outdated reports 'identity-mismatch' or 'local-drift', or after skill_recover_source found low/no confidence. Actions: 'mark_local' (stop tracking this entry against the registry — writes source:'unknown' + provenance:'local'); 'relink' (assert an explicit, registry-validated id/source pair — requires BOTH; never infers an identity); 'drop_entry' (hard-remove an entry whose installPath no longer resolves); 'verify' (re-check on-disk content against the registry's current content hash for one entry or, by default, every entry — writes verifiedAt only on a match); 'revert' (durable, cross-session undo of a prior reconcile on ONE entry, by ledgerEntryId or by name — survives an unrelated skill install happening in between).",
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['mark_local', 'relink', 'drop_entry', 'verify', 'revert'],
        description:
          "'mark_local' | 'relink' | 'drop_entry' | 'verify' | 'revert' — see tool description for each action's effect.",
      },
      name: {
        type: 'string',
        description:
          'Skill name (manifest entry, not a full id). Required for mark_local/relink/drop_entry. Optional for verify (omit to batch-verify every entry) and revert (omit when passing ledgerEntryId).',
      },
      client: {
        type: 'string',
        enum: CLIENT_ID_ENUM_VALUES,
        description: 'Target client (ADR-139). Defaults to the canonical client (claude-code).',
      },
      scope: {
        type: 'string',
        enum: ['global', 'workspace'],
        description:
          'Explicit install scope (ADR-139). Defaults to auto-detecting an EXISTING workspace directory, else global.',
      },
      cwd: {
        type: 'string',
        description:
          "Absolute path to the calling client's actual project root, used as the ancestor-walk starting point for workspace scope resolution.",
      },
      id: {
        type: 'string',
        description:
          "relink only, required together with 'source': registry skill id (author/name).",
      },
      source: {
        type: 'string',
        description:
          "relink only, required together with 'id': the source reference to record (e.g. github:owner/repo).",
      },
      reason: {
        type: 'string',
        description: 'Optional human-readable reason, recorded in the revert ledger.',
      },
      ledgerEntryId: {
        type: 'string',
        description:
          'revert only: precise ledger entry id (mrc_...) from a prior mutating action response. Preferred over name when known.',
      },
    },
    required: ['action'],
  },
}

async function applyManifestReconcileImpl(
  input: unknown,
  _context?: ToolContext
): Promise<ApplyManifestReconcileResponse> {
  const parsed = applyManifestReconcileInputSchema.safeParse(input)
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => {
        const issuePath = issue.path.length > 0 ? issue.path.join('.') : '<root>'
        return `${issuePath}: ${issue.message}`
      })
      .join('; ')
    return {
      success: false,
      action: (input as { action?: ApplyManifestReconcileInput['action'] })?.action ?? 'mark_local',
      errorCode: 'manifest.reconcile.invalid_input',
      error: describeReconcileError('manifest.reconcile.invalid_input', { detail: message }),
    }
  }
  const validInput: ApplyManifestReconcileInput = parsed.data
  const context = _context ?? getToolContext()

  let scopeTarget: ReturnType<typeof resolveReconcileScope>
  try {
    scopeTarget = resolveReconcileScope(validInput)
  } catch (err) {
    if (err instanceof InvalidScopeValueError || err instanceof UnsatisfiableWorkspaceScopeError) {
      return {
        success: false,
        action: validInput.action,
        errorCode: 'manifest.reconcile.invalid_input',
        error: describeReconcileError('manifest.reconcile.invalid_input', {
          detail: err.message,
        }),
      }
    }
    throw err
  }

  try {
    switch (validInput.action) {
      case 'mark_local':
        return await runMarkLocal(validInput, scopeTarget, context)
      case 'relink':
        return await runRelink(validInput, scopeTarget, context)
      case 'drop_entry':
        return await runDropEntry(validInput, scopeTarget, context)
      case 'verify':
        return await runVerify(validInput, scopeTarget, context)
      case 'revert':
        return await runRevert(validInput, scopeTarget, context)
      default: {
        const exhaustive: never = validInput.action
        throw new Error(`unreachable action: ${String(exhaustive)}`)
      }
    }
  } catch (err) {
    if (err instanceof ReconcileGuardError) {
      return {
        success: false,
        action: validInput.action,
        name: validInput.name,
        errorCode: err.code,
        error: describeReconcileError(err.code, err.ctx),
      }
    }
    throw err
  }
}

// SMI-5017 W2.S2: wrap at export boundary
export const applyManifestReconcile = withTelemetry(applyManifestReconcileImpl, {
  source: 'mcp-tool',
  extractSkillId: () => 'apply_manifest_reconcile',
  extractFramework: () => 'unknown',
})
