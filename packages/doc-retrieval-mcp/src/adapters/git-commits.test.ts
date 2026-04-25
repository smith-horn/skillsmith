import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createGitCommitsAdapter, parseLogOutput, resolveRepoName } from './git-commits.js'
import type { AdapterContext } from '../types.js'
import type { CorpusConfig } from '../config.js'

function makeCtx(
  repoRoot: string,
  mode: 'full' | 'incremental',
  lastRunAt: string | null = null
): AdapterContext {
  const cfg: CorpusConfig = {
    storagePath: '.ruvector/store',
    metadataPath: '.ruvector/metadata.json',
    stateFile: '.ruvector/state.json',
    embeddingDim: 384,
    chunk: { targetTokens: 240, overlapTokens: 48, minTokens: 32 },
    globs: ['**/*.md'],
  }
  return { repoRoot, cfg, mode, lastSha: null, lastRunAt }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'Test Author',
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'test@example.com',
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'Test Author',
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'test@example.com',
    },
  })
}

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'git-commits-adapter-'))
  git(scratch, 'init', '-q', '-b', 'main')
  git(scratch, 'config', 'user.email', 'test@example.com')
  git(scratch, 'config', 'user.name', 'Test Author')
  git(scratch, 'config', 'commit.gpgsign', 'false')
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function commit(subject: string, body = '', authorName?: string): void {
  // Use an empty commit so we don't need to track files.
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (authorName) {
    env.GIT_AUTHOR_NAME = authorName
    env.GIT_AUTHOR_EMAIL = `${authorName.replace(/\s+/g, '.').toLowerCase()}@example.com`
    env.GIT_COMMITTER_NAME = authorName
    env.GIT_COMMITTER_EMAIL = env.GIT_AUTHOR_EMAIL
  } else {
    env.GIT_AUTHOR_NAME = 'Test Author'
    env.GIT_AUTHOR_EMAIL = 'test@example.com'
    env.GIT_COMMITTER_NAME = 'Test Author'
    env.GIT_COMMITTER_EMAIL = 'test@example.com'
  }
  const msg = body ? `${subject}\n\n${body}` : subject
  execFileSync('git', ['commit', '--allow-empty', '-m', msg], {
    cwd: scratch,
    encoding: 'utf8',
    env,
  })
}

describe('parseLogOutput', () => {
  it('parses NUL/RS-delimited records', () => {
    const sha = 'a'.repeat(40)
    const ct = '1700000000'
    const raw =
      `${sha}\x00${ct}\x00Alice\x00feat: thing\x00body line 1\nbody line 2\x1e` +
      `${'b'.repeat(40)}\x00${ct}\x00Bob\x00fix: bug\x00\x1e`
    const records = parseLogOutput(raw)
    expect(records.length).toBe(2)
    expect(records[0].sha).toBe(sha)
    expect(records[0].subject).toBe('feat: thing')
    expect(records[0].body).toBe('body line 1\nbody line 2')
    expect(records[1].body).toBe('')
  })

  it('returns [] on empty input', () => {
    expect(parseLogOutput('')).toEqual([])
  })

  it('drops records with bad SHA or timestamp', () => {
    const raw = `not-a-sha\x00123\x00A\x00s\x00b\x1e`
    expect(parseLogOutput(raw)).toEqual([])
  })
})

