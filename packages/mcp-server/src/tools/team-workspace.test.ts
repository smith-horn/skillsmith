/**
 * @fileoverview Unit tests for team_workspace and share_skill MCP tools
 * @see SMI-3895: Team Workspace + Share Skill MCP Tools
 * @see SMI-3898: Skill Sharing Controls
 * @see SMI-4292: Wave 5A — live Supabase integration + typed error paths
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  teamWorkspaceInputSchema,
  shareSkillInputSchema,
  executeTeamWorkspace,
  executeShareSkill,
  createStubService,
  setTeamWorkspaceService,
  matchesPattern,
  checkSharingPolicy,
  type TeamWorkspaceService,
  type SharingPolicy,
} from './team-workspace.js'
import type { ToolContext } from '../context.js'

// Mock isSupabaseConfigured so we can flip between 'stub' and 'live' modes
vi.mock('../supabase-client.js', () => ({
  isSupabaseConfigured: vi.fn(() => false),
  getSupabaseClient: vi.fn(),
  getSupabaseAdminClient: vi.fn(),
  resetSupabaseClients: vi.fn(),
}))

// ============================================================================
// Helpers
// ============================================================================

function makeContext(): ToolContext {
  return {} as unknown as ToolContext
}

// ============================================================================
// Schema validation
// ============================================================================

describe('teamWorkspaceInputSchema', () => {
  it('accepts valid create input', () => {
    const result = teamWorkspaceInputSchema.parse({
      action: 'create',
      name: 'My Workspace',
      description: 'A test workspace',
    })
    expect(result.action).toBe('create')
    expect(result.name).toBe('My Workspace')
  })

  it('accepts list action with no extra fields', () => {
    const result = teamWorkspaceInputSchema.parse({ action: 'list' })
    expect(result.action).toBe('list')
  })

  it('accepts get action with workspaceId', () => {
    const result = teamWorkspaceInputSchema.parse({
      action: 'get',
      workspaceId: '00000000-0000-0000-0000-000000000001',
    })
    expect(result.workspaceId).toBeDefined()
  })

  it('rejects invalid action', () => {
    expect(() => teamWorkspaceInputSchema.parse({ action: 'invalid' })).toThrow()
  })

  it('rejects non-UUID workspaceId', () => {
    expect(() =>
      teamWorkspaceInputSchema.parse({ action: 'get', workspaceId: 'not-a-uuid' })
    ).toThrow()
  })
})

describe('shareSkillInputSchema', () => {
  it('accepts valid add input', () => {
    const result = shareSkillInputSchema.parse({
      action: 'add',
      workspaceId: '00000000-0000-0000-0000-000000000001',
      skillId: 'author/skill-name',
    })
    expect(result.action).toBe('add')
    expect(result.skillId).toBe('author/skill-name')
  })

  it('accepts list action without skillId', () => {
    const result = shareSkillInputSchema.parse({
      action: 'list',
      workspaceId: '00000000-0000-0000-0000-000000000001',
    })
    expect(result.action).toBe('list')
  })

  it('rejects invalid skillId format', () => {
    expect(() =>
      shareSkillInputSchema.parse({
        action: 'add',
        workspaceId: '00000000-0000-0000-0000-000000000001',
        skillId: 'no-slash',
      })
    ).toThrow()
  })

  it('rejects missing workspaceId', () => {
    expect(() => shareSkillInputSchema.parse({ action: 'list' })).toThrow()
  })
})

// ============================================================================
// Pattern matching (SMI-3898)
// ============================================================================

describe('matchesPattern', () => {
  it('matches exact skill ID', () => {
    expect(matchesPattern('author/skill', 'author/skill')).toBe(true)
  })

  it('matches wildcard author', () => {
    expect(matchesPattern('author/skill', '*/skill')).toBe(true)
  })

  it('matches wildcard name', () => {
    expect(matchesPattern('author/skill', 'author/*')).toBe(true)
  })

  it('matches double wildcard', () => {
    expect(matchesPattern('author/skill', '*/*')).toBe(true)
  })

  it('rejects mismatched author', () => {
    expect(matchesPattern('author/skill', 'other/skill')).toBe(false)
  })

  it('rejects mismatched name', () => {
    expect(matchesPattern('author/skill', 'author/other')).toBe(false)
  })

  it('rejects malformed pattern', () => {
    expect(matchesPattern('author/skill', 'noslash')).toBe(false)
  })
})

