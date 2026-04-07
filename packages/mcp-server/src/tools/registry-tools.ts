/**
 * @fileoverview Private registry MCP tools for enterprise skill management
 * @module @skillsmith/mcp-server/tools/registry-tools
 * @see SMI-3902: Private Registry MCP Tools
 * @see ADR-115: Private Registry Architecture
 *
 * Enables enterprise teams to publish and manage skills in a private registry
 * scoped to their organization. Metadata lives in Supabase with team-scoped
 * RLS; tarballs are stored in S3-compatible object storage.
 *
 * Tier gate: Enterprise (private_registry feature flag).
 */

import { z } from 'zod'
import type { ToolContext } from '../context.js'

// ============================================================================
// Input schemas
// ============================================================================

export const privateRegistryPublishInputSchema = z.object({
  skillId: z
    .string()
    .regex(/^[^/]+\/[^/]+$/, 'Must be author/name format')
    .describe('Skill identifier in author/name format'),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+/, 'Must be a valid semver version')
    .describe('Semver version to publish'),
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
    'Skills are scoped to your team namespace.',
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
      description: {
        type: 'string',
        description: 'Optional skill description',
      },
    },
    required: ['skillId', 'version'],
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
  skill?: RegistrySkill
  message?: string
  error?: string
}

export interface PrivateRegistryManageResult {
  success: boolean
  skills?: RegistrySkill[]
  skill?: RegistrySkill
  message?: string
  error?: string
}

// ============================================================================
// Service interface (stub now, Supabase + S3 later)
// ============================================================================

export interface PrivateRegistryService {
  publish(
    teamId: string,
    skillId: string,
    version: string,
    description?: string
  ): Promise<RegistrySkill>
  list(teamId: string, version?: string): Promise<RegistrySkill[]>
  get(teamId: string, skillId: string, version?: string): Promise<RegistrySkill | null>
  deprecate(teamId: string, skillId: string): Promise<boolean>
  undeprecate(teamId: string, skillId: string): Promise<boolean>
}

// ============================================================================
// Stub service (returns realistic mock data)
// ============================================================================

/** @internal Exported for testing */
export function createStubRegistryService(): PrivateRegistryService {
  const registry = new Map<string, RegistrySkill>()

  return {
    async publish(teamId, skillId, version, description) {
      const skill: RegistrySkill = {
        skillId,
        version,
        description: description ?? null,
        deprecated: false,
        publishedAt: new Date().toISOString(),
        publishedBy: 'current-user',
        registryUrl: `https://registry.skillsmith.app/private/${teamId}/${skillId}@${version}`,
      }
      registry.set(skillId, skill)
      return skill
    },

    async list(_teamId, version) {
      const all = [...registry.values()]
      if (version) return all.filter((s) => s.version === version)
      return all
    },

    async get(_teamId, skillId, version) {
      const skill = registry.get(skillId)
      if (!skill) return null
      if (version && skill.version !== version) return null
      return skill
    },

    async deprecate(_teamId, skillId) {
      const skill = registry.get(skillId)
      if (!skill) return false
      skill.deprecated = true
      return true
    },

    async undeprecate(_teamId, skillId) {
      const skill = registry.get(skillId)
      if (!skill) return false
      skill.deprecated = false
      return true
    },
  }
}

// Module-level singleton
let service: PrivateRegistryService = createStubRegistryService()

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
 * TODO: Replace with Supabase RPC when Supabase integration is ready.
 */
async function resolveTeamId(): Promise<string> {
  return 'team_stub_00000000-0000-0000-0000-000000000000'
}

/**
 * Execute a private_registry_publish operation.
 */
export async function executePrivateRegistryPublish(
  input: PrivateRegistryPublishInput,
  _context: ToolContext
): Promise<PrivateRegistryPublishResult> {
  const teamId = await resolveTeamId()

  const skill = await service.publish(teamId, input.skillId, input.version, input.description)
  return {
    success: true,
    skill,
    message:
      `Published ${input.skillId}@${input.version} to private registry.\n` +
      `Registry URL: ${skill.registryUrl}`,
  }
}

/**
 * Execute a private_registry_manage operation.
 */
export async function executePrivateRegistryManage(
  input: PrivateRegistryManageInput,
  _context: ToolContext
): Promise<PrivateRegistryManageResult> {
  const teamId = await resolveTeamId()

  switch (input.action) {
    case 'list': {
      const skills = await service.list(teamId, input.version)
      return {
        success: true,
        skills,
        message: `Found ${skills.length} skill(s) in private registry.`,
      }
    }

    case 'get': {
      if (!input.skillId) {
        return { success: false, error: 'skillId is required for action "get".' }
      }
      const skill = await service.get(teamId, input.skillId, input.version)
      if (!skill) {
        return { success: false, error: `Skill "${input.skillId}" not found in private registry.` }
      }
      return { success: true, skill }
    }

    case 'deprecate': {
      if (!input.skillId) {
        return { success: false, error: 'skillId is required for action "deprecate".' }
      }
      const deprecated = await service.deprecate(teamId, input.skillId)
      if (!deprecated) {
        return { success: false, error: `Skill "${input.skillId}" not found in private registry.` }
      }
      return {
        success: true,
        message: `Skill "${input.skillId}" has been deprecated. It will no longer appear in search results.`,
      }
    }

    case 'undeprecate': {
      if (!input.skillId) {
        return { success: false, error: 'skillId is required for action "undeprecate".' }
      }
      const undeprecated = await service.undeprecate(teamId, input.skillId)
      if (!undeprecated) {
        return { success: false, error: `Skill "${input.skillId}" not found in private registry.` }
      }
      return {
        success: true,
        message: `Skill "${input.skillId}" has been undeprecated and is now visible in search results.`,
      }
    }
  }
}