describe('git-commits adapter — listFiles', () => {
  it('returns [] when .git does not exist', async () => {
    const nonRepo = mkdtempSync(join(tmpdir(), 'not-a-repo-'))
    try {
      const adapter = createGitCommitsAdapter()
      const files = await adapter.listFiles(makeCtx(nonRepo, 'full'))
      expect(files).toEqual([])
    } finally {
      rmSync(nonRepo, { recursive: true, force: true })
    }
  })

  it('emits git://<repo>/commit/<sha> virtual keys for commits on main', async () => {
    commit(
      'feat(SMI-4401): overlay session-blindness fix',
      'Root cause: callback H1 guard was missing. Fix: always re-check session after overlay close. This matters because overlay unmount races the session reload.'
    )
    commit(
      'fix(SMI-4443): device-code expiry boundary',
      'When ttl was zero the check never fired. Adds a minimum 60s boundary and a retro for the operations runbook to lock the invariant.'
    )
    const adapter = createGitCommitsAdapter()
    const files = await adapter.listFiles(makeCtx(scratch, 'full'))
    expect(files.length).toBe(2)
    for (const f of files) {
      expect(f.logicalPath).toMatch(
        new RegExp(`^git://${scratch.split('/').pop()}/commit/[0-9a-f]{8}$`)
      )
      expect(f.absolutePath).toBe(null)
      expect(f.tags?.source).toBe('git-commits')
      expect(f.tags?.sha).toMatch(/^[0-9a-f]{8}$/)
    }
  })

  it('parses smi tag from commit message', async () => {
    commit(
      'refactor(SMI-4451): registry extraction',
      'Pulls the legacy pipeline out of indexer.ts into a pluggable SourceAdapter. Behavior unchanged but the new interface enables per-adapter incremental filters.'
    )
    const adapter = createGitCommitsAdapter()
    const files = await adapter.listFiles(makeCtx(scratch, 'full'))
    expect(files[0].tags?.smi).toBe('SMI-4451')
  })

  it('skips dependabot commits without an SMI reference', async () => {
    commit(
      'chore(deps): bump lodash from 4.17.20 to 4.17.21',
      'Bumps lodash from 4.17.20 to 4.17.21. Release notes: patch security advisory.',
      'dependabot[bot]'
    )
    commit(
      'chore(deps): bump axios — SMI-4000 follow-up',
      'SMI-4000 follow-up. This bump closes the transitive advisory tracked under the parent issue.',
      'dependabot[bot]'
    )
    const adapter = createGitCommitsAdapter()
    const files = await adapter.listFiles(makeCtx(scratch, 'full'))
    const subjects = files.map((f) => f.rawContent.split('\n')[0])
    expect(subjects.some((s) => s.includes('lodash'))).toBe(false)
    expect(subjects.some((s) => s.includes('axios'))).toBe(true)
  })

  it('skips [skip-impl-check] commits with trivial bodies', async () => {
    commit('docs: bump submodule [skip-impl-check]', '')
    commit(
      'docs: bump submodule [skip-impl-check]',
      'Real rationale here explaining what changed and why: retro merge for SMI-4441 bundled lesson on prod-vs-staging refs confusion.'
    )
    const adapter = createGitCommitsAdapter()
    const files = await adapter.listFiles(makeCtx(scratch, 'full'))
    expect(files.length).toBe(1)
    expect(files[0].rawContent).toContain('Real rationale')
  })

  it('skips subject-only low-signal commits', async () => {
    commit('wip', '')
    commit(
      'feat: substantial subject body that on its own explains the rationale thoroughly enough to pass the minimum token threshold for inclusion',
      ''
    )
    const adapter = createGitCommitsAdapter()
    const files = await adapter.listFiles(makeCtx(scratch, 'full'))
    expect(files.length).toBe(1)
  })
})

describe('git-commits adapter — chunk', () => {
  it('produces one long-term `commit` chunk with virtual-key id', async () => {
    commit(
      'feat(SMI-4401): callback H1 guard',
      'Fixes overlay session-blindness regression. Root cause: missing H1 re-check after overlay close. Rationale: prevent session drift across overlay mount/unmount races.'
    )
    const adapter = createGitCommitsAdapter()
    const ctx = makeCtx(scratch, 'full')
    const files = await adapter.listFiles(ctx)
    const chunks = await adapter.chunk(files[0], ctx)
    expect(chunks.length).toBe(1)
    expect(chunks[0].kind).toBe('commit')
    expect(chunks[0].lifetime).toBe('long-term')
    expect(chunks[0].filePath).toMatch(/^git:\/\/.+\/commit\/[0-9a-f]{8}$/)
    expect(chunks[0].id).toMatch(/@[0-9a-f]{16}$/)
    expect(chunks[0].tags?.smi).toBe('SMI-4401')
  })
})

describe('git-commits adapter — listDeletedPaths', () => {
  it('returns [] (commits are history)', async () => {
    const adapter = createGitCommitsAdapter()
    const deleted = await adapter.listDeletedPaths(makeCtx(scratch, 'incremental'))
    expect(deleted).toEqual([])
  })
})

