/**
 * Tests for shared source/test/docs classification patterns (SMI-4446).
 *
 * Mirrors the consumer behavior in:
 *   - scripts/ci/verify-implementation.ts (line ~61)
 *   - scripts/linear-hook.mjs (line ~96)
 *
 * Both call `SOURCE_PATTERNS.some(p => p.test(file))`. We test the same shape
 * so a regression in either consumer surfaces here first.
 */

import { describe, it, expect } from 'vitest'
import { SOURCE_PATTERNS, TEST_PATTERNS, DOCS_PATTERNS } from '../ci/source-patterns.mjs'

const isSource = (path: string): boolean => SOURCE_PATTERNS.some((p) => p.test(path))
const isTest = (path: string): boolean => TEST_PATTERNS.some((p) => p.test(path))
const isDocs = (path: string): boolean => DOCS_PATTERNS.some((p) => p.test(path))

describe('SMI-4446: SOURCE_PATTERNS classification', () => {
  describe('Astro and MDX (new in SMI-4446)', () => {
    it.each([
      ['packages/website/src/pages/product.astro', true],
      ['packages/website/src/components/Header.astro', true],
      ['packages/website/src/pages/blog/post.mdx', true],
      ['packages/website/src/layouts/Base.astro', true],
    ])('%s → isSource=%s', (path, expected) => {
      expect(isSource(path)).toBe(expected)
    })
  })

  describe('Scoped markdown surfaces (new in SMI-4446)', () => {
    it.each([
      // Source: package READMEs (ship to npm), root README, skill bodies
      ['packages/cli/README.md', true],
      ['packages/core/README.md', true],
      ['packages/mcp-server/README.md', true],
      ['README.md', true],
      ['packages/mcp-server/src/assets/skills/skillsmith/SKILL.md', true],
      ['packages/mcp-server/src/assets/skills/some-author/some-skill/SKILL.md', true],
      // NOT source: docs/internal, retros, ADRs, root-level docs
      ['docs/internal/retros/foo.md', false],
      ['docs/internal/adr/100-foo.md', false],
      ['docs/internal/implementation/smi-4652.md', false],
      ['CHANGELOG.md', false],
      ['CONTRIBUTING.md', false],
      ['SECURITY.md', false],
      // NOT source: nested README inside non-package directory
      ['scripts/README.md', false],
      // NOT source: SKILL.md outside the asset bundle
      ['.claude/skills/governance/SKILL.md', false],
    ])('%s → isSource=%s', (path, expected) => {
      expect(isSource(path)).toBe(expected)
    })
  })

  describe('Existing source classifications (regression guard)', () => {
    it.each([
      ['packages/cli/src/index.ts', true],
      ['packages/core/src/db/schema.ts', true],
      ['packages/website/src/utils/helpers.tsx', true],
      ['supabase/functions/checkout/index.ts', true],
      ['scripts/ci/foo.ts', true],
      ['scripts/linear-hook.mjs', true],
      ['vitest.config.ts', true],
      ['lint-staged.config.js', true],
      ['.github/workflows/ci.yml', true],
      ['.github/workflows/publish.yaml', true],
    ])('%s → isSource=%s', (path, expected) => {
      expect(isSource(path)).toBe(expected)
    })
  })

  describe('Non-source paths (regression guard)', () => {
    it.each([
      ['package.json', false],
      ['package-lock.json', false],
      ['turbo.json', false],
      ['.env.example', false],
      ['Dockerfile', false],
      ['docker-compose.yml', false],
    ])('%s → isSource=%s', (path, expected) => {
      expect(isSource(path)).toBe(expected)
    })
  })
})

describe('TEST_PATTERNS (regression guard — unchanged by SMI-4446)', () => {
  it.each([
    ['packages/cli/src/foo.test.ts', true],
    ['packages/core/tests/integration/bar.spec.ts', true],
    ['scripts/tests/source-patterns.test.ts', true],
    ['packages/cli/src/index.ts', false],
    ['packages/cli/README.md', false],
  ])('%s → isTest=%s', (path, expected) => {
    expect(isTest(path)).toBe(expected)
  })
})

describe('DOCS_PATTERNS (regression guard — unchanged by SMI-4446)', () => {
  it.each([
    ['docs/internal/retros/foo.md', true],
    ['CHANGELOG.md', true],
    ['.claude/skills/governance/SKILL.md', true],
    ['packages/cli/src/index.ts', false],
    ['scripts/ci/foo.mjs', false],
  ])('%s → isDocs=%s', (path, expected) => {
    expect(isDocs(path)).toBe(expected)
  })
})
