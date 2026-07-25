/**
 * @fileoverview Private registry MCP tools for enterprise skill management
 * @module @skillsmith/mcp-server/tools/registry-tools
 * @see SMI-3902: Private Registry MCP Tools (original stub)
 * @see SMI-5816: Private skill registry — real implementation
 * @see ADR-129: Postgres-native (JSONB) storage + real team-auth (migration 071)
 *
 * Enables enterprise teams to publish and manage skills in a private registry
 * scoped to their organization. Both metadata and packaged content live in the
 * `private_registry_skills` Postgres table (JSONB content, not S3 — ADR-129);
 * team-scoped RLS + an in-query team_id filter on the service-role path (ADR-116).
 *
 * Backing service is selected at module load: the live Supabase-backed service
 * (registry-tools.live.ts) when Supabase is configured, else an in-memory stub
 * (registry-tools.stub.ts) for local dev / tests.
 *
 * Tier gate: Enterprise (private_registry feature flag — toolFeatureMapping.ts).
 */

import { z } from 'zod'
import type { ToolContext } from '../context.js'
import { isSupabaseConfigured } from '../supabase-client.js'
import { resolveLicenseTeamId, readLicenseKey } from './team-resolver.js'
import { withTelemetry } from '@skillsmith/core/telemetry'
import { createStubRegistryService } from './registry-tools.stub.js'
import { createLiveRegistryService } from './registry-tools.live.js'

// Re-export stub factory for external consumers and tests
export { createStubRegistryService } from './registry-tools.stub.js'

// ============================================================================
// Input schemas
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
  action: z.enum(['list', 'get', 'deprecate', 'undeprecate']),
  skillId: z
    .string()
    .regex(/^[^/]+\/[^/]+$/, 'Must be author/name format')
    .optional()
    .describe('Skill identifier (required for get/deprecate/undeprecate)'),
  version: z.string().optional().describe('Optional version filter'),
})

export type PrivateRegistryManageInput = z.infer<typeof privateRegistryManageInputSchema>

// ============================================================================
// Tool schemas for MCP registration
// ============================================================================

export const privateRegistryPublishToolSchema = {
  name: 'private_registry_publish' as const,
  description:
    "Publish a skill to your organization's private registry. " +
    'Requires Enterprise tier (private_registry feature). ' +
    'Skills are scoped to your team namespace and published versions are immutable.',
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
    'Manage skills in your private registry (list, get, deprecate, undeprecate). ' +
    'Requires Enterprise tier (private_registry feature).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'get', 'deprecate', 'undeprecate'],
        description: 'Registry operation to perform',
      },
      skillId: {
        type: 'string',
        description: 'Skill ID in author/name format (required for get/deprecate/undeprecate)',
      },
      version: {
        type: 'string',
        description: 'Optional version filter',
      },
    },
    required: ['action'],
  },
}

// ============================================================================
// Output types
// ============================================================================

export interface RegistrySkill {
  skillId: string
  version: string
  description: string | null
  deprecated: boolean
  publishedAt: string
  publishedBy: string
  registryUrl: string
}

export interface PrivateRegistryPublishResult {
  success: boolean
  dataSource: 'stub' | 'live'
  skill?: RegistrySkill
  message?: string
  error?: string
}

export interface PrivateRegistryManageResult {
  success: boolean
  dataSource: 'stub' | 'live'
  skills?: RegistrySkill[]
  skill?: RegistrySkill
  message?: string
  error?: string
}

// ============================================================================
// Service interface
// ============================================================================

/**
 * PrivateRegistryService — team-scoped private registry CRUD.
 *
 * **Invariant (ADR-116)**: every method MUST treat `teamId` as the authoritative
 * scoping key and include an explicit `team_id = <teamId>` filter in the query.
 * The live Supabase implementation uses the service-role client, which bypasses
 * RLS — tenant isolation is enforced in the service, not the database.
 *
 * @see packages/mcp-server/src/tools/registry-tools.live.ts
 * @see docs/internal/adr/129-private-skill-registry-real-implementation.md
 */
export interface PrivateRegistryService {
  publish(
    teamId: string,
    skillId: string,
    version: string,
    content: SkillContent,
    description?: string
  ): Promise<RegistrySkill>
  list(teamId: string, version?: string): Promise<RegistrySkill[]>
  get(teamId: string, skillId: string, version?: string): Promise<RegistrySkill | null>
  deprecate(teamId: string, skillId: string): Promise<boolean>
  undeprecate(teamId: string, skillId: string): Promise<boolean>
}

/**
 * Module-level singleton. Picks the live Supabase-backed service when
 * SUPABASE_URL + SUPABASE_ANON_KEY are configured; otherwise the in-memory stub
 * (local dev / tests).
 */
let service: PrivateRegistryService = isSupabaseConfigured()
  ? createLiveRegistryService()
  : createStubRegistryService()

/** Replace the registry service implementation (for testing or production swap) */
export function setPrivateRegistryService(svc: PrivateRegistryService): void {
  service = svc
}