describe('resolveRepoName — virtual namespace stability (SMI-4450 H1)', () => {
  function ctxWith(repoRoot: string, adapterCfg?: Record<string, unknown>): AdapterContext {
    return {
      ...makeCtx(repoRoot, 'full'),
      adapterCfg: adapterCfg as never,
    }
  }

  it('honours adapterCfg.repo_name override (config-first)', () => {
    git(scratch, 'remote', 'add', 'origin', 'git@github.com:other/other.git')
    const out = resolveRepoName(ctxWith(scratch, { repo_name: 'pinned-name' }))
    expect(out).toBe('pinned-name')
  })

  it('extracts name from SSH remote URL', () => {
    git(scratch, 'remote', 'add', 'origin', 'git@github.com:smith-horn/skillsmith.git')
    expect(resolveRepoName(ctxWith(scratch))).toBe('skillsmith')
  })

  it('extracts name from HTTPS remote URL', () => {
    git(scratch, 'remote', 'add', 'origin', 'https://github.com/smith-horn/skillsmith.git')
    expect(resolveRepoName(ctxWith(scratch))).toBe('skillsmith')
  })

  it('extracts name from HTTPS URL without .git suffix', () => {
    git(scratch, 'remote', 'add', 'origin', 'https://github.com/smith-horn/skillsmith')
    expect(resolveRepoName(ctxWith(scratch))).toBe('skillsmith')
  })

  it('extracts name from ssh-protocol URL with non-default port', () => {
    git(scratch, 'remote', 'add', 'origin', 'ssh://git@github.com:2222/smith-horn/skillsmith.git')
    expect(resolveRepoName(ctxWith(scratch))).toBe('skillsmith')
  })

  it('handles HTTPS URL with trailing slash (git stores verbatim)', () => {
    // Git accepts and stores trailing-slash URLs verbatim. Without the
    // pre-strip fix, the regex produces no match and falls back to
    // basename(repoRoot) — breaking worktree stability (H1 regression).
    git(scratch, 'remote', 'add', 'origin', 'https://github.com/smith-horn/skillsmith/')
    expect(resolveRepoName(ctxWith(scratch))).toBe('skillsmith')
  })

  it('falls back to basename when no remote is configured', () => {
    // Fresh repo (beforeEach) has no remote — `git config --get` exits 1.
    expect(resolveRepoName(ctxWith(scratch))).toBe(scratch.split('/').pop())
  })

  it('documents fork-remote behavior (resolves to fork name, user overrides via config)', () => {
    git(scratch, 'remote', 'add', 'origin', 'git@github.com:forker/skillsmith-fork.git')
    expect(resolveRepoName(ctxWith(scratch))).toBe('skillsmith-fork')
    // With override:
    expect(resolveRepoName(ctxWith(scratch, { repo_name: 'skillsmith' }))).toBe('skillsmith')
  })
})

describe('git-commits headingChain — subject-based display (SMI-4450 M1)', () => {
  it('uses commit subject as headingChain[0] instead of the SHA', async () => {
    git(scratch, 'remote', 'add', 'origin', 'git@github.com:smith-horn/skillsmith.git')
    commit(
      'fix(SMI-4401): callback H1 guard for overlay session-blindness',
      'Root cause: the overlay mount/unmount race dropped the session re-check. Adds an explicit H1 guard that survives component re-mount.'
    )
    const adapter = createGitCommitsAdapter()
    const ctx = makeCtx(scratch, 'full')
    const files = await adapter.listFiles(ctx)
    expect(files.length).toBe(1)
    const chunks = await adapter.chunk(files[0], ctx)
    expect(chunks[0].headingChain).toEqual([
      'fix(SMI-4401): callback H1 guard for overlay session-blindness',
    ])
    expect(chunks[0].headingChain[0]).not.toMatch(/^[0-9a-f]{8}$/)
  })

  it('virtual key uses resolveRepoName, not basename(repoRoot)', async () => {
    git(scratch, 'remote', 'add', 'origin', 'git@github.com:smith-horn/skillsmith.git')
    commit(
      'feat(SMI-4451): registry extraction',
      'Pulls the legacy pipeline out of indexer.ts into a pluggable SourceAdapter. Behavior unchanged but the new interface enables per-adapter incremental filters.'
    )
    const adapter = createGitCommitsAdapter()
    const files = await adapter.listFiles(makeCtx(scratch, 'full'))
    // scratch basename would be a random tmpdir name, but remote name
    // is skillsmith — confirms the H1 fix overrides basename.
    expect(files[0].logicalPath).toMatch(/^git:\/\/skillsmith\/commit\/[0-9a-f]{8}$/)
  })
})
