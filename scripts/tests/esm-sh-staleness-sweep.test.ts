/**
 * Tests for esm.sh staleness sweep (SMI-4670).
 *
 * Strategy: most logic is pure (regex extraction, dedup, age math). We test
 * those exhaustively. The two impure boundaries — `runAdvisoryCheck` (spawns
 * npm) and `runStalenessCheck` (hits the npm registry) — are exercised via
 * dependency injection and stubbed `fetch`, so the test suite runs offline
 * and deterministically.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Import the public surface (collectPins is exported, dedupPins is exported,
// runStalenessCheck takes an injectable fetch).
import { collectPins, dedupPins, runStalenessCheck } from '../ci/esm-sh-staleness-sweep.mjs'

function makeTempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `esm-sh-sweep-test-${label}-`))
}

describe('esm-sh-staleness-sweep — collectPins', () => {
  it('extracts esm.sh imports from a single .ts file', () => {
    const dir = makeTempDir('single')
    try {
      writeFileSync(
        join(dir, 'fn.ts'),
        `import Stripe from 'https://esm.sh/stripe@20.1.0'\n` +
          `import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.47.0'\n`
      )
      const result = collectPins([dir])
      expect(result.scannedCount).toBe(1)
      expect(result.encryptedCount).toBe(0)
      expect(result.pins).toHaveLength(2)
      expect(result.pins.map((p) => `${p.pkg}@${p.version}`).sort()).toEqual([
        '@supabase/supabase-js@2.47.0',
        'stripe@20.1.0',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('strips path/query fragments from pinned versions', () => {
    const dir = makeTempDir('strip-path')
    try {
      writeFileSync(
        join(dir, 'fn.ts'),
        `import x from 'https://esm.sh/foo@1.2.3/dist-src'\n` +
          `import y from 'https://esm.sh/bar@4.5.6?bundle'\n`
      )
      const { pins } = collectPins([dir])
      expect(pins.find((p) => p.pkg === 'foo')?.version).toBe('1.2.3')
      expect(pins.find((p) => p.pkg === 'bar')?.version).toBe('4.5.6')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('walks nested directories', () => {
    const dir = makeTempDir('nested')
    try {
      mkdirSync(join(dir, 'a', 'b'), { recursive: true })
      writeFileSync(join(dir, 'a', 'top.ts'), `import x from 'https://esm.sh/foo@1.0.0'`)
      writeFileSync(join(dir, 'a', 'b', 'nested.ts'), `import y from 'https://esm.sh/bar@2.0.0'`)
      const { pins, scannedCount } = collectPins([dir])
      expect(scannedCount).toBe(2)
      expect(pins).toHaveLength(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('handles missing scan path gracefully', () => {
    const result = collectPins([join(tmpdir(), 'definitely-does-not-exist-' + Date.now())])
    expect(result.scannedCount).toBe(0)
    expect(result.pins).toHaveLength(0)
  })

  it('counts but does not fail on git-crypt encrypted files', () => {
    const dir = makeTempDir('gitcrypt')
    try {
      // git-crypt magic header: 0x00 47 49 54 43 52 59 50 54 ("\0GITCRYPT")
      const magicBuf = Buffer.from([
        0x00, 0x47, 0x49, 0x54, 0x43, 0x52, 0x59, 0x50, 0x54, 0x00, 0x00, 0x00,
      ])
      writeFileSync(join(dir, 'encrypted.ts'), magicBuf)
      writeFileSync(join(dir, 'plain.ts'), `import x from 'https://esm.sh/foo@1.0.0'`)
      const result = collectPins([dir])
      expect(result.encryptedCount).toBe(1)
      expect(result.scannedCount).toBe(1)
      expect(result.pins).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('only reads .ts files (skips .json/.md/etc.)', () => {
    const dir = makeTempDir('extensions')
    try {
      writeFileSync(join(dir, 'fn.ts'), `import x from 'https://esm.sh/foo@1.0.0'`)
      writeFileSync(join(dir, 'config.json'), `{"esmsh": "https://esm.sh/bar@2.0.0"}`)
      writeFileSync(join(dir, 'readme.md'), `Reference: https://esm.sh/baz@3.0.0`)
      const { pins } = collectPins([dir])
      expect(pins).toHaveLength(1)
      expect(pins[0].pkg).toBe('foo')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('esm-sh-staleness-sweep — dedupPins', () => {
  it('merges duplicate pkg@version across files, keeping all source files', () => {
    const pins = [
      { pkg: 'stripe', version: '20.1.0', file: '/a.ts' },
      { pkg: 'stripe', version: '20.1.0', file: '/b.ts' },
      { pkg: 'stripe', version: '21.0.0', file: '/c.ts' }, // different version → distinct
    ]
    const unique = dedupPins(pins)
    expect(unique).toHaveLength(2)
    const keyed = new Map(unique.map((u) => [`${u.pkg}@${u.version}`, u]))
    expect(keyed.get('stripe@20.1.0')!.files.sort()).toEqual(['/a.ts', '/b.ts'])
    expect(keyed.get('stripe@21.0.0')!.files).toEqual(['/c.ts'])
  })

  it('preserves single-file pins as-is', () => {
    const pins = [{ pkg: 'foo', version: '1.0.0', file: '/x.ts' }]
    expect(dedupPins(pins)).toEqual([{ pkg: 'foo', version: '1.0.0', files: ['/x.ts'] }])
  })

  it('returns empty array on empty input', () => {
    expect(dedupPins([])).toEqual([])
  })
})

describe('esm-sh-staleness-sweep — runStalenessCheck', () => {
  it('flags pins whose published date is older than 90 days', async () => {
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString()
    const fresh = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
    const fakeFetch = (async (url: string) => {
      if (url.includes('stripe')) {
        return {
          ok: true,
          async json() {
            return { time: { '20.1.0': old, '21.0.0': fresh }, 'dist-tags': { latest: '21.0.0' } }
          },
        }
      }
      if (url.includes('supabase')) {
        return {
          ok: true,
          async json() {
            return { time: { '2.47.0': fresh }, 'dist-tags': { latest: '2.47.0' } }
          },
        }
      }
      return {
        ok: false,
        async json() {
          return {}
        },
      }
    }) as unknown as typeof fetch
    const stale = await runStalenessCheck(
      [
        { pkg: 'stripe', version: '20.1.0', files: [] },
        { pkg: '@supabase/supabase-js', version: '2.47.0', files: [] },
      ],
      fakeFetch
    )
    expect(stale).toHaveLength(1)
    expect(stale[0]).toMatchObject({ pkg: 'stripe', pinned: '20.1.0', latest: '21.0.0' })
    expect(stale[0].ageDays).toBeGreaterThanOrEqual(99)
  })

  it('skips pins where registry returns 404 (deleted/unpublished package)', async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 404,
      async json() {
        return {}
      },
    })) as unknown as typeof fetch
    const stale = await runStalenessCheck(
      [{ pkg: 'phantom-pkg', version: '1.0.0', files: [] }],
      fakeFetch
    )
    expect(stale).toEqual([])
  })

  it('skips pins where time entry is missing (yanked version)', async () => {
    const fakeFetch = (async () => ({
      ok: true,
      async json() {
        return { time: {}, 'dist-tags': { latest: '99.0.0' } }
      },
    })) as unknown as typeof fetch
    const stale = await runStalenessCheck([{ pkg: 'foo', version: '1.0.0', files: [] }], fakeFetch)
    expect(stale).toEqual([])
  })

  it('does not flag pins less than 90 days old', async () => {
    const fresh = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const fakeFetch = (async () => ({
      ok: true,
      async json() {
        return { time: { '1.0.0': fresh }, 'dist-tags': { latest: '1.0.0' } }
      },
    })) as unknown as typeof fetch
    const stale = await runStalenessCheck([{ pkg: 'foo', version: '1.0.0', files: [] }], fakeFetch)
    expect(stale).toEqual([])
  })

  it('handles fetch network errors without crashing the sweep', async () => {
    const fakeFetch = (async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch
    const stale = await runStalenessCheck([{ pkg: 'foo', version: '1.0.0', files: [] }], fakeFetch)
    expect(stale).toEqual([])
  })
})
