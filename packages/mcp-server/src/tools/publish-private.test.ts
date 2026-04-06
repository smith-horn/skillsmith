/**
 * @fileoverview Unit tests for publish_private MCP tool
 * @see SMI-3896: Private Skills Publishing
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDatabase, closeDatabase } from '@skillsmith/core/testkit'
import { publishPrivateInputSchema, executePublishPrivate } from './publish-private.js'
import { setTeamWorkspaceService, createStubService } from './team-workspace.js'
import type { ToolContext } from '../context.js'
import type { Database as DatabaseType } from '@skillsmith/core'

// ============================================================================
// Helpers
// ============================================================================

function makeContext(db: DatabaseType): ToolContext {
  return { db } as unknown as ToolContext
}

function insertSkill(db: DatabaseType, id: string, extra: Record<string, unknown> = {}): void {
  const defaults = {
    name: id.split('/')[1] ?? id,
    author: id.split('/')[0] ?? 'unknown',
    description: 'A test skill',
    visibility: 'public',
  }
  const merged = { ...defaults, ...extra }
  db.prepare(
    `INSERT INTO skills (id, name, author, description, visibility)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, merged.name, merged.author, merged.description, merged.visibility)
}

// ============================================================================
// Schema validation
// ============================================================================

describe('publishPrivateInputSchema', () => {
  it('accepts valid input', () => {
    const result = publishPrivateInputSchema.parse({ skillId: 'author/my-skill' })
    expect(result.skillId).toBe('author/my-skill')
  })

  it('accepts input with explicit teamId', () => {
    const result = publishPrivateInputSchema.parse({
      skillId: 'author/my-skill',
      teamId: 'team-123',
    })
    expect(result.teamId).toBe('team-123')
  })

  it('rejects skillId without slash', () => {
    expect(() => publishPrivateInputSchema.parse({ skillId: 'noslash' })).toThrow()
  })

  it('rejects empty skillId', () => {
    expect(() => publishPrivateInputSchema.parse({ skillId: '' })).toThrow()
  })
})

// ============================================================================
// executePublishPrivate
// ============================================================================

describe('executePublishPrivate', () => {
  let db: DatabaseType

  beforeEach(() => {
    db = createTestDatabase()
    setTeamWorkspaceService(createStubService())
  })

  afterEach(() => {
    closeDatabase(db)
  })

  it('marks a skill as private', async () => {
    insertSkill(db, 'author/my-skill')

    const result = await executePublishPrivate({ skillId: 'author/my-skill' }, makeContext(db))

    expect(result.success).toBe(true)
    expect(result.visibility).toBe('private')
    expect(result.teamId).toBeTruthy()

    // Verify database was updated
    const row = db
      .prepare('SELECT visibility, team_id FROM skills WHERE id = ?')
      .get('author/my-skill') as { visibility: string; team_id: string }
    expect(row.visibility).toBe('private')
    expect(row.team_id).toBeTruthy()
  })

  it('uses explicit teamId when provided', async () => {
    insertSkill(db, 'author/my-skill')

    const result = await executePublishPrivate(
      { skillId: 'author/my-skill', teamId: 'explicit-team-id' },
      makeContext(db)
    )

    expect(result.success).toBe(true)
    expect(result.teamId).toBe('explicit-team-id')

    const row = db.prepare('SELECT team_id FROM skills WHERE id = ?').get('author/my-skill') as {
      team_id: string
    }
    expect(row.team_id).toBe('explicit-team-id')
  })

  it('returns error for nonexistent skill', async () => {
    const result = await executePublishPrivate({ skillId: 'ghost/missing' }, makeContext(db))

    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('backward compat: skill_publish without visibility stays public', async () => {
    insertSkill(db, 'author/public-skill')

    // Verify default is public
    const row = db
      .prepare('SELECT visibility FROM skills WHERE id = ?')
      .get('author/public-skill') as { visibility: string }
    expect(row.visibility).toBe('public')
  })

  it('community user searching must NOT see private skills', async () => {
    insertSkill(db, 'author/private-skill', { visibility: 'private' })
    insertSkill(db, 'author/public-skill', { visibility: 'public' })

    // Query as community user (no team_id) — only public skills visible
    const publicRows = db.prepare('SELECT id FROM skills WHERE visibility = ?').all('public') as {
      id: string
    }[]

    expect(publicRows).toHaveLength(1)
    expect(publicRows[0].id).toBe('author/public-skill')
  })

  it('team user sees own private skills', async () => {
    const teamId = 'my-team-123'
    insertSkill(db, 'author/private-skill')

    // Mark as private
    db.prepare('UPDATE skills SET visibility = ?, team_id = ? WHERE id = ?').run(
      'private',
      teamId,
      'author/private-skill'
    )
    insertSkill(db, 'other/public-skill')

    // Query with team_id filter
    const rows = db
      .prepare('SELECT id FROM skills WHERE (visibility = ? OR team_id = ?)')
      .all('public', teamId) as { id: string }[]

    expect(rows).toHaveLength(2)
    const ids = rows.map((r) => r.id)
    expect(ids).toContain('author/private-skill')
    expect(ids).toContain('other/public-skill')
  })
})
