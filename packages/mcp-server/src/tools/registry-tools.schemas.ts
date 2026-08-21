/**
 * @fileoverview Schemas for the private-registry tools — both the Zod runtime-validation
 * schemas and the MCP tool-registration schemas
 * @module @skillsmith/mcp-server/tools/registry-tools.schemas
 * @see SMI-5949 D-12: Wave 2 Step 1 — "Extract schemas, make room"; extended Wave 2 Step 4
 * @see docs/internal/implementation/smi-5949-approval-gate.md
 *
 * A schemas-only companion (the `foo.types.ts`/`foo.action.ts` convention already used by
 * `registry-tools.content.types.ts` and `registry-tools.install-action.ts`). Originally just the
 * two MCP tool-registration schemas (Wave 2 Step 1, when `registry-tools.ts` sat at 492/500
 * lines); Wave 2 Step 4 additionally moved the Zod validation schemas here (`skillContentSchema`,
 * `privateRegistryPublishInputSchema`, `privateRegistryManageInputSchema` and their inferred
 * types) — the three review-gate actions' extra enum values/fields pushed `registry-tools.ts`
 * back over budget even after the D-5 service-interface methods were themselves split into
 * `registry-tools.review.types.ts`. Both schema families belong together: they describe the same
 * two tools' inputs from two different angles (what the model sees vs what the handler runtime-
 * validates), and neither depends on anything else `registry-tools.ts` defines.
 *
 * Re-exported from `registry-tools.ts` so every existing import (`index.ts`'s tool-registration
 * schemas, `tool-dispatch.ts`'s Zod schemas, every test file's `SkillContent`/input types) needs
 * no change — only this module's own contents moved, not who they are reached through.
 */

import { z } from 'zod'
import { hasSafeSkillIdSegments } from './registry-tools.skill-id.js'

// ============================================================================
// Zod runtime-validation schemas
// ============================================================================

/**
 * Packaged skill files as a flat { relativePath: fileText } map
 * (e.g. { "SKILL.md": "...", "scripts/foo.sh": "..." }). Stored JSONB-native
 * per ADR-129; a "SKILL.md" entry is required and total size is capped at 2 MB
 * (enforced in the live publish service).
 */
export const skillContentSchema = z.record(z.string(), z.string())
export type SkillContent = z.infer<typeof skillContentSchema>

export const privateRegistryPublishInputSchema = z.object({
  skillId: z
    .string()
    .regex(/^[^/]+\/[^/]+$/, 'Must be author/name format')
    .refine(hasSafeSkillIdSegments, 'skillId segments must not be empty, ".", or ".."')
    .describe('Skill identifier in author/name format'),
  version: z
    .string()
    .regex(
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
      'Must be a valid semver version'
    )
    .describe('Semver version to publish'),
  content: skillContentSchema.describe(
    'Packaged skill files as a { path: text } map; must include a "SKILL.md" entry (max 2 MB total)'
  ),
  description: z.string().max(500).optional().describe('Optional skill description'),
})

export type PrivateRegistryPublishInput = z.infer<typeof privateRegistryPublishInputSchema>

