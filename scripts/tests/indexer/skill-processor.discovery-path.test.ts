/**
 * repositoryToSkill — discovery_path field (SMI-5286 Wave 1b R-2)
 * @module scripts/tests/indexer/skill-processor.discovery-path
 *
 * Pins the wiring: `repo.discoveryPath` is forwarded to `discovery_path` in
 * the upsert payload; absent discoveryPath lands as null.
 *
 * The compatibility and quality-score matrices are covered by separate test
 * files. This file is intentionally narrow — one field, two branches.
 */

import { describe, it, expect } from 'vitest'
import { repositoryToSkill } from '../../indexer/skill-processor.ts'
import type { GitHubRepository } from '../../indexer/topic-search.ts'

function makeRepo(overrides: Partial<GitHubRepository> = {}): GitHubRepository {
  return {
    owner: 'acme',
    name: 'my-skill',
    fullName: 'acme/my-skill',
    description: 'A test skill',
    url: 'https://github.com/acme/my-skill',
    stars: 1,
    forks: 0,
    topics: [],
    updatedAt: '2026-06-17T00:00:00Z',
    defaultBranch: 'main',
    installable: true,
    repoName: 'my-skill',
    skillPath: '',
    ...overrides,
  }
}

describe('repositoryToSkill — discovery_path (SMI-5286 Wave 1b R-2)', () => {
  it('sets discovery_path to the repo discoveryPath tag', () => {
    const payload = repositoryToSkill(makeRepo({ discoveryPath: 'subdirectory_search:broad' }))

    expect(payload.discovery_path).toBe('subdirectory_search:broad')
  })

  it('sets discovery_path for a backfill-style tag', () => {
    const payload = repositoryToSkill(makeRepo({ discoveryPath: 'backfill_trees:2026-06-17' }))

    expect(payload.discovery_path).toBe('backfill_trees:2026-06-17')
  })

  it('sets discovery_path for a topic_search tag', () => {
    const payload = repositoryToSkill(makeRepo({ discoveryPath: 'topic_search:claude-code-skill' }))

    expect(payload.discovery_path).toBe('topic_search:claude-code-skill')
  })

  it('returns null for discovery_path when discoveryPath is undefined', () => {
    const payload = repositoryToSkill(makeRepo({ discoveryPath: undefined }))

    expect(payload.discovery_path).toBeNull()
  })

  it('returns null for discovery_path when the field is omitted from the repo', () => {
    // makeRepo with no discoveryPath key at all (delete it so the field is truly absent)
    const repoWithout = { ...makeRepo() }
    delete (repoWithout as Partial<GitHubRepository>).discoveryPath
    const payload = repositoryToSkill(repoWithout as GitHubRepository)

    expect(payload.discovery_path).toBeNull()
  })

  it('always emits a discovery_path key in the payload (never absent)', () => {
    const payload = repositoryToSkill(makeRepo())

    expect('discovery_path' in payload).toBe(true)
  })
})
