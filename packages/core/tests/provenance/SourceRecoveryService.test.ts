/**
 * @see SMI-5407 — tiered source recovery (short-circuit + review-only tiers)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { SourceRecoveryService } from '../../src/provenance/SourceRecoveryService.js'
import type { RecoveryCandidate } from '../../src/provenance/types.js'
import { hashContent } from '../../src/services/skill-installation.helpers.js'

const tracked: string[] = []

function tmpDir(prefix = 'prov-svc-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tracked.push(dir)
  return dir
}

function writeGitConfig(dir: string, url: string): void {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${url}\n`)
}

function writePlugin(dir: string, repository: string): void {
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ repository }))
}

function candidate(id: string, name: string, owner: string, repo: string): RecoveryCandidate {
  return { id, name, owner, repo, url: `https://github.com/${owner}/${repo}`, qualityScore: 0.5 }
}

afterEach(() => {
  for (const dir of tracked.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('SourceRecoveryService.recoverOne', () => {
  it('git remote short-circuits before any dependency call (exact)', async () => {
    const dir = tmpDir()
    writeGitConfig(dir, 'git@github.com:owner/repo.git')
    const findCandidatesByName = vi.fn(async () => [] as RecoveryCandidate[])
    const svc = new SourceRecoveryService({ hashContent, findCandidatesByName })

    const result = await svc.recoverOne(dir, 'repo', null)

    expect(result.method).toBe('git-remote')
    expect(result.confidence).toBe('exact')
    expect(result.recoveredSource).toEqual({
      owner: 'owner',
      repo: 'repo',
      url: 'https://github.com/owner/repo',
    })
    expect(result.status).toBe('recovered')
    expect(findCandidatesByName).not.toHaveBeenCalled()
  })

  it('plugin manifest resolves at high confidence without a dependency call', async () => {
    const dir = tmpDir()
    writePlugin(dir, 'https://github.com/o/r')
    const findCandidatesByName = vi.fn(async () => [] as RecoveryCandidate[])
    const svc = new SourceRecoveryService({ hashContent, findCandidatesByName })

    const result = await svc.recoverOne(dir, 'r', null)

    expect(result.method).toBe('plugin-json')
    expect(result.confidence).toBe('high')
    expect(result.status).toBe('recovered')
    expect(findCandidatesByName).not.toHaveBeenCalled()
  })

  // SMI-5411: a git/plugin source whose repo IS in the local catalog gets its
  // manifest id enriched with the registry UUID, while the (exact/high) SOURCE
  // resolution stays unchanged. Enrichment is best-effort and never throws.
  it('git remote enriches registryId from findRegistryIdByRepoUrl (UUID; source unchanged)', async () => {
    const dir = tmpDir()
    writeGitConfig(dir, 'git@github.com:owner/repo.git')
    const findRegistryIdByRepoUrl = vi.fn(async (url: string) =>
      url === 'https://github.com/owner/repo' ? 'reg-uuid-1' : null
    )
    const svc = new SourceRecoveryService({
      hashContent,
      findCandidatesByName: async () => [],
      findRegistryIdByRepoUrl,
    })

    const result = await svc.recoverOne(dir, 'repo', null)

    expect(result.method).toBe('git-remote')
    expect(result.confidence).toBe('exact')
    expect(result.registryId).toBe('reg-uuid-1')
    expect(result.recoveredSource?.url).toBe('https://github.com/owner/repo')
    expect(findRegistryIdByRepoUrl).toHaveBeenCalledWith('https://github.com/owner/repo')
  })

  it('plugin manifest enriches registryId from findRegistryIdByRepoUrl', async () => {
    const dir = tmpDir()
    writePlugin(dir, 'https://github.com/o/r')
    const findRegistryIdByRepoUrl = vi.fn(async () => 'plugin-uuid')
    const svc = new SourceRecoveryService({
      hashContent,
      findCandidatesByName: async () => [],
      findRegistryIdByRepoUrl,
    })

    const result = await svc.recoverOne(dir, 'r', null)

    expect(result.method).toBe('plugin-json')
    expect(result.confidence).toBe('high')
    expect(result.registryId).toBe('plugin-uuid')
    expect(findRegistryIdByRepoUrl).toHaveBeenCalledWith('https://github.com/o/r')
  })

  it('git remote keeps registryId null when the repo is not catalog-known', async () => {
    const dir = tmpDir()
    writeGitConfig(dir, 'git@github.com:owner/repo.git')
    const findRegistryIdByRepoUrl = vi.fn(async () => null)
    const svc = new SourceRecoveryService({
      hashContent,
      findCandidatesByName: async () => [],
      findRegistryIdByRepoUrl,
    })

    const result = await svc.recoverOne(dir, 'repo', null)

    expect(result.method).toBe('git-remote')
    expect(result.registryId).toBeNull()
  })

  it('git remote keeps registryId null when the enrichment dep is absent', async () => {
    const dir = tmpDir()
    writeGitConfig(dir, 'git@github.com:owner/repo.git')
    const svc = new SourceRecoveryService({ hashContent, findCandidatesByName: async () => [] })

    const result = await svc.recoverOne(dir, 'repo', null)

    expect(result.method).toBe('git-remote')
    expect(result.registryId).toBeNull()
  })

  it('git remote degrades to null registryId when the enrichment dep throws', async () => {
    const dir = tmpDir()
    writeGitConfig(dir, 'git@github.com:owner/repo.git')
    const findRegistryIdByRepoUrl = vi.fn(async () => {
      throw new Error('catalog unavailable')
    })
    const svc = new SourceRecoveryService({
      hashContent,
      findCandidatesByName: async () => [],
      findRegistryIdByRepoUrl,
    })

    const result = await svc.recoverOne(dir, 'repo', null)

    // The throw must NOT fail recovery — the source still resolves exact.
    expect(result.method).toBe('git-remote')
    expect(result.confidence).toBe('exact')
    expect(result.recoveredSource?.url).toBe('https://github.com/owner/repo')
    expect(result.registryId).toBeNull()
  })

  it('a single name match resolves at medium with a registry id', async () => {
    const dir = tmpDir()
    const findCandidatesByName = vi.fn(async () => [candidate('uuid-1', 'foo', 'acme', 'foo')])
    const svc = new SourceRecoveryService({ hashContent, findCandidatesByName })

    const result = await svc.recoverOne(dir, 'foo', null)

    expect(result.method).toBe('registry-name')
    expect(result.confidence).toBe('medium')
    expect(result.registryId).toBe('uuid-1')
    expect(result.recoveredSource?.url).toBe('https://github.com/acme/foo')
    expect(result.status).toBe('recovered')
    expect(findCandidatesByName).toHaveBeenCalledWith('foo')
  })

  it('multiple name matches yield low confidence + candidates (review-only)', async () => {
    const dir = tmpDir()
    const findCandidatesByName = vi.fn(async () => [
      candidate('u1', 'foo', 'a', 'foo'),
      candidate('u2', 'foo', 'b', 'foo'),
    ])
    const svc = new SourceRecoveryService({ hashContent, findCandidatesByName })

    const result = await svc.recoverOne(dir, 'foo', null)

    expect(result.confidence).toBe('low')
    expect(result.candidates).toHaveLength(2)
    expect(result.recoveredSource).toBeNull()
    expect(result.registryId).toBeNull()
    expect(result.status).toBe('unknown')
  })

  it('no match yields unknown', async () => {
    const dir = tmpDir()
    const svc = new SourceRecoveryService({
      hashContent,
      findCandidatesByName: async () => [],
    })

    const result = await svc.recoverOne(dir, 'foo', null)

    expect(result.method).toBeNull()
    expect(result.confidence).toBe('unknown')
    expect(result.status).toBe('unknown')
  })
})

describe('SourceRecoveryService.recoverSources', () => {
  it('scans a root, skips backups, and computes a summary', async () => {
    const root = tmpDir('prov-root-')

    const gitSkill = path.join(root, 'gitskill')
    fs.mkdirSync(gitSkill, { recursive: true })
    fs.writeFileSync(path.join(gitSkill, 'SKILL.md'), '---\nname: gitskill\n---\n')
    writeGitConfig(gitSkill, 'https://github.com/o/gitskill')

    const backupDir = path.join(root, 'gitskill.backup-20260101-000000')
    fs.mkdirSync(backupDir, { recursive: true })
    fs.writeFileSync(path.join(backupDir, 'SKILL.md'), 'snapshot')

    const unknownSkill = path.join(root, 'unk')
    fs.mkdirSync(unknownSkill, { recursive: true })
    fs.writeFileSync(path.join(unknownSkill, 'SKILL.md'), '---\nname: unk\n---\n')

    const svc = new SourceRecoveryService({ hashContent, findCandidatesByName: async () => [] })
    const report = await svc.recoverSources({ skillsRoot: root })

    expect(report.summary.total).toBe(3)
    expect(report.summary.recovered).toBe(1)
    expect(report.summary.skipped_backup).toBe(1)
    expect(report.summary.unknown).toBe(1)

    const backup = report.skills.find((s) => s.skillName.includes('backup'))
    expect(backup?.status).toBe('skipped_backup')
  })

  it('honors the `only` filter', async () => {
    const root = tmpDir('prov-root-')
    for (const name of ['a', 'b']) {
      const dir = path.join(root, name)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n`)
    }
    const svc = new SourceRecoveryService({ hashContent, findCandidatesByName: async () => [] })
    const report = await svc.recoverSources({ skillsRoot: root, only: ['a'] })
    expect(report.skills.map((s) => s.skillName)).toEqual(['a'])
  })
})
