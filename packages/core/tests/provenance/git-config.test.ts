/**
 * @see SMI-5407 — git-config source recovery
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { parseGitConfigRemote, normalizeGitHubRemote } from '../../src/provenance/git-config.js'

const tracked: string[] = []

function makeGitDir(remoteUrl: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-git-'))
  tracked.push(dir)
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, '.git', 'config'),
    `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${remoteUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`
  )
  return dir
}

afterEach(() => {
  for (const dir of tracked.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('parseGitConfigRemote', () => {
  it('normalizes an ssh (scp-like) remote', () => {
    const dir = makeGitDir('git@github.com:owner/repo.git')
    expect(parseGitConfigRemote(dir)).toEqual({
      owner: 'owner',
      repo: 'repo',
      url: 'https://github.com/owner/repo',
    })
  })

  it('normalizes an https remote', () => {
    const dir = makeGitDir('https://github.com/owner/repo')
    expect(parseGitConfigRemote(dir)).toEqual({
      owner: 'owner',
      repo: 'repo',
      url: 'https://github.com/owner/repo',
    })
  })

  it('strips a trailing .git suffix on an https remote', () => {
    const dir = makeGitDir('https://github.com/owner/repo.git')
    expect(parseGitConfigRemote(dir)?.repo).toBe('repo')
  })

  it('returns null for a non-github host', () => {
    const dir = makeGitDir('git@gitlab.com:owner/repo.git')
    expect(parseGitConfigRemote(dir)).toBeNull()
  })

  it('returns null when .git/config is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-git-'))
    tracked.push(dir)
    expect(parseGitConfigRemote(dir)).toBeNull()
  })
})

describe('normalizeGitHubRemote', () => {
  it('handles an ssh:// scheme url', () => {
    expect(normalizeGitHubRemote('ssh://git@github.com/owner/repo.git')).toEqual({
      owner: 'owner',
      repo: 'repo',
      url: 'https://github.com/owner/repo',
    })
  })

  it('returns null for an unparseable value', () => {
    expect(normalizeGitHubRemote('not a url')).toBeNull()
  })

  it('returns null for a path-traversal owner segment (SMI-5407 governance)', () => {
    // A crafted .git/config that would otherwise yield owner '..'.
    expect(normalizeGitHubRemote('git@github.com:../evil-dir')).toBeNull()
    expect(normalizeGitHubRemote('git@github.com:../../etc/passwd')).toBeNull()
  })

  it('returns null when an owner/repo segment has unsafe characters', () => {
    expect(normalizeGitHubRemote('https://github.com/ow ner/repo')).toBeNull()
  })
})
