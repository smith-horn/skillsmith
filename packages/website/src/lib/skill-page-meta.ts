/**
 * Pure, DOM/network-free helpers for the individual skill detail page's
 * server-side metadata (SMI-6180). Split out of skills/[id].astro so the
 * URL-encoding and title/description/canonical derivation logic is directly
 * unit-testable — the actual fetch() call and Astro.response side effects
 * stay in the page frontmatter.
 *
 * See docs/internal/analysis/2026-08-25-search-console-indexing-audit.md for
 * the Search Console findings this fixes: individual skill pages rendered a
 * fully generic client-only shell with no per-skill metadata in the initial
 * HTML, the root cause of the "Crawled - currently not indexed" bucket.
 */

export interface SkillMeta {
  id: string
  name?: string
  author?: string
  description?: string
  trust_tier?: string
}

export interface SkillPageMeta {
  title: string
  description: string
  canonical: string
  jsonLd: Record<string, unknown> | null
}

const DEFAULT_SKILL_DESCRIPTION =
  'View skill details and installation instructions for this Skillsmith agent skill.'

/**
 * Astro.params.id for this single dynamic route segment arrives AS-IS from
 * the URL, already percent-encoded for skill IDs that contain a literal "/"
 * (the common "author/name" shape, itself generated via encodeURIComponent()
 * everywhere this site links to a skill page — see the client script's own
 * "Decode first to normalize" comment in skills/[id].astro, which this
 * mirrors server-side). Re-encoding it without decoding first double-encodes
 * the slash (%2F becomes %252F), breaking the skills-get lookup for every
 * author/name-style skill: confirmed live, this previously 404'd every such
 * ID against a literal "%2F" in the search string instead of splitting on a
 * real slash.
 */
export function resolveSkillId(rawId: string | undefined): string | undefined {
  if (!rawId) return rawId
  return decodeURIComponent(rawId)
}

/**
 * Serializes a JSON-LD payload for safe injection into a
 * `<script type="application/ld+json" set:html={...}>` tag.
 *
 * `JSON.stringify()` alone does NOT escape `</script>` — if any field in the
 * payload originates from external, semi-trusted content (a skill or
 * category name/description, scraped from a GitHub repo) and happens to
 * contain that literal sequence, it breaks out of the surrounding
 * `<script>` tag and injects arbitrary markup/script into the page. `<`
 * is a valid escape inside a JSON string and is never re-interpreted by a
 * JSON-LD consumer, so this is safe for every reader while closing the HTML
 * parser's `</script>` escape hatch.
 */
export function safeJsonLdScript(payload: unknown): string {
  return JSON.stringify(payload).replace(/</g, '\\u003c')
}

/** Builds the server-side skills-get fetch URL from an already-decoded id. */
export function buildSkillGetUrl(apiBaseUrl: string, decodedId: string): string {
  return `${apiBaseUrl}/functions/v1/skills-get/${encodeURIComponent(decodedId)}`
}

/** Builds the canonical skills page URL from an already-decoded id. */
export function buildSkillCanonicalUrl(decodedId: string | undefined): string {
  return `https://www.skillsmith.app/skills/${encodeURIComponent(decodedId ?? '')}`
}

/**
 * Derives title/description/canonical/JSON-LD for the skill detail page from
 * the server-side fetch outcome. Three states: found (real metadata), not
 * found (real 404 — see the page frontmatter for why this matters for SEO),
 * and degraded (fetch failed/rate-limited/etc — falls back to the pre-SMI-6180
 * generic shell + client-side fetch/retry rather than a false 404).
 */
export function deriveSkillPageMeta(
  skillMeta: SkillMeta | null,
  skillNotFound: boolean,
  decodedId: string | undefined
): SkillPageMeta {
  const title = skillMeta?.name
    ? `${skillMeta.name} | Skillsmith`
    : skillNotFound
      ? 'Skill Not Found | Skillsmith'
      : 'Skill Details | Skillsmith'

  const description = skillMeta?.description || DEFAULT_SKILL_DESCRIPTION
  const canonical = buildSkillCanonicalUrl(decodedId)

  const jsonLd = skillMeta
    ? {
        '@context': 'https://schema.org',
        '@type': 'SoftwareSourceCode',
        name: skillMeta.name || decodedId,
        description,
        ...(skillMeta.author ? { author: { '@type': 'Person', name: skillMeta.author } } : {}),
        url: canonical,
      }
    : null

  return { title, description, canonical, jsonLd }
}
