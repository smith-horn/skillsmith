/**
 * Tests for the vercel.json structural-sync helper used by
 * scripts/audit-standards.mjs §38 (SMI-4641).
 *
 * The audit was rewritten from byte-identity (SMI-4592 retro) to structural
 * equivalence after SMI-4641 — the byte-identity invariant locked in a broken
 * `outputDirectory` value identical in both files because the value resolved
 * correctly only from one of the two cwd contexts (repo root vs
 * packages/website/). The new invariant: shared fields (framework,
 * installCommand, redirects, headers) must match; buildCommand and
 * outputDirectory are allowed to differ by design.
 */
import { describe, expect, it } from 'vitest'

const helpers = (await import('../audit-vercel-sync-helpers.mjs')) as {
  VERCEL_JSON_SHARED_FIELDS: readonly string[]
  isValidOutputDirectory: (v: unknown) => boolean
  validateVercelJsonSync: (
    root: Record<string, unknown>,
    website: Record<string, unknown>
  ) =>
    | { ok: true }
    | { ok: false; kind: 'drift'; drifted: string[] }
    | {
        ok: false
        kind: 'shape'
        side: 'root' | 'website'
        value: unknown
      }
}

const { VERCEL_JSON_SHARED_FIELDS, isValidOutputDirectory, validateVercelJsonSync } = helpers

const baseShared = {
  framework: 'astro',
  installCommand: 'npm install',
  redirects: [
    {
      source: '/:path*',
      has: [{ type: 'host', value: 'skillsmith.app' }],
      destination: 'https://www.skillsmith.app/:path*',
      permanent: true,
    },
  ],
  headers: [
    {
      source: '/(.*)',
      headers: [{ key: 'X-Frame-Options', value: 'DENY' }],
    },
  ],
}

describe('VERCEL_JSON_SHARED_FIELDS', () => {
  it('lists exactly the four invariant fields', () => {
    expect([...VERCEL_JSON_SHARED_FIELDS].sort()).toEqual([
      'framework',
      'headers',
      'installCommand',
      'redirects',
    ])
  })
})

describe('isValidOutputDirectory', () => {
  it('accepts undefined (preferred — buildCommand materializes BOA)', () => {
    expect(isValidOutputDirectory(undefined)).toBe(true)
  })

  it('accepts well-shaped relative POSIX paths', () => {
    expect(isValidOutputDirectory('dist')).toBe(true)
    expect(isValidOutputDirectory('packages/website/.vercel/output/static')).toBe(true)
    expect(isValidOutputDirectory('.vercel/output/static')).toBe(true)
  })

  it('rejects absolute paths (leading "/")', () => {
    expect(isValidOutputDirectory('/var/www')).toBe(false)
  })

  it('rejects traversal segments', () => {
    expect(isValidOutputDirectory('../foo')).toBe(false)
    expect(isValidOutputDirectory('a/../b')).toBe(false)
  })

  it('rejects Windows-paste mistakes (backslashes)', () => {
    expect(isValidOutputDirectory('packages\\website\\dist')).toBe(false)
  })

  it('rejects empty strings', () => {
    expect(isValidOutputDirectory('')).toBe(false)
  })

  it('rejects non-strings (other than undefined)', () => {
    expect(isValidOutputDirectory(null)).toBe(false)
    expect(isValidOutputDirectory(42)).toBe(false)
  })
})

describe('validateVercelJsonSync — fixture pair 1: valid divergence (post-SMI-4641 shape)', () => {
  it('passes when buildCommand differs but shared fields match', () => {
    const root = {
      ...baseShared,
      buildCommand:
        'npm run build && rm -rf .vercel/output && mkdir -p .vercel && cp -r packages/website/.vercel/output .vercel/output',
    }
    const website = {
      ...baseShared,
      buildCommand: 'npm run build',
    }
    expect(validateVercelJsonSync(root, website)).toEqual({ ok: true })
  })

  it('passes when both omit outputDirectory', () => {
    const root = { ...baseShared, buildCommand: 'a' }
    const website = { ...baseShared, buildCommand: 'b' }
    expect(validateVercelJsonSync(root, website)).toEqual({ ok: true })
  })
})

describe('validateVercelJsonSync — fixture pair 2: drifted redirects', () => {
  it('fails and names the drifted field when redirects diverge', () => {
    const root = { ...baseShared, buildCommand: 'a' }
    const website = {
      ...baseShared,
      buildCommand: 'b',
      redirects: [
        {
          source: '/:path*',
          has: [{ type: 'host', value: 'old-domain.com' }],
          destination: 'https://www.skillsmith.app/:path*',
          permanent: true,
        },
      ],
    }
    const result = validateVercelJsonSync(root, website)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.kind).toBe('drift')
    if (result.kind !== 'drift') throw new Error('unreachable')
    expect(result.drifted).toEqual(['redirects'])
  })

  it('fails with multiple drifted fields named in stable order', () => {
    const root = { ...baseShared, framework: 'astro', installCommand: 'npm install' }
    const website = { ...baseShared, framework: 'next', installCommand: 'npm ci' }
    const result = validateVercelJsonSync(root, website)
    expect(result.ok).toBe(false)
    if (result.ok || result.kind !== 'drift') throw new Error('unreachable')
    expect(result.drifted).toEqual(['framework', 'installCommand'])
  })
})

describe('validateVercelJsonSync — fixture pair 3: drifted output shape', () => {
  it('fails on a leading-slash outputDirectory at root', () => {
    const root = { ...baseShared, buildCommand: 'a', outputDirectory: '/abs/path' }
    const website = { ...baseShared, buildCommand: 'b' }
    const result = validateVercelJsonSync(root, website)
    expect(result.ok).toBe(false)
    if (result.ok || result.kind !== 'shape') throw new Error('unreachable')
    expect(result.side).toBe('root')
    expect(result.value).toBe('/abs/path')
  })

  it('fails on a traversal outputDirectory at website-local copy', () => {
    const root = { ...baseShared, buildCommand: 'a' }
    const website = {
      ...baseShared,
      buildCommand: 'b',
      outputDirectory: '../../escape',
    }
    const result = validateVercelJsonSync(root, website)
    expect(result.ok).toBe(false)
    if (result.ok || result.kind !== 'shape') throw new Error('unreachable')
    expect(result.side).toBe('website')
    expect(result.value).toBe('../../escape')
  })
})
