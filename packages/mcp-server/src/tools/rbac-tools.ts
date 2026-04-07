/**
 * @fileoverview Enterprise RBAC MCP tools for role management
 * @module @skillsmith/mcp-server/tools/rbac-tools
 * @see SMI-3901: RBAC MCP Tools
 *
 * RBAC enforcement is at the Supabase API layer (server-side), NOT local MCP.
 * These MCP tools are a management interface only — they configure roles,
 * assignments, and policies that the server enforces.
 *
 * Default role hierarchy: admin > manager > member > viewer.
 *
 * Tier gate: Enterprise (rbac feature flag).
 */

import { z } from 'zod'
import type { ToolContext } from '../context.js'
import { isSupabaseConfigured } from '../supabase-client.js'
import type {
  RBACService,
  RbacManageResult,
  RbacAssignRoleResult,
  RbacCreatePolicyResult,
} from './rbac-tools.types.js'
import { createStubRBACService } from './rbac-tools.types.js'

// Re-export types and stub factory for external consumers
export type {
  RBACRole,
  RBACAssignment,
  RBACPolicy,
  RBACService,
  RbacManageResult,
  RbacAssignRoleResult,
  RbacCreatePolicyResult,
} from './rbac-tools.types.js'
export { createStubRBACService } from './rbac-tools.types.js'

// ============================================================================
// Input schemas
// ============================================================================

export const rbacManageInputSchema = z.object({
  action: z.enum(['create_role', 'list_roles', 'delete_role', 'get_role']),
  name: z.string().min(1).max(64).optional().describe('Role name (required for create_role)'),
  roleId: z.string().optional().describe('Role identifier (required for get_role/delete_role)'),
  permissions: z
    .array(z.string())
    .optional()
    .describe('Permission strings (optional for create_role)'),
  description: z.string().max(256).optional().describe('Role description'),
})

export type RbacManageInput = z.infer<typeof rbacManageInputSchema>

export const rbacAssignRoleInputSchema = z.object({
  action: z.enum(['assign', 'revoke', 'list_assignments']),
  userId: z.string().optional().describe('User identifier (required for assign/revoke)'),
  roleId: z.string().optional().describe('Role identifier (required for assign/revoke)'),
})

export type RbacAssignRoleInput = z.infer<typeof rbacAssignRoleInputSchema>

export const rbacCreatePolicyInputSchema = z.object({
  action: z.enum(['create', 'list', 'delete', 'get']),
  name: z.string().min(1).max(128).optional().describe('Policy name (required for create)'),
  policyId: z.string().optional().describe('Policy identifier (required for get/delete)'),
  effect: z.enum(['allow', 'deny']).optional().describe('Policy effect (required for create)'),
  resources: z.array(z.string()).optional().describe('Resource patterns (required for create)'),
  actions: z.array(z.string()).optional().describe('Action patterns (required for create)'),
})

export type RbacCreatePolicyInput = z.infer<typeof rbacCreatePolicyInputSchema>

// ============================================================================
// Tool schemas for MCP registration
// ============================================================================

export const rbacManageToolSchema = {
  name: 'rbac_manage' as const,
  description:
    'Manage RBAC roles: create_role, list_roles, get_role, delete_role. ' +
    'Default hierarchy: admin > manager > member > viewer. ' +
    'Requires Enterprise tier (rbac feature).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['create_role', 'list_roles', 'delete_role', 'get_role'],
        description: 'RBAC role operation',
      },
      name: { type: 'string', description: 'Role name (required for create_role)' },
      roleId: {
        type: 'string',
        description: 'Role ID (required for get_role/delete_role)',
      },
      permissions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Permission strings (optional for create_role)',
      },
      description: { type: 'string', description: 'Role description' },
    },
    required: ['action'],
  },
}

export const rbacAssignRoleToolSchema = {
  name: 'rbac_assign_role' as const,
  description:
    'Assign or revoke roles for users, or list current assignments. ' +
    'Requires Enterprise tier (rbac feature).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['assign', 'revoke', 'list_assignments'],
        description: 'Assignment operation',
      },
      userId: { type: 'string', description: 'User ID (required for assign/revoke)' },
      roleId: { type: 'string', description: 'Role ID (required for assign/revoke)' },
    },
    required: ['action'],
  },
}

export const rbacCreatePolicyToolSchema = {
  name: 'rbac_create_policy' as const,
  description:
    'Create, list, get, or delete RBAC policies that define access rules. ' +
    'Requires Enterprise tier (rbac feature).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'delete', 'get'],
        description: 'Policy operation',
      },
      name: { type: 'string', description: 'Policy name (required for create)' },
      policyId: { type: 'string', description: 'Policy ID (required for get/delete)' },
      effect: {
        type: 'string',
        enum: ['allow', 'deny'],
        description: 'Policy effect (required for create)',
      },
      resources: {
        type: 'array',
        items: { type: 'string' },
        description: 'Resource patterns (required for create)',
      },
      actions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Action patterns (required for create)',
      },
    },
    required: ['action'],
  },
}

// Module-level singleton
let service: RBACService = createStubRBACService()

/** Replace the RBAC service implementation (for testing or production swap) */
export function setRBACService(svc: RBACService): void {
  service = svc
}

// ============================================================================
// Handlers
// ============================================================================

