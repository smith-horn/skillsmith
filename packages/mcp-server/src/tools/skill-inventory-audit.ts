/**
 * @fileoverview `skill_inventory_audit` MCP tool (SMI-4590 Wave 4 PR 4).
 * @module @skillsmith/mcp-server/tools/skill-inventory-audit
 *
 * Plan: docs/internal/implementation/smi-4590-cli-mcp-framework-adapter.md §1.
 *
 * Stateless: every call generates a fresh `auditId`, runs the full
 * Wave 1 + 2 + 3 pipeline via `runInventoryAudit`, and writes both
 * `result.json` (Wave 1 history) and `suggestions.json` (this PR) to
 * `~/.skillsmith/audits/<auditId>/`. Idempotent — re-invocation produces a
 * fresh audit with no shared state across calls.
 *
 * Validation:
 *   - `deep` / `applyExclusions` — booleans, default false / true.
 *   - `homeDir` — string under `os.homedir()` or `os.tmpdir()` (test
 *     fixtures). Anything else rejects with
 *     `namespace.audit.invalid_home_dir` (`buildValidationError` envelope).
 *   - `projectDir` — string, optional; no traversal refinement (CLAUDE.md
 *     scan is read-only and tolerates missing files).
 *   - Unknown top-level keys are rejected (Zod `.strict()`).
 */

import * as os from 'node:os'
import * as path from 'node:path'

import { z } from 'zod'

import { runInventoryAudit } from '../audit/run-inventory-audit.js'
import type {
  SkillInventoryAuditInput,
  SkillInventoryAuditResponse,
} from './skill-inventory-audit.types.js'

/**
 * Zod input schema for the `skill_inventory_audit` MCP tool.
 *
 * `homeDir` refinement: the resolved absolute path must live under
 * `os.homedir()` OR `os.tmpdir()` (test fixtures only). Bare arbitrary
 * paths are rejected — prevents an attacker-controlled input from
 * steering the scanner at e.g. `/etc` or `/private/var/db`.
 */
export const skillInventoryAuditInputSchema = z
  .object({
    deep: z.boolean().optional(),
    homeDir: z
      .string()
      .min(1)
      .refine(isHomeDirUnderAllowedRoot, {
        message:
          'homeDir must resolve under os.homedir() or os.tmpdir(); arbitrary filesystem paths are rejected',
      })
      .optional(),
    projectDir: z.string().min(1).optional(),
    applyExclusions: z.boolean().optional(),
  })
  .strict()

export type SkillInventoryAuditValidatedInput = z.infer<typeof skillInventoryAuditInputSchema>

/**
 * Execute the `skill_inventory_audit` tool. Validates input via Zod and
 * returns either the success response OR a structured validation-error
 * envelope (matches `install.ts:buildValidationError` pattern).
 */
export async function skillInventoryAudit(
  input: unknown
): Promise<SkillInventoryAuditResponse | InventoryAuditValidationError> {
  const parsed = skillInventoryAuditInputSchema.safeParse(input)
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => {
        const issuePath = issue.path.length > 0 ? issue.path.join('.') : '<root>'
        return `${issuePath}: ${issue.message}`
      })
      .join('; ')
    return buildInventoryAuditValidationError(message)
  }
  const validInput = parsed.data

  const runOpts: Parameters<typeof runInventoryAudit>[0] = {}
  if (validInput.deep !== undefined) runOpts.deep = validInput.deep
  if (validInput.homeDir !== undefined) runOpts.homeDir = validInput.homeDir
  if (validInput.projectDir !== undefined) runOpts.projectDir = validInput.projectDir
  if (validInput.applyExclusions !== undefined) {
    runOpts.applyExclusions = validInput.applyExclusions
  }
  const result = await runInventoryAudit(runOpts)
  return result
}

/**
 * Application-level validation-error envelope. Mirrors the
 * `install.ts:buildValidationError` shape so MCP clients that introspect
 * `success` get a consistent failure surface across audit + install
 * tools.
 */
export interface InventoryAuditValidationError {
  success: false
  error: string
  errorCode: 'namespace.audit.invalid_input' | 'namespace.audit.invalid_home_dir'
}

function buildInventoryAuditValidationError(message: string): InventoryAuditValidationError {
  // Distinguish the homeDir refinement from generic shape errors so
  // callers can short-circuit on the security-relevant code without
  // parsing prose.
  const code = /homeDir must resolve under/.test(message)
    ? ('namespace.audit.invalid_home_dir' as const)
    : ('namespace.audit.invalid_input' as const)
  return {
    success: false,
    error: `Invalid skill_inventory_audit input: ${message}`,
    errorCode: code,
  }
}

/**
 * Reject `homeDir` values that resolve outside the user's homedir or the
 * OS temp dir. Symlinks are NOT followed — the check is on the resolved
 * absolute path string. macOS `/var/folders` symlink to `/private/var/folders`
 * is handled by also accepting paths with both common prefixes.
 */
function isHomeDirUnderAllowedRoot(value: string): boolean {
  if (value.length === 0) return false
  const resolved = path.resolve(value)
  const candidates = [os.homedir(), os.tmpdir()]
  // macOS realpath equivalence: `/var/folders/...` and `/private/var/folders/...`
  // both resolve to the same physical location. Accept either prefix to
  // unblock test fixtures created via `fs.mkdtempSync` on macOS.
  const tmp = os.tmpdir()
  if (tmp.startsWith('/var/folders/')) candidates.push('/private' + tmp)
  if (tmp.startsWith('/private/var/folders/')) candidates.push(tmp.replace('/private', ''))
  return candidates.some((root) => resolved === root || resolved.startsWith(root + path.sep))
}

// Re-export the input/response type aliases so dispatchers + tests can
// pull them from one path without reaching across two modules.
export type { SkillInventoryAuditInput, SkillInventoryAuditResponse }
