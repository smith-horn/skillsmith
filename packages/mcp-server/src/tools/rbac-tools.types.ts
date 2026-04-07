/**
 * @fileoverview RBAC types and stub service
 * @module @skillsmith/mcp-server/tools/rbac-tools.types
 * @see SMI-3901: RBAC MCP Tools
 *
 * Extracted from rbac-tools.ts to stay under the 500-line file-size gate.
 */

// ============================================================================
// Service types
// ============================================================================

export interface RBACRole {
  id: string
  name: string
  description: string | null
  permissions: string[]
  hierarchy: number
  createdAt: string
}

export interface RBACAssignment {
  userId: string
  roleId: string
  roleName: string
  assignedAt: string
  assignedBy: string
}

export interface RBACPolicy {
  id: string
  name: string
  effect: 'allow' | 'deny'
  resources: string[]
  actions: string[]
  createdAt: string
}

export interface RBACService {
  createRole(name: string, permissions?: string[], description?: string): Promise<RBACRole>
  listRoles(): Promise<RBACRole[]>
  getRole(roleId: string): Promise<RBACRole | null>
  deleteRole(roleId: string): Promise<boolean>
  assignRole(userId: string, roleId: string): Promise<RBACAssignment>
  revokeRole(userId: string, roleId: string): Promise<boolean>
  listAssignments(): Promise<RBACAssignment[]>
  createPolicy(
    name: string,
    effect: 'allow' | 'deny',
    resources: string[],
    actions: string[]
  ): Promise<RBACPolicy>
  listPolicies(): Promise<RBACPolicy[]>
  getPolicy(policyId: string): Promise<RBACPolicy | null>
  deletePolicy(policyId: string): Promise<boolean>
}

// ============================================================================
// Result types
// ============================================================================

export interface RbacManageResult {
  success: boolean
  dataSource: 'stub' | 'live'
  role?: RBACRole
  roles?: RBACRole[]
  message?: string
  error?: string
}

export interface RbacAssignRoleResult {
  success: boolean
  dataSource: 'stub' | 'live'
  assignment?: RBACAssignment
  assignments?: RBACAssignment[]
  message?: string
  error?: string
}

export interface RbacCreatePolicyResult {
  success: boolean
  dataSource: 'stub' | 'live'
  policy?: RBACPolicy
  policies?: RBACPolicy[]
  message?: string
  error?: string
}

// ============================================================================
// Default roles and stub service
// ============================================================================

const DEFAULT_ROLES: RBACRole[] = [
  {
    id: 'role_admin',
    name: 'admin',
    description: 'Full access to all resources',
    permissions: ['*'],
    hierarchy: 100,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'role_manager',
    name: 'manager',
    description: 'Manage team members and skills',
    permissions: ['skills:*', 'team:manage', 'analytics:read'],
    hierarchy: 75,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'role_member',
    name: 'member',
    description: 'Install and use skills',
    permissions: ['skills:read', 'skills:install', 'skills:uninstall'],
    hierarchy: 50,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'role_viewer',
    name: 'viewer',
    description: 'Read-only access',
    permissions: ['skills:read'],
    hierarchy: 25,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
]

/** @internal Exported for testing */
export function createStubRBACService(): RBACService {
  const roles = new Map<string, RBACRole>(DEFAULT_ROLES.map((r) => [r.id, { ...r }]))
  const assignments = new Map<string, RBACAssignment>()
  const policies = new Map<string, RBACPolicy>()
  let nextId = 1

  return {
    async createRole(name, permissions, description) {
      const id = `role_custom_${nextId++}`
      const role: RBACRole = {
        id,
        name,
        description: description ?? null,
        permissions: permissions ?? [],
        hierarchy: 10,
        createdAt: new Date().toISOString(),
      }
      roles.set(id, role)
      return role
    },
    async listRoles() {
      return [...roles.values()].sort((a, b) => b.hierarchy - a.hierarchy)
    },
    async getRole(roleId) {
      return roles.get(roleId) ?? null
    },
    async deleteRole(roleId) {
      if (DEFAULT_ROLES.some((r) => r.id === roleId)) return false
      return roles.delete(roleId)
    },
    async assignRole(userId, roleId) {
      const role = roles.get(roleId)
      const key = `${userId}:${roleId}`
      const assignment: RBACAssignment = {
        userId,
        roleId,
        roleName: role?.name ?? 'unknown',
        assignedAt: new Date().toISOString(),
        assignedBy: 'current-user',
      }
      assignments.set(key, assignment)
      return assignment
    },
    async revokeRole(userId, roleId) {
      return assignments.delete(`${userId}:${roleId}`)
    },
    async listAssignments() {
      return [...assignments.values()]
    },
    async createPolicy(name, effect, resources, actions) {
      const id = `policy_${nextId++}`
      const policy: RBACPolicy = {
        id,
        name,
        effect,
        resources,
        actions,
        createdAt: new Date().toISOString(),
      }
      policies.set(id, policy)
      return policy
    },
    async listPolicies() {
      return [...policies.values()]
    },
    async getPolicy(policyId) {
      return policies.get(policyId) ?? null
    },
    async deletePolicy(policyId) {
      return policies.delete(policyId)
    },
  }
}