describe('checkSharingPolicy', () => {
  it('returns null when no policy', () => {
    expect(checkSharingPolicy('author/skill', undefined)).toBeNull()
  })

  it('returns null when policy has empty lists', () => {
    const policy: SharingPolicy = { requireApproval: false, allowList: [], denyList: [] }
    expect(checkSharingPolicy('author/skill', policy)).toBeNull()
  })

  it('returns error when skill matches deny list', () => {
    const policy: SharingPolicy = {
      requireApproval: false,
      allowList: [],
      denyList: ['untrusted/*'],
    }
    const result = checkSharingPolicy('untrusted/evil-skill', policy)
    expect(result).toContain('blocked by the workspace deny list')
  })

  it('returns null when skill does NOT match deny list', () => {
    const policy: SharingPolicy = {
      requireApproval: false,
      allowList: [],
      denyList: ['untrusted/*'],
    }
    expect(checkSharingPolicy('trusted/good-skill', policy)).toBeNull()
  })

  it('returns error when skill not in allow list', () => {
    const policy: SharingPolicy = {
      requireApproval: false,
      allowList: ['approved/*'],
      denyList: [],
    }
    const result = checkSharingPolicy('other/skill', policy)
    expect(result).toContain('not in the workspace allow list')
  })

  it('returns null when skill matches allow list', () => {
    const policy: SharingPolicy = {
      requireApproval: false,
      allowList: ['approved/*'],
      denyList: [],
    }
    expect(checkSharingPolicy('approved/skill', policy)).toBeNull()
  })

  it('deny list takes precedence over allow list', () => {
    const policy: SharingPolicy = {
      requireApproval: false,
      allowList: ['*/*'],
      denyList: ['evil/*'],
    }
    const result = checkSharingPolicy('evil/skill', policy)
    expect(result).toContain('blocked by the workspace deny list')
  })
})

// ============================================================================
// executeTeamWorkspace
// ============================================================================

