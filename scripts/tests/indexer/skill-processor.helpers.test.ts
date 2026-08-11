import { describe, it, expect } from 'vitest'
import { resolveSkillName } from '../../indexer/skill-processor.helpers.ts'
import type { GitHubRepository } from '../../indexer/topic-search.ts'

function makeRepo(overrides: Partial<GitHubRepository> = {}): GitHubRepository {
  return {
    owner: 'anthropics',
    name: 'test-repo-name',
    fullName: 'anthropics/test-repo-name',
    description: 'test skill',
    url: 'https://github.com/anthropics/skills/tree/main/skills/test-skill',
    stars: 0,
    forks: 0,
    topics: [],
    updatedAt: '2026-05-12T00:00:00Z',
    defaultBranch: 'main',
    installable: true,
    repoName: 'test-repo-name',
    ...overrides,
  }
}

function sanitize(name: string): string {
  // Simulate the real sanitizer behavior (simplified)
  return name ? name.toLowerCase().replace(/[^a-z0-9\-_]/g, '-') : ''
}

describe('resolveSkillName — fallback ordering (SMI-5930 Wave 4)', () => {
  it('frontmatter name present → frontmatter wins (unchanged behavior)', () => {
    const result = resolveSkillName(
      'frontmatter-skill',
      makeRepo({ skillPath: 'plugins/deploy/skills/leaf-segment' }),
      sanitize,
      'plugins/deploy/skills/leaf-segment'
    )
    expect(result).toBe('frontmatter-skill')
  })

  it('frontmatter absent, skillPath leaf present → leaf wins', () => {
    const result = resolveSkillName(
      undefined,
      makeRepo({ skillPath: 'plugins/deploy-on-aws/skills/deploy' }),
      sanitize,
      'plugins/deploy-on-aws/skills/deploy'
    )
    expect(result).toBe('deploy')
  })

  it('frontmatter absent, skillPath leaf present, AND repo.name also populated and different from the leaf → leaf still wins, not repo.name', () => {
    const result = resolveSkillName(
      undefined,
      makeRepo({
        skillPath: 'plugins/deploy-on-aws/skills/deploy',
        name: 'different-repo-name',
        repoName: 'deploy-on-aws',
      }),
      sanitize,
      'plugins/deploy-on-aws/skills/deploy'
    )
    expect(result).toBe('deploy')
  })

  it('frontmatter absent, no leaf available, repo.name present → repo.name wins (existing fallback, unchanged)', () => {
    const result = resolveSkillName(
      undefined,
      makeRepo({
        name: 'repo-name-from-field',
        skillPath: undefined,
        repoName: 'test-repo-name',
      }),
      sanitize,
      undefined
    )
    // When skillPath is undefined, leaf segment is undefined, so it should fall back to repo.name
    expect(result).toBe('repo-name-from-field')
  })

  it('everything absent → falls through to fallback, unchanged', () => {
    const result = resolveSkillName(
      undefined,
      makeRepo({
        name: '',
        fullName: '',
        repoName: '',
        skillPath: undefined,
      }),
      sanitize,
      undefined
    )
    // Should fall back to 'unnamed-skill' when everything is absent
    expect(result).toBe('unnamed-skill')
  })
})
