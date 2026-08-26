import { describe, it, expect } from 'vitest'
import {
  buildCategorySkillsUrl,
  buildSkillCanonicalUrl,
  buildSkillGetUrl,
  deriveSkillPageMeta,
  resolveSkillId,
  safeJsonLdScript,
  shouldCacheSkillPage,
  type SkillMeta,
} from './skill-page-meta'

describe('safeJsonLdScript', () => {
  it('escapes </script> so it cannot break out of the surrounding script tag', () => {
    const payload = { name: 'evil</script><script>alert(1)</script>' }
    const serialized = safeJsonLdScript(payload)
    expect(serialized).not.toContain('</script>')
    expect(serialized).toContain('\\u003c/script>')
  })

  it('round-trips back to the original value once un-escaped and parsed', () => {
    const payload = { name: 'evil</script><script>alert(1)</script>' }
    const serialized = safeJsonLdScript(payload)
    const parsed = JSON.parse(serialized.replace(/\\u003c/g, '<'))
    expect(parsed).toEqual(payload)
  })

  it('leaves ordinary payloads unaffected', () => {
    const payload = { name: 'Example Skill', description: 'Does something useful.' }
    expect(safeJsonLdScript(payload)).toBe(JSON.stringify(payload))
  })
})

describe('resolveSkillId', () => {
  it('returns undefined for an undefined id', () => {
    expect(resolveSkillId(undefined)).toBeUndefined()
  })

  it('falls back to the raw value for malformed percent-encoding instead of throwing', () => {
    // SMI-6180 regression: decodeURIComponent throws URIError on a lone '%'
    // or an incomplete/invalid UTF-8 escape — this must degrade gracefully,
    // not crash the SSR render for a crawler hitting a garbled URL.
    expect(() => resolveSkillId('bad%id')).not.toThrow()
    expect(resolveSkillId('bad%id')).toBe('bad%id')
    expect(() => resolveSkillId('%E0%A4%A')).not.toThrow()
    expect(resolveSkillId('%E0%A4%A')).toBe('%E0%A4%A')
  })

  it('decodes a percent-encoded slash in an author/name id', () => {
    // Astro.params.id arrives pre-encoded (e.g. from a link built with
    // encodeURIComponent()) rather than auto-decoded by Astro.
    expect(resolveSkillId('smith-horn%2Fexample-skill')).toBe('smith-horn/example-skill')
  })

  it('leaves a plain id without special characters unchanged', () => {
    expect(resolveSkillId('my-simple-skill')).toBe('my-simple-skill')
  })
})

describe('buildSkillGetUrl + buildSkillCanonicalUrl (encode round-trip)', () => {
  it('re-encodes a decoded author/name id back to exactly one layer of encoding', () => {
    // SMI-6180 regression: resolveSkillId() then encodeURIComponent() without
    // the decode step first would double-encode the slash (%2F -> %252F),
    // breaking the skills-get lookup and producing a canonical URL Google
    // would never match against the actual served URL.
    const rawParam = 'smith-horn%2Fexample-skill'
    const decoded = resolveSkillId(rawParam)
    expect(decoded).toBeDefined()

    const fetchUrl = buildSkillGetUrl('https://api.skillsmith.app', decoded as string)
    expect(fetchUrl).toBe(
      'https://api.skillsmith.app/functions/v1/skills-get/smith-horn%2Fexample-skill'
    )
    expect(fetchUrl).not.toContain('%25')

    const canonical = buildSkillCanonicalUrl(decoded)
    expect(canonical).toBe('https://www.skillsmith.app/skills/smith-horn%2Fexample-skill')
    expect(canonical).not.toContain('%25')
  })

  it('round-trips a plain id with no special characters', () => {
    const decoded = resolveSkillId('my-simple-skill')
    expect(buildSkillGetUrl('https://api.skillsmith.app', decoded as string)).toBe(
      'https://api.skillsmith.app/functions/v1/skills-get/my-simple-skill'
    )
    expect(buildSkillCanonicalUrl(decoded)).toBe(
      'https://www.skillsmith.app/skills/my-simple-skill'
    )
  })

  it('falls back to an empty-id canonical URL when decodedId is undefined', () => {
    expect(buildSkillCanonicalUrl(undefined)).toBe('https://www.skillsmith.app/skills/')
  })
})