/** Get the current registry service instance */
export function getPrivateRegistryService(): PrivateRegistryService {
  return service
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * Resolve team ID from license key.
 *
 * SMI-4292 (finding C3): unified resolution — calls the same
 * `resolve_team_from_license` RPC as team-workspace.ts. When Supabase is
 * configured but the license key is missing/invalid, the caller receives
 * a typed error (bubbled up via thrown Error).
 *
 * Falls back to a static stub id when Supabase is not configured (local dev).
 */
async function resolveTeamId(): Promise<string> {
  if (!isSupabaseConfigured()) return 'team_stub_00000000-0000-0000-0000-000000000000'
  const licenseKey = readLicenseKey()
  if (!licenseKey) {
    throw new Error(
      'SKILLSMITH_LICENSE_KEY is required for private registry operations. ' +
        'Set it in your MCP server config — shell exports do not reach MCP subprocesses.'
    )
  }
  const teamId = await resolveLicenseTeamId(licenseKey)
  if (!teamId) {
    throw new Error(
      'Unable to resolve team from license key. Ensure the key is active and attached to an Enterprise-tier subscription.'
    )
  }
  return teamId
}

/**
 * Execute a private_registry_publish operation.
 */
async function executePrivateRegistryPublishImpl(
  input: PrivateRegistryPublishInput,
  _context: ToolContext
): Promise<PrivateRegistryPublishResult> {
  const dataSource: 'stub' | 'live' = isSupabaseConfigured() ? 'live' : 'stub'
  let teamId: string
  try {
    teamId = await resolveTeamId()
  } catch (err) {
    return {
      success: false,
      dataSource,
      error: err instanceof Error ? err.message : 'Failed to resolve team from license key.',
    }
  }

  // Service errors (immutability conflict, size cap, missing SKILL.md, missing
  // service-role key) surface as typed {success:false} results, not exceptions.
  try {
    const skill = await service.publish(
      teamId,
      input.skillId,
      input.version,
      input.content,
      input.description
    )
    return {
      success: true,
      dataSource,
      skill,
      message:
        `Published ${input.skillId}@${input.version} to private registry.\n` +
        `Registry URL: ${skill.registryUrl}`,
    }
  } catch (err) {
    return {
      success: false,
      dataSource,
      error: err instanceof Error ? err.message : 'Failed to publish skill.',
    }
  }
}

/**
 * Execute a private_registry_manage operation.
 */
async function executePrivateRegistryManageImpl(
  input: PrivateRegistryManageInput,
  _context: ToolContext
): Promise<PrivateRegistryManageResult> {
  const dataSource: 'stub' | 'live' = isSupabaseConfigured() ? 'live' : 'stub'
  let teamId: string
  try {
    teamId = await resolveTeamId()
  } catch (err) {
    return {
      success: false,
      dataSource,
      error: err instanceof Error ? err.message : 'Failed to resolve team from license key.',
    }
  }

  // Wrap service calls so live-mode errors (e.g. missing service-role key) surface
  // as typed {success:false} results instead of propagating as unhandled exceptions.
  try {
    switch (input.action) {
      case 'list': {
        const skills = await service.list(teamId, input.version)
        return {
          success: true,
          dataSource,
          skills,
          message: `Found ${skills.length} skill(s) in private registry.`,
        }
      }

      case 'get': {
        if (!input.skillId) {
          return { success: false, dataSource, error: 'skillId is required for action "get".' }
        }
        const skill = await service.get(teamId, input.skillId, input.version)
        if (!skill) {
          return {
            success: false,
            dataSource,
            error: `Skill "${input.skillId}" not found in private registry.`,
          }
        }
        return { success: true, dataSource, skill }
      }

      case 'deprecate': {
        if (!input.skillId) {
          return {
            success: false,
            dataSource,
            error: 'skillId is required for action "deprecate".',
          }
        }
        const deprecated = await service.deprecate(teamId, input.skillId)
        if (!deprecated) {
          return {
            success: false,
            dataSource,
            error: `Skill "${input.skillId}" not found in private registry.`,
          }
        }
        return {
          success: true,
          dataSource,
          message: `Skill "${input.skillId}" has been deprecated. It will no longer appear in search results.`,
        }
      }

      case 'undeprecate': {
        if (!input.skillId) {
          return {
            success: false,
            dataSource,
            error: 'skillId is required for action "undeprecate".',
          }
        }
        const undeprecated = await service.undeprecate(teamId, input.skillId)
        if (!undeprecated) {
          return {
            success: false,
            dataSource,
            error: `Skill "${input.skillId}" not found in private registry.`,
          }
        }
        return {
          success: true,
          dataSource,
          message: `Skill "${input.skillId}" has been undeprecated and is now visible in search results.`,
        }
      }
    }
  } catch (err) {
    return {
      success: false,
      dataSource,
      error: err instanceof Error ? err.message : 'Registry operation failed.',
    }
  }
}

// SMI-5017 W2.S2: wrap at export boundary
export const executePrivateRegistryPublish = withTelemetry(executePrivateRegistryPublishImpl, {
  source: 'mcp-tool',
  extractSkillId: () => 'private_registry_publish',
  extractFramework: () => 'unknown',
})
export const executePrivateRegistryManage = withTelemetry(executePrivateRegistryManageImpl, {
  source: 'mcp-tool',
  extractSkillId: () => 'private_registry_manage',
  extractFramework: () => 'unknown',
})
