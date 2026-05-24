// SMI-5177 (Phase 2a): repositoryToSkill forward-populates `compatibility` from
// skill_path so the migration backfill only ever covers pre-existing rows. The
// derivation matrix itself is exhaustively covered by compatibility-map.test.ts;
// this pins the WIRING (the payload field is present and uses deriveCompatibility).

import { describe, it, expect } from 'vitest'
import { repositoryToSkill } from '../../indexer/skill-processor.ts'
import type { GitHubRepository } from '../../indexer/topic-search.ts'

function makeRepo(overrides: Partial<GitHubRepository> = {}): GitHubRepository {
  return {
    owner: 'anthropics',
    name: 'foo',
    fullName: 'anthropics/foo',
    description: 'test skill',
    url: 'https://github.com/anthropics/skills/tree/main/skills/foo',
    stars: 0,
    forks: 0,
    topics: [],
    updatedAt: '2026-05-12T00:00:00Z',
    defaultBranch: 'main',
    installable: true,
    repoName: 'skills',
    skillPath: 'skills/foo',
    ...overrides,
  }
}

describe('repositoryToSkill — compatibility forward-population (SMI-5177)', () => {
  it('maps a convention skill_path to its slugs', () => {
    expect(
      repositoryToSkill(makeRepo({ skillPath: '.codex/skills/update-v8' })).compatibility
    ).toEqual(['codex'])
    expect(repositoryToSkill(makeRepo({ skillPath: '.github/skills/foo' })).compatibility).toEqual([
      'copilot',
    ])
  })

  it('maps the cross-tool .agents/skills to all three readers', () => {
    expect(repositoryToSkill(makeRepo({ skillPath: '.agents/skills/x' })).compatibility).toEqual([
      'windsurf',
      'antigravity',
      'codex',
    ])
  })

  it('leaves generic/plugin/root paths unscoped ([])', () => {
    expect(repositoryToSkill(makeRepo({ skillPath: 'skills/foo' })).compatibility).toEqual([])
    expect(
      repositoryToSkill(makeRepo({ skillPath: '.github/plugins/x/skills/y' })).compatibility
    ).toEqual([])
    expect(repositoryToSkill(makeRepo({ skillPath: '' })).compatibility).toEqual([])
    expect(repositoryToSkill(makeRepo({ skillPath: undefined })).compatibility).toEqual([])
  })

  it('always emits a compatibility field (never undefined)', () => {
    const payload = repositoryToSkill(makeRepo())
    expect(Array.isArray(payload.compatibility)).toBe(true)
  })
})