export async function executeRbacManage(
  input: RbacManageInput,
  _context: ToolContext
): Promise<RbacManageResult> {
  const dataSource: 'stub' | 'live' = isSupabaseConfigured() ? 'live' : 'stub'

  switch (input.action) {
    case 'create_role': {
      if (!input.name)
        return { success: false, dataSource, error: 'name is required for action "create_role".' }
      const role = await service.createRole(input.name, input.permissions, input.description)
      return {
        success: true,
        dataSource,
        role,
        message:
          `## Role Created\n\n` +
          `- **Name:** ${role.name}\n` +
          `- **ID:** ${role.id}\n` +
          `- **Permissions:** ${role.permissions.length ? role.permissions.join(', ') : 'none'}\n` +
          (role.description ? `- **Description:** ${role.description}\n` : ''),
      }
    }
    case 'list_roles': {
      const roles = await service.listRoles()
      const lines = roles.map(
        (r) => `| ${r.name} | ${r.id} | ${r.hierarchy} | ${r.permissions.join(', ')} |`
      )
      return {
        success: true,
        dataSource,
        roles,
        message:
          `## RBAC Roles (${roles.length})\n\n` +
          `| Name | ID | Hierarchy | Permissions |\n` +
          `|------|-----|-----------|-------------|\n` +
          lines.join('\n'),
      }
    }
    case 'get_role': {
      if (!input.roleId)
        return { success: false, dataSource, error: 'roleId is required for action "get_role".' }
      const role = await service.getRole(input.roleId)
      if (!role) return { success: false, dataSource, error: `Role "${input.roleId}" not found.` }
      return { success: true, dataSource, role }
    }
    case 'delete_role': {
      if (!input.roleId)
        return { success: false, dataSource, error: 'roleId is required for action "delete_role".' }
      const deleted = await service.deleteRole(input.roleId)
      if (!deleted)
        return {
          success: false,
          dataSource,
          error: `Role "${input.roleId}" not found or is a built-in role.`,
        }
      return { success: true, dataSource, message: `Role "${input.roleId}" deleted.` }
    }
  }
}

export async function executeRbacAssignRole(
  input: RbacAssignRoleInput,
  _context: ToolContext
): Promise<RbacAssignRoleResult> {
  const dataSource: 'stub' | 'live' = isSupabaseConfigured() ? 'live' : 'stub'

  switch (input.action) {
    case 'assign': {
      if (!input.userId || !input.roleId)
        return {
          success: false,
          dataSource,
          error: 'userId and roleId are required for action "assign".',
        }
      const assignment = await service.assignRole(input.userId, input.roleId)
      return {
        success: true,
        dataSource,
        assignment,
        message:
          `## Role Assigned\n\n` +
          `- **User:** ${assignment.userId}\n` +
          `- **Role:** ${assignment.roleName} (${assignment.roleId})\n` +
          `- **Assigned by:** ${assignment.assignedBy}`,
      }
    }
    case 'revoke': {
      if (!input.userId || !input.roleId)
        return {
          success: false,
          dataSource,
          error: 'userId and roleId are required for action "revoke".',
        }
      const revoked = await service.revokeRole(input.userId, input.roleId)
      if (!revoked)
        return {
          success: false,
          dataSource,
          error: `No assignment found for user "${input.userId}" with role "${input.roleId}".`,
        }
      return {
        success: true,
        dataSource,
        message: `Role "${input.roleId}" revoked from user "${input.userId}".`,
      }
    }
    case 'list_assignments': {
      const assignments = await service.listAssignments()
      return {
        success: true,
        dataSource,
        assignments,
        message:
          `## Role Assignments (${assignments.length})\n\n` +
          (assignments.length === 0
            ? 'No role assignments found.'
            : assignments.map((a) => `- ${a.userId}: ${a.roleName} (${a.roleId})`).join('\n')),
      }
    }
  }
}

export async function executeRbacCreatePolicy(
  input: RbacCreatePolicyInput,
  _context: ToolContext
): Promise<RbacCreatePolicyResult> {
  const dataSource: 'stub' | 'live' = isSupabaseConfigured() ? 'live' : 'stub'

  switch (input.action) {
    case 'create': {
      if (!input.name)
        return { success: false, dataSource, error: 'name is required for action "create".' }
      if (!input.effect)
        return { success: false, dataSource, error: 'effect is required for action "create".' }
      if (!input.resources?.length)
        return { success: false, dataSource, error: 'resources is required for action "create".' }
      if (!input.actions?.length)
        return { success: false, dataSource, error: 'actions is required for action "create".' }
      const policy = await service.createPolicy(
        input.name,
        input.effect,
        input.resources,
        input.actions
      )
      return {
        success: true,
        dataSource,
        policy,
        message:
          `## Policy Created\n\n` +
          `- **Name:** ${policy.name}\n` +
          `- **ID:** ${policy.id}\n` +
          `- **Effect:** ${policy.effect}\n` +
          `- **Resources:** ${policy.resources.join(', ')}\n` +
          `- **Actions:** ${policy.actions.join(', ')}`,
      }
    }
    case 'list': {
      const policies = await service.listPolicies()
      return {
        success: true,
        dataSource,
        policies,
        message:
          `## RBAC Policies (${policies.length})\n\n` +
          (policies.length === 0
            ? 'No policies defined.'
            : policies
                .map((p) => `- **${p.name}** (${p.id}): ${p.effect} ${p.resources.join(', ')}`)
                .join('\n')),
      }
    }
    case 'get': {
      if (!input.policyId)
        return { success: false, dataSource, error: 'policyId is required for action "get".' }
      const policy = await service.getPolicy(input.policyId)
      if (!policy)
        return { success: false, dataSource, error: `Policy "${input.policyId}" not found.` }
      return { success: true, dataSource, policy }
    }
    case 'delete': {
      if (!input.policyId)
        return { success: false, dataSource, error: 'policyId is required for action "delete".' }
      const deleted = await service.deletePolicy(input.policyId)
      if (!deleted)
        return { success: false, dataSource, error: `Policy "${input.policyId}" not found.` }
      return { success: true, dataSource, message: `Policy "${input.policyId}" deleted.` }
    }
  }
}