export const privateRegistryManageInputSchema = z.object({
  // SMI-5949 D-12: "submissions" lists review-gate items (pending/rejected too, metadata only,
  // D-4(c)) — distinct from "list", which only ever returns installable/approved (finding L3).
  action: z.enum([
    'list',
    'get',
    'deprecate',
    'undeprecate',
    'namespace',
    'install',
    'submissions',
    'approve',
    'reject',
  ]),
  skillId: z
    .string()
    .regex(/^[^/]+\/[^/]+$/, 'Must be author/name format')
    .refine(hasSafeSkillIdSegments, 'skillId segments must not be empty, ".", or ".."')
    .optional()
    .describe('Skill identifier (required for get/deprecate/undeprecate/install/approve/reject)'),
  version: z
    .string()
    .optional()
    .describe('Version filter; required for approve/reject; "install" defaults to most recent'),
  force: z.boolean().optional().describe('SMI-5905: reinstall over an existing install'),
  // SMI-5949 Wave 3: deprecated read-filter closure. Only affects action "list" — get/install
  // always exclude deprecated versions, with no equivalent opt-in (see the plan doc's Wave 3
  // section for why the asymmetry is deliberate). Ignored on every other action.
  includeDeprecated: z
    .boolean()
    .optional()
    .describe(
      'Action "list" only: include deprecated versions (omit or false to hide them, the ' +
        'default). No effect on other actions — "get"/"install" always exclude deprecated ' +
        'versions, even by exact version.'
    ),
  // SMI-5949 D-5. No separate "decision" input — action itself ('approve'/'reject') is the decision.
  status: z
    .enum(['pending', 'approved', 'rejected'])
    .optional()
    .describe('Filter for action "submissions"; omit for everything visible to you'),
  note: z.string().max(1000).optional().describe('Optional reviewer note for approve/reject'),
})

export type PrivateRegistryManageInput = z.infer<typeof privateRegistryManageInputSchema>

// ============================================================================
// MCP tool-registration schemas
// ============================================================================

export const privateRegistryPublishToolSchema = {
  name: 'private_registry_publish' as const,
  description:
    "Publish a skill to your organization's private registry. " +
    'Requires Enterprise tier (private_registry feature). ' +
    "Skills are scoped to your team's registry namespace and published versions are immutable. " +
    'A published version is not installable by teammates until a team admin approves it — ' +
    'see private_registry_manage action "submissions" to check its status.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      skillId: {
        type: 'string',
        description: 'Skill ID in author/name format',
      },
      version: {
        type: 'string',
        description: 'Semver version to publish',
      },
      content: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description:
          'Packaged skill files as a { path: text } map; must include "SKILL.md" (max 2 MB total)',
      },
      description: {
        type: 'string',
        description: 'Optional skill description',
      },
    },
    required: ['skillId', 'version', 'content'],
  },
}

export const privateRegistryManageToolSchema = {
  name: 'private_registry_manage' as const,
  description:
    'Manage skills in your private registry (list, get, install, deprecate, undeprecate, ' +
    'namespace, submissions, approve, reject). Requires Enterprise tier (private_registry ' +
    'feature). Published versions require a team admin to approve them via "approve" before ' +
    'other members can install them (see "submissions" to check status).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: [
          'list',
          'get',
          'deprecate',
          'undeprecate',
          'namespace',
          'install',
          'submissions',
          'approve',
          'reject',
        ],
        description:
          'Registry operation to perform. "namespace" returns your team\'s registry ' +
          'namespace (the required skill_id prefix) without attempting a publish. ' +
          '"install" downloads the skill and writes it to your skills directory. ' +
          '"submissions" lists review-gate items awaiting or already given a decision — ' +
          'metadata only, not installable, unlike "list" which only ever returns installable, ' +
          'approved versions. "approve"/"reject" record an admin\'s decision on one pending ' +
          '(skillId, version) — self-approval and non-admin callers are rejected by the server.',
      },
      skillId: {
        type: 'string',
        description:
          'Skill ID in author/name format (get/deprecate/undeprecate/install/approve/reject)',
      },
      version: {
        type: 'string',
        description:
          'Version filter; required for approve/reject; "install" defaults to the most ' +
          'recently published',
      },
      force: { type: 'boolean', description: 'Reinstall over an existing install' },
      includeDeprecated: {
        type: 'boolean',
        description:
          'Action "list" only: include deprecated versions (default hides them). No effect on ' +
          '"get"/"install", which always exclude deprecated versions, even by exact version.',
      },
      status: {
        type: 'string',
        enum: ['pending', 'approved', 'rejected'],
        description: 'Filter for action "submissions"; omit for everything visible to you',
      },
      note: {
        type: 'string',
        description: 'Optional reviewer note for action "approve"/"reject" (max 1000 chars)',
      },
    },
    required: ['action'],
  },
}
