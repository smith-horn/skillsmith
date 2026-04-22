import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertNotInCi,
  assertSafeIndexTarget,
  loadConfig,
  resetConfigCache,
} from '../src/config.js'

const origCi = process.env.CI
const origSkillCi = process.env.SKILLSMITH_CI
const origRepoRoot = process.env.SKILLSMITH_REPO_ROOT

afterEach(() => {
  process.env.CI = origCi
  process.env.SKILLSMITH_CI = origSkillCi
  process.env.SKILLSMITH_REPO_ROOT = origRepoRoot
  resetConfigCache()
})

describe('assertNotInCi', () => {
  it('throws when CI=true', () => {
    process.env.CI = 'true'
    expect(() => assertNotInCi()).toThrow(/refusing to run in CI/)
  })
  it('throws when SKILLSMITH_CI=true', () => {
    delete process.env.CI
    process.env.SKILLSMITH_CI = 'true'
    expect(() => assertNotInCi()).toThrow(/refusing to run in CI/)
  })
  it('permits when neither set', () => {
    delete process.env.CI
    delete process.env.SKILLSMITH_CI
    expect(() => assertNotInCi()).not.toThrow()
  })
})

describe('assertSafeIndexTarget', () => {
  it('permits paths under $REPO_ROOT/.ruvector', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doc-retrieval-cfg-'))
    process.env.SKILLSMITH_REPO_ROOT = dir
    try {
      expect(() => assertSafeIndexTarget(join(dir, '.ruvector', 'x.rvf'))).not.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses paths outside $REPO_ROOT/.ruvector', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doc-retrieval-cfg-'))
    process.env.SKILLSMITH_REPO_ROOT = dir
    try {
      expect(() => assertSafeIndexTarget('/tmp/anywhere/x.rvf')).toThrow(/Safety boundary/)
      expect(() => assertSafeIndexTarget(join(dir, 'elsewhere/x.rvf'))).toThrow(/Safety boundary/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('loadConfig', () => {
  it('validates required fields and embedding dim', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doc-retrieval-cfg-'))
    try {
      const good = join(dir, 'good.json')
      await writeFile(
        good,
        JSON.stringify({
          rvfPath: '.ruvector/x.rvf',
          metadataPath: '.ruvector/m.json',
          stateFile: '.ruvector/s.json',
          embeddingDim: 384,
          chunk: { targetTokens: 240, overlapTokens: 48, minTokens: 8 },
          globs: ['**/*.md'],
        })
      )
      const cfg = await loadConfig(good)
      expect(cfg.embeddingDim).toBe(384)

      const bad = join(dir, 'bad.json')
      resetConfigCache()
      await writeFile(
        bad,
        JSON.stringify({
          rvfPath: 'x',
          metadataPath: 'm',
          stateFile: 's',
          embeddingDim: 768,
          chunk: { targetTokens: 100, overlapTokens: 10, minTokens: 10 },
          globs: ['**/*.md'],
        })
      )
      await expect(loadConfig(bad)).rejects.toThrow(/embeddingDim must be 384/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
