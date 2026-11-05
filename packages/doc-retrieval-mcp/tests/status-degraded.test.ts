/**
 * SMI-7201 Wave 3: skill_docs_status surfaces the Tier-B pair flag as `degraded`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getStatus } from '../src/status.js'
import { readTierBPairsState } from '../src/tier-b-flag.js'
import { resetConfigCache } from '../src/config.js'

const origRoot = process.env.SKILLSMITH_REPO_ROOT
let dir: string
let configPath: string
let flagPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'doc-retrieval-status-'))
  process.env.SKILLSMITH_REPO_ROOT = dir
  configPath = join(dir, 'corpus.config.json')
  flagPath = join(dir, 'tier-b-pairs.state')
  writeFileSync(
    configPath,
    JSON.stringify({
      storagePath: '.ruvector/skillsmith-docs',
      metadataPath: '.ruvector/m.json',
      stateFile: '.ruvector/s.json',
      embeddingDim: 384,
      chunk: { targetTokens: 240, overlapTokens: 48, minTokens: 8 },
      globs: ['**/*.md'],
    })
  )
})

afterEach(() => {
  if (origRoot === undefined) delete process.env.SKILLSMITH_REPO_ROOT
  else process.env.SKILLSMITH_REPO_ROOT = origRoot
  resetConfigCache()
  rmSync(dir, { recursive: true, force: true })
})

describe('getStatus degraded field (SMI-7201)', () => {
  it('reports "tier-b-pairs mismatch" when the flag holds state=mismatch', async () => {
    writeFileSync(flagPath, 'state=mismatch\nsource=boot\n')
    const status = await getStatus(configPath, { tierBFlagPath: flagPath })
    expect(status.degraded).toBe('tier-b-pairs mismatch')
  })

  it('has no degraded key without a flag', async () => {
    const status = await getStatus(configPath, { tierBFlagPath: join(dir, 'absent') })
    expect('degraded' in status).toBe(false)
    expect(status.corpusVersion).toBe(0)
  })

  it('a malformed flag still sets degraded', async () => {
    writeFileSync(flagPath, 'junk\n')
    const status = await getStatus(configPath, { tierBFlagPath: flagPath })
    expect(status.degraded).toMatch(/^tier-b-pairs \S+/)
  })
})

describe('local readTierBPairsState', () => {
  it('state value, null when absent, non-null when malformed or a directory', () => {
    writeFileSync(flagPath, 'state=unavailable\n')
    expect(readTierBPairsState(flagPath)).toBe('unavailable')
    expect(readTierBPairsState(join(dir, 'absent'))).toBeNull()
    writeFileSync(flagPath, 'nope\n')
    expect(readTierBPairsState(flagPath)).not.toBeNull()
    mkdirSync(join(dir, 'd'))
    expect(readTierBPairsState(join(dir, 'd'))).not.toBeNull()
  })
})
