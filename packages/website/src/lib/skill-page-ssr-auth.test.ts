/**
 * SMI-6190 integration-style check: both SSR fetch sites in
 * `src/pages/skills/[id].astro` (the skill-detail fetch and the
 * category-page fetch) must send `Authorization: Bearer ${getWebsiteSsrApiKey()}`,
 * not the shared Supabase anon key.
 *
 * Why this is a source-inspection test rather than a rendered-behavior test:
 * this repo's `packages/website/vitest.config.ts` deliberately does not wire
 * up Astro's Vite plugin (see its own "Skip files that import Astro virtual
 * modules" comment) — `.astro` files are not importable/renderable from
 * plain Vitest here today. Astro does ship an `experimental_AstroContainer`
 * API that could render this page directly with a mocked global `fetch`, but
 * wiring it up requires adding Astro's `getViteConfig()` to
 * `vitest.config.ts`, which is an infra change gated by ADR-109
 * (SPARC + plan-review before implementation) — out of scope for this
 * change. Until that lands, this test reads the page's own frontmatter
 * source and asserts the exact call-site wiring instead of exercising it at
 * runtime. It intentionally checks call-site *shape* (headers object built
 * from `getWebsiteSsrApiKey()`, immediately adjacent to each fetch's own
 * distinguishing URL-builder call) rather than a broad substring count, so a
 * refactor that keeps the real behavior intact but reformats the file is
 * very unlikely to false-positive here — see the two guard assertions below.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { describe, it, expect } from 'vitest'

const pageSource = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'pages', 'skills', '[id].astro'),
  'utf-8'
)

describe('skills/[id].astro SSR fetch authorization (SMI-6190)', () => {
  it('imports getWebsiteSsrApiKey from the server-only config module', () => {
    expect(pageSource).toMatch(
      /import\s*\{\s*getWebsiteSsrApiKey\s*\}\s*from\s*['"]\.\.\/\.\.\/lib\/supabase-config\.server['"]/
    )
  })

  it('the skill-detail fetch (buildSkillGetUrl) sends Authorization: Bearer ${getWebsiteSsrApiKey()}', () => {
    const skillDetailFetch = pageSource.match(
      /fetch\(buildSkillGetUrl\([^)]*\),\s*\{([\s\S]{0,200}?)\}\)/
    )
    expect(skillDetailFetch, 'expected to find the buildSkillGetUrl() fetch call').not.toBeNull()
    const optionsBlock = skillDetailFetch?.[1] ?? ''
    expect(optionsBlock).toContain('Authorization: `Bearer ${getWebsiteSsrApiKey()}`')
    expect(optionsBlock).not.toContain('anonKey')
  })

  it('the category-page fetch (apiUrl built from categoryMeta.slug) sends Authorization: Bearer ${getWebsiteSsrApiKey()}', () => {
    const categoryFetch = pageSource.match(/fetch\(apiUrl,\s*\{([\s\S]{0,200}?)\}\)/)
    expect(categoryFetch, 'expected to find the category apiUrl fetch call').not.toBeNull()
    const optionsBlock = categoryFetch?.[1] ?? ''
    expect(optionsBlock).toContain('Authorization: `Bearer ${getWebsiteSsrApiKey()}`')
    expect(optionsBlock).not.toContain('anonKey')
  })

  it('neither SSR fetch site builds its Authorization header from the shared anon key anymore', () => {
    // Guards against a regression that re-introduces `Bearer ${anonKey}` at
    // either call site while still passing the two more targeted checks
    // above (e.g. if a future edit adds a THIRD fetch call using anonKey).
    expect(pageSource).not.toContain('Authorization: `Bearer ${anonKey}`')
  })
})
