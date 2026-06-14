/**
 * SMI-5178: parity guard for the compatibility slug vocabulary.
 *
 * Three surfaces must agree on the slug set:
 *  1. the indexer matrix (scripts/indexer/compatibility-map.ts) — derives slugs from skill_path
 *  2. @skillsmith/core (compatibility/slugs.ts) — the canonical filterable list + labels (MCP)
 *  3. the website badge renderer (lib/skill-card.ts) — mirrors the labels (client bundle
 *     cannot import core)
 *
 * This test fails if a slug is added to the matrix but not the canonical list, or if the
 * website label map drifts from core.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMPATIBILITY_MATRIX } from '../../indexer/compatibility-map.ts'
import { COMPATIBILITY_SLUGS, COMPATIBILITY_LABELS } from '@skillsmith/core'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

describe('compatibility slug parity (SMI-5178)', () => {
  it('every slug the indexer matrix can derive is in the canonical core list', () => {
    const matrixSlugs = new Set<string>()
    for (const [, slugs] of COMPATIBILITY_MATRIX) for (const s of slugs) matrixSlugs.add(s)
    const canonical = new Set<string>(COMPATIBILITY_SLUGS)
    for (const slug of matrixSlugs) {
      expect(canonical.has(slug), `matrix slug "${slug}" missing from COMPATIBILITY_SLUGS`).toBe(
        true
      )
    }
  })

  it('the canonical slug list has no duplicates and a label for every slug', () => {
    expect(new Set(COMPATIBILITY_SLUGS).size).toBe(COMPATIBILITY_SLUGS.length)
    for (const slug of COMPATIBILITY_SLUGS) {
      expect(COMPATIBILITY_LABELS[slug], `no label for "${slug}"`).toBeTruthy()
    }
  })

  it('the website badge renderer mirrors every core slug + label', () => {
    const skillCard = readFileSync(
      resolve(repoRoot, 'packages/website/src/lib/skill-card.ts'),
      'utf8'
    )
    for (const slug of COMPATIBILITY_SLUGS) {
      expect(skillCard, `website COMPAT_LABELS missing slug "${slug}"`).toContain(slug)
      expect(
        skillCard,
        `website COMPAT_LABELS missing label "${COMPATIBILITY_LABELS[slug]}"`
      ).toContain(COMPATIBILITY_LABELS[slug])
    }
  })
})
