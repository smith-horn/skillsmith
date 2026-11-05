/**
 * SMI-7201 Wave 3: EmbeddingService reports every mock vector served while the
 * Tier-B native/JS pair flag is set, and readTierBPairsState's contract.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EmbeddingService, testUtils } from '../../src/embeddings/index.js'
import { readTierBPairsState, TIER_B_PAIRS_FLAG_PATH } from '../../src/embeddings/tier-b-flag.js'

// Force loadModel() to fail without the network (same approach as EmbeddingService.test.ts).
vi.mock('../../src/embeddings/embedding-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/embeddings/embedding-utils.js')>()
  return { ...actual, loadTransformersModule: vi.fn().mockResolvedValue(null) }
})

let dir: string
let flagPath: string
let errSpy: ReturnType<typeof vi.spyOn>

/** console.error calls that carry the Tier-B report. */
function tierBCalls(): string[] {
  return errSpy.mock.calls
    .map((c: unknown[]) => String(c[0]))
    .filter((m: string) => m.includes('SMI-7201'))
}

function writeFlag(state: string): void {
  writeFileSync(flagPath, `state=${state}\nsource=boot\n[tier-b-pairs] detail\n`)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tier-b-flag-'))
  flagPath = join(dir, 'tier-b-pairs.state')
  process.env['SKILLSMITH_QUIET'] = 'true'
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  delete process.env['SKILLSMITH_QUIET']
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('readTierBPairsState', () => {
  it('returns the state value from line 1', () => {
    writeFlag('mismatch')
    expect(readTierBPairsState(flagPath)).toBe('mismatch')
    writeFlag('not-evaluated')
    expect(readTierBPairsState(flagPath)).toBe('not-evaluated')
  })

  it('returns null when the file does not exist', () => {
    expect(readTierBPairsState(join(dir, 'absent.state'))).toBeNull()
  })

  it('returns a non-null state for a file without a state= first line', () => {
    writeFileSync(flagPath, 'garbage\nstate=mismatch\n')
    expect(readTierBPairsState(flagPath)).toBe('unreadable')
  })

  it('returns a non-null state for an empty file and an empty value', () => {
    writeFileSync(flagPath, '')
    expect(readTierBPairsState(flagPath)).toBe('unreadable')
    writeFileSync(flagPath, 'state=\n')
    expect(readTierBPairsState(flagPath)).toBe('unreadable')
  })

  it('returns a non-null state when the path is a directory', () => {
    mkdirSync(flagPath)
    expect(readTierBPairsState(flagPath)).toBe('unreadable')
  })

  it('defaults to the boot-time flag location', () => {
    expect(TIER_B_PAIRS_FLAG_PATH).toBe('/run/skillsmith/tier-b-pairs.state')
  })
})

describe('mock vectors with the flag set (SKILLSMITH_QUIET=true)', () => {
  beforeEach(() => writeFlag('mismatch'))

  it('configured fallback: embed() reports once per call', async () => {
    const svc = new EmbeddingService({ useFallback: true, tierBFlagPath: flagPath })
    await svc.embed('a')
    expect(tierBCalls()).toHaveLength(1)
    await svc.embed('b')
    expect(tierBCalls()).toHaveLength(2)
  })

  it('names the state, the flag path and a remedy', async () => {
    const svc = new EmbeddingService({ useFallback: true, tierBFlagPath: flagPath })
    await svc.embed('a')
    const [msg] = tierBCalls()
    expect(msg).toContain('mismatch')
    expect(msg).toContain(flagPath)
    expect(msg).toContain('Remedy')
  })

  it('configured fallback: embedBatch() of n items reports n times', async () => {
    const svc = new EmbeddingService({ useFallback: true, tierBFlagPath: flagPath })
    const items = [1, 2, 3, 4, 5].map((n) => ({ id: `s${n}`, text: `t${n}` }))
    await svc.embedBatch(items)
    expect(tierBCalls()).toHaveLength(items.length)
  })

  it('load failure: embed() reports on the failing call and on every later call', async () => {
    const svc = new EmbeddingService({ useFallback: false, tierBFlagPath: flagPath })
    await svc.embed('a')
    expect(svc.isUsingFallback()).toBe(true)
    expect(tierBCalls()).toHaveLength(1)
    await svc.embed('b')
    await svc.embed('c')
    expect(tierBCalls()).toHaveLength(3)
  })

  it('load failure: embedBatch() reports once per item', async () => {
    const svc = new EmbeddingService({ useFallback: false, tierBFlagPath: flagPath })
    const items = [1, 2, 3].map((n) => ({ id: `s${n}`, text: `t${n}` }))
    await svc.embedBatch(items)
    expect(svc.isUsingFallback()).toBe(true)
    expect(tierBCalls()).toHaveLength(items.length)
  })

  it('reads the flag on each call: removing it stops the report', async () => {
    const svc = new EmbeddingService({ useFallback: true, tierBFlagPath: flagPath })
    await svc.embed('a')
    expect(tierBCalls()).toHaveLength(1)
    rmSync(flagPath)
    await svc.embed('b')
    expect(tierBCalls()).toHaveLength(1)
  })

  it('still returns the generateMockEmbedding vector', async () => {
    const svc = new EmbeddingService({ useFallback: true, tierBFlagPath: flagPath })
    const v = await svc.embed('hello')
    expect(Array.from(v)).toEqual(Array.from(testUtils.generateMockEmbedding('hello', 384)))
  })

  it('a malformed flag still reports, naming a non-null state', async () => {
    writeFileSync(flagPath, 'no state line here\n')
    const svc = new EmbeddingService({ useFallback: true, tierBFlagPath: flagPath })
    await svc.embed('a')
    expect(tierBCalls()).toHaveLength(1)
    expect(tierBCalls()[0]).toMatch(/pairs are \S+/)
    expect(tierBCalls()[0]).not.toContain('pairs are null')
  })

  it('a directory at the flag path still reports', async () => {
    const dirFlag = join(dir, 'as-dir')
    mkdirSync(dirFlag)
    const svc = new EmbeddingService({ useFallback: true, tierBFlagPath: dirFlag })
    await svc.embed('a')
    expect(tierBCalls()).toHaveLength(1)
  })
})

describe('reporting never throws into the caller', () => {
  it('a console.error that throws: embed() and embedBatch() still return the mock vectors', async () => {
    writeFlag('mismatch')
    errSpy.mockImplementation(() => {
      throw new Error('stderr unavailable')
    })
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const svc = new EmbeddingService({ useFallback: true, tierBFlagPath: flagPath })
    const v = await svc.embed('hello')
    expect(Array.from(v)).toEqual(Array.from(testUtils.generateMockEmbedding('hello', 384)))
    const batch = await svc.embedBatch([{ id: 'x', text: 'y' }])
    expect(batch).toHaveLength(1)
    // the report fell back to a direct stderr write instead of disappearing
    const fallback = writeSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('SMI-7201'))
    expect(fallback).toHaveLength(2)
  })
})