describe('buildCategorySkillsUrl', () => {
  it('routes through /functions/v1/skills-search, not a bare /v1/ path', () => {
    // SMI-6195 regression: the prior inline URL used `/v1/skills`, a path
    // api.skillsmith.app's Vercel rewrite never routes (confirmed live —
    // 404 at the routing layer, before Supabase). Only `/functions/v1/<fn>`
    // paths are routed; skills-search is the function, not "skills".
    const url = buildCategorySkillsUrl('https://api.skillsmith.app', 'testing')
    expect(url).toBe(
      'https://api.skillsmith.app/functions/v1/skills-search?category=testing&limit=12&sort=score'
    )
  })

  it('URL-encodes the category slug', () => {
    const url = buildCategorySkillsUrl('https://api.skillsmith.app', 'a slug/weird')
    expect(url).toContain('category=a%20slug%2Fweird')
  })
})

describe('deriveSkillPageMeta', () => {
  const decodedId = 'smith-horn/example-skill'

  it('builds real title/description/canonical/JSON-LD when the skill was found', () => {
    const skill: SkillMeta = {
      id: decodedId,
      name: 'Example Skill',
      author: 'Smith Horn',
      description: 'Does something useful.',
      trust_tier: 'verified',
    }

    const meta = deriveSkillPageMeta(skill, false, decodedId)

    expect(meta.title).toBe('Example Skill | Skillsmith')
    expect(meta.description).toBe('Does something useful.')
    expect(meta.canonical).toBe('https://www.skillsmith.app/skills/smith-horn%2Fexample-skill')
    expect(meta.jsonLd).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'SoftwareSourceCode',
      name: 'Example Skill',
      description: 'Does something useful.',
      author: { '@type': 'Person', name: 'Smith Horn' },
      url: meta.canonical,
    })
  })

  it('omits the JSON-LD author field when the skill has no author', () => {
    const skill: SkillMeta = { id: decodedId, name: 'Example Skill' }
    const meta = deriveSkillPageMeta(skill, false, decodedId)
    expect(meta.jsonLd).not.toHaveProperty('author')
  })

  it('falls back to the decoded id as the JSON-LD name when the skill has no name', () => {
    const skill: SkillMeta = { id: decodedId }
    const meta = deriveSkillPageMeta(skill, false, decodedId)
    expect(meta.jsonLd?.name).toBe(decodedId)
  })

  it('uses a real 404 title and no JSON-LD when the skill was genuinely not found', () => {
    const meta = deriveSkillPageMeta(null, true, decodedId)
    expect(meta.title).toBe('Skill Not Found | Skillsmith')
    expect(meta.jsonLd).toBeNull()
  })

  it('falls back to a generic title and no JSON-LD when the fetch degraded (not a real 404)', () => {
    const meta = deriveSkillPageMeta(null, false, decodedId)
    expect(meta.title).toBe('Skill Details | Skillsmith')
    expect(meta.jsonLd).toBeNull()
    expect(meta.description).toContain('View skill details')
  })
})

describe('shouldCacheSkillPage', () => {
  it('caches a genuinely successful metadata fetch', () => {
    const skill: SkillMeta = { id: 'smith-horn/example-skill', name: 'Example Skill' }
    expect(shouldCacheSkillPage(skill)).toBe(true)
  })

  it('does not cache a degraded response (network error, 5xx, or rate limit — skillMeta null)', () => {
    // SMI-6180 regression: caching this would bake a transient failure's
    // generic-shell fallback into the CDN for the full cache lifetime,
    // reintroducing the exact indexing problem this page fix exists to
    // solve. See SMI-6190 for the underlying shared-rate-limit exposure
    // this mitigates the practical impact of.
    expect(shouldCacheSkillPage(null)).toBe(false)
  })
})