describe('executeTeamWorkspace', () => {
  beforeEach(() => {
    setTeamWorkspaceService(createStubService())
  })

  it('creates a workspace', async () => {
    const result = await executeTeamWorkspace({ action: 'create', name: 'Dev Team' }, makeContext())
    expect(result.success).toBe(true)
    expect(result.workspace).toBeDefined()
    expect(result.workspace!.name).toBe('Dev Team')
  })

  it('returns error when create missing name', async () => {
    const result = await executeTeamWorkspace({ action: 'create' }, makeContext())
    expect(result.success).toBe(false)
    expect(result.error).toContain('Name is required')
  })

  it('lists workspaces', async () => {
    await executeTeamWorkspace({ action: 'create', name: 'WS1' }, makeContext())
    await executeTeamWorkspace({ action: 'create', name: 'WS2' }, makeContext())
    const result = await executeTeamWorkspace({ action: 'list' }, makeContext())
    expect(result.success).toBe(true)
    expect(result.workspaces).toHaveLength(2)
  })

  it('gets a workspace by ID', async () => {
    const created = await executeTeamWorkspace({ action: 'create', name: 'Test' }, makeContext())
    const result = await executeTeamWorkspace(
      { action: 'get', workspaceId: created.workspace!.id },
      makeContext()
    )
    expect(result.success).toBe(true)
    expect(result.workspace!.name).toBe('Test')
  })

  it('returns error for get without workspaceId', async () => {
    const result = await executeTeamWorkspace({ action: 'get' }, makeContext())
    expect(result.success).toBe(false)
    expect(result.error).toContain('workspaceId is required')
  })

  it('returns error for nonexistent workspace', async () => {
    const result = await executeTeamWorkspace(
      { action: 'get', workspaceId: '00000000-0000-0000-0000-000000000099' },
      makeContext()
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('deletes a workspace', async () => {
    const created = await executeTeamWorkspace(
      { action: 'create', name: 'ToDelete' },
      makeContext()
    )
    const result = await executeTeamWorkspace(
      { action: 'delete', workspaceId: created.workspace!.id },
      makeContext()
    )
    expect(result.success).toBe(true)
    expect(result.message).toContain('deleted')
  })

  it('returns error deleting nonexistent workspace', async () => {
    const result = await executeTeamWorkspace(
      { action: 'delete', workspaceId: '00000000-0000-0000-0000-000000000099' },
      makeContext()
    )
    expect(result.success).toBe(false)
  })

  // SMI-4292: Typed error when Supabase live but license key missing
  it('returns typed error in live mode when SKILLSMITH_LICENSE_KEY is missing', async () => {
    const { isSupabaseConfigured } = await import('../supabase-client.js')
    vi.mocked(isSupabaseConfigured).mockReturnValueOnce(true)
    const orig = process.env.SKILLSMITH_LICENSE_KEY
    delete process.env.SKILLSMITH_LICENSE_KEY
    try {
      const result = await executeTeamWorkspace({ action: 'list' }, makeContext())
      expect(result.success).toBe(false)
      expect(result.dataSource).toBe('live')
      expect(result.error).toContain('SKILLSMITH_LICENSE_KEY')
    } finally {
      if (orig !== undefined) process.env.SKILLSMITH_LICENSE_KEY = orig
    }
  })
})

// ============================================================================
// executeShareSkill
// ============================================================================

describe('executeShareSkill', () => {
  let wsId: string

  beforeEach(async () => {
    setTeamWorkspaceService(createStubService())
    // Create a workspace for sharing tests
    const ws = await executeTeamWorkspace({ action: 'create', name: 'Share Test' }, makeContext())
    wsId = ws.workspace!.id
  })

  it('adds a skill to workspace', async () => {
    const result = await executeShareSkill(
      { action: 'add', workspaceId: wsId, skillId: 'author/my-skill' },
      makeContext()
    )
    expect(result.success).toBe(true)
    expect(result.skills).toHaveLength(1)
    expect(result.skills![0].skillId).toBe('author/my-skill')
  })

  it('returns error when add missing skillId', async () => {
    const result = await executeShareSkill({ action: 'add', workspaceId: wsId }, makeContext())
    expect(result.success).toBe(false)
    expect(result.error).toContain('skillId is required')
  })

  it('lists shared skills', async () => {
    await executeShareSkill({ action: 'add', workspaceId: wsId, skillId: 'a/one' }, makeContext())
    await executeShareSkill({ action: 'add', workspaceId: wsId, skillId: 'b/two' }, makeContext())
    const result = await executeShareSkill({ action: 'list', workspaceId: wsId }, makeContext())
    expect(result.success).toBe(true)
    expect(result.skills).toHaveLength(2)
  })

  it('removes a skill from workspace', async () => {
    await executeShareSkill({ action: 'add', workspaceId: wsId, skillId: 'a/one' }, makeContext())
    const result = await executeShareSkill(
      { action: 'remove', workspaceId: wsId, skillId: 'a/one' },
      makeContext()
    )
    expect(result.success).toBe(true)
    expect(result.message).toContain('removed')
  })

  it('returns error removing nonexistent skill', async () => {
    const result = await executeShareSkill(
      { action: 'remove', workspaceId: wsId, skillId: 'a/nonexistent' },
      makeContext()
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })

  // SMI-4292: Typed error when Supabase live but license key missing
  it('returns typed error in live mode when SKILLSMITH_LICENSE_KEY is missing', async () => {
    const { isSupabaseConfigured } = await import('../supabase-client.js')
    vi.mocked(isSupabaseConfigured).mockReturnValueOnce(true)
    const orig = process.env.SKILLSMITH_LICENSE_KEY
    delete process.env.SKILLSMITH_LICENSE_KEY
    try {
      const result = await executeShareSkill({ action: 'list', workspaceId: wsId }, makeContext())
      expect(result.success).toBe(false)
      expect(result.dataSource).toBe('live')
      expect(result.error).toContain('SKILLSMITH_LICENSE_KEY')
    } finally {
      if (orig !== undefined) process.env.SKILLSMITH_LICENSE_KEY = orig
    }
  })

  // SMI-3898: Deny list enforcement
  it('rejects skill matching deny list pattern', async () => {
    // Create a service with deny list
    const svc = createStubService()
    // Override getWorkspaceSettings to return a deny list
    const origCreate = svc.createWorkspace.bind(svc)
    const origGetSettings = svc.getWorkspaceSettings.bind(svc)

    // We need a custom service that returns settings with a deny list
    const customSvc: TeamWorkspaceService = {
      ...svc,
      createWorkspace: origCreate,
      async getWorkspaceSettings(teamId, workspaceId) {
        const base = await origGetSettings(teamId, workspaceId)
        return {
          ...base,
          sharing: {
            requireApproval: false,
            allowList: [],
            denyList: ['evil-author/*'],
          },
        }
      },
    }
    setTeamWorkspaceService(customSvc)

    const ws = await executeTeamWorkspace({ action: 'create', name: 'Policy Test' }, makeContext())
    const result = await executeShareSkill(
      { action: 'add', workspaceId: ws.workspace!.id, skillId: 'evil-author/bad-skill' },
      makeContext()
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('blocked by the workspace deny list')
  })
})