describe('reporting never throws into the caller (both sinks fail)', () => {
  it('console.error and process.stderr.write both throw: the mock vectors are still returned', async () => {
    writeFlag('mismatch')
    errSpy.mockImplementation(() => {
      throw new Error('console unavailable')
    })
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw new Error('stderr unavailable')
    })
    const svc = new EmbeddingService({ useFallback: true, tierBFlagPath: flagPath })
    const v = await svc.embed('hello')
    expect(Array.from(v)).toEqual(Array.from(testUtils.generateMockEmbedding('hello', 384)))
    const batch = await svc.embedBatch([{ id: 'x', text: 'y' }])
    expect(batch).toHaveLength(1)
    expect(writeSpy).toHaveBeenCalled() // the fallback was attempted, so the swallow is what saved the call
  })
})

describe('mock vectors without the flag', () => {
  it('prints no Tier-B report and returns the unchanged mock vector', async () => {
    const svc = new EmbeddingService({ useFallback: true, tierBFlagPath: join(dir, 'absent') })
    const v = await svc.embed('hello')
    await svc.embedBatch([{ id: 'x', text: 'y' }])
    expect(tierBCalls()).toHaveLength(0)
    expect(Array.from(v)).toEqual(Array.from(testUtils.generateMockEmbedding('hello', 384)))
  })

  it('control: the same calls with a flag do print (the absence assertion can fail)', async () => {
    writeFlag('mismatch')
    const svc = new EmbeddingService({ useFallback: true, tierBFlagPath: flagPath })
    await svc.embed('hello')
    await svc.embedBatch([{ id: 'x', text: 'y' }])
    expect(tierBCalls()).toHaveLength(2)
  })
})

describe('source structure', () => {
  it('generateMockEmbedding is called in exactly one place in embeddings/index.ts', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../src/embeddings/index.ts', import.meta.url)),
      'utf8'
    )
    expect(src.match(/generateMockEmbedding\(/g) ?? []).toHaveLength(1)
    // control: the counter sees a real call site
    expect('x = generateMockEmbedding(a)'.match(/generateMockEmbedding\(/g)).toHaveLength(1)
  })
})
