/**
 * SMI-4415: Unit tests for the signal-of-intent gate.
 *
 * Fixture-driven verification of the Wave 0 admit/reject gate criteria:
 *   - ≥ 98% known-good admission (known-good.json, 10 entries → 100% expected)
 *   - ≥ 95% non-skill rejection (non-skills.json, 20 entries → 100% expected)
 *
 * Plus explicit regression guards:
 *   - Plan-review H4 floor: metadata-only skills must reject even at high score
 *   - Score-boundary: score === SIGNAL_THRESHOLD with structural signal admits,
 *     score === SIGNAL_THRESHOLD - 1 rejects
 *   - mcp-server-only: structural but below threshold → reject
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  computeSignalScore,
  HIGH_TRUST_OWNERS,
  shouldIngest,
  SIGNAL_THRESHOLD,
} from '../../src/scripts/github-import/signal-of-intent.js'
import type { ImportedSkill } from '../../src/scripts/github-import/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = join(__dirname, 'fixtures')

function loadFixture(name: string): ImportedSkill[] {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf-8')) as ImportedSkill[]
}

/**
 * Minimal ImportedSkill shape for synthetic regression tests. Fields not
 * relevant to scoring get benign defaults.
 */
function makeSkill(partial: Partial<ImportedSkill>): ImportedSkill {
  return {
    id: partial.id ?? 'github/test/synthetic',
    name: partial.name ?? 'synthetic',
    description: partial.description ?? '',
    author: partial.author ?? 'test',
    repo_url: partial.repo_url ?? 'https://github.com/test/synthetic',
    clone_url: partial.clone_url ?? 'https://github.com/test/synthetic.git',
    stars: partial.stars ?? 0,
    forks: partial.forks ?? 0,
    topics: partial.topics ?? [],
    language: partial.language ?? null,
    license: partial.license ?? null,
    created_at: partial.created_at ?? '2024-01-01T00:00:00Z',
    updated_at: partial.updated_at ?? '2026-04-21T00:00:00Z',
    source: partial.source ?? 'github',
    query_type: partial.query_type ?? 'test',
    imported_at: partial.imported_at ?? '2026-04-21T00:00:00Z',
  }
}

describe('signal-of-intent gate', () => {
  describe('known-good fixtures', () => {
    const knownGood = loadFixture('known-good.json')

    it('loads exactly 10 entries (Wave 0 sample size)', () => {
      expect(knownGood).toHaveLength(10)
    })

    it.each(knownGood.map((s) => [s.id, s] as const))('admits %s', (_id, skill) => {
      expect(shouldIngest(skill)).toBe(true)
    })

    it('hits 100% admit rate on Wave 0 fixture corpus', () => {
      const admitted = knownGood.filter((s) => shouldIngest(s))
      expect(admitted).toHaveLength(knownGood.length)
    })
  })

  describe('non-skill fixtures', () => {
    const nonSkills = loadFixture('non-skills.json')

    it('loads exactly 20 entries (Wave 0 sample size)', () => {
      expect(nonSkills).toHaveLength(20)
    })

    it.each(nonSkills.map((s) => [s.id, s] as const))('rejects %s', (_id, skill) => {
      expect(shouldIngest(skill)).toBe(false)
    })

    it('hits 100% reject rate on Wave 0 fixture corpus', () => {
      const admitted = nonSkills.filter((s) => shouldIngest(s))
      expect(admitted).toHaveLength(0)
    })
  })

  describe('structural-signal floor (plan-review H4)', () => {
    it('rejects metadata-only skills even when total score exceeds threshold', () => {
      // Every metadata signal fires: description(+2) + name(+2) + language(+1)
      // + license(+1) + stars(+1) = 7, well above SIGNAL_THRESHOLD (4).
      // But topics=[] and author not in HIGH_TRUST_OWNERS → no structural
      // signal → shouldIngest MUST reject. This is the H4 regression guard.
      const metadataOnly = makeSkill({
        id: 'github/nobody/claude-skill',
        name: 'claude-skill', // matches NAME_REGEX
        description: 'A skill for anthropic claude-code users', // matches DESCRIPTION_REGEX
        author: 'nobody', // NOT in HIGH_TRUST_OWNERS
        topics: [], // no structural topic
        language: 'TypeScript',
        license: 'MIT',
        stars: 500, // >= STARS_THRESHOLD
      })

      const { score, signals, hasStructuralSignal } = computeSignalScore(metadataOnly)
      expect(score).toBeGreaterThan(SIGNAL_THRESHOLD)
      expect(hasStructuralSignal).toBe(false)
      expect(signals).toEqual(
        expect.arrayContaining([
          'description-match',
          'name-match',
          'language-match',
          'license-present',
          'stars-threshold',
        ])
      )
      expect(shouldIngest(metadataOnly)).toBe(false)
    })
  })

  describe('boundary conditions', () => {
    it('admits a structural skill whose score equals SIGNAL_THRESHOLD', () => {
      // Structural topic alone = +4 (exactly SIGNAL_THRESHOLD).
      const exactlyAtThreshold = makeSkill({
        topics: ['claude-skill'], // +4, structural
        // no other signals
      })

      const { score, hasStructuralSignal } = computeSignalScore(exactlyAtThreshold)
      expect(score).toBe(SIGNAL_THRESHOLD)
      expect(hasStructuralSignal).toBe(true)
      expect(shouldIngest(exactlyAtThreshold)).toBe(true)
    })

    it('rejects a structural skill whose score is one below SIGNAL_THRESHOLD', () => {
      // mcp-server (+1, structural) + license (+1) + stars (+1) = 3.
      const justBelowThreshold = makeSkill({
        topics: ['mcp-server'], // +1, structural
        license: 'MIT', // +1
        stars: 50, // +1
      })

      const { score, hasStructuralSignal } = computeSignalScore(justBelowThreshold)
      expect(score).toBe(SIGNAL_THRESHOLD - 1)
      expect(hasStructuralSignal).toBe(true)
      expect(shouldIngest(justBelowThreshold)).toBe(false)
    })

    it('rejects mcp-server-only skills (structural but below threshold)', () => {
      // Just the mcp-server topic, no other signals. score=1 < threshold.
      const mcpOnly = makeSkill({ topics: ['mcp-server'] })
      const { score, hasStructuralSignal } = computeSignalScore(mcpOnly)
      expect(score).toBe(1)
      expect(hasStructuralSignal).toBe(true)
      expect(shouldIngest(mcpOnly)).toBe(false)
    })

    it('respects a caller-supplied threshold override', () => {
      // Same mcp-server-only skill, but threshold lowered to 1 → admits.
      const mcpOnly = makeSkill({ topics: ['mcp-server'] })
      expect(shouldIngest(mcpOnly, 1)).toBe(true)
      expect(shouldIngest(mcpOnly, 2)).toBe(false)
    })
  })

  describe('HIGH_TRUST_OWNERS', () => {
    it('admits trusted-owner skills with no topics (community marketplace case)', () => {
      // `daymade/claude-code-skills` in Wave 0 R2: HIGH_TRUST_OWNERS entry,
      // empty topics, would otherwise fail the structural floor. score = 5
      // (owner alone) + metadata >= threshold.
      const owner = Array.from(HIGH_TRUST_OWNERS)[0]
      expect(owner).toBeDefined()
      const trustedNoTopics = makeSkill({
        author: owner,
        topics: [],
        description: 'claude skill',
        name: 'claude-skill',
      })
      const { hasStructuralSignal, signals } = computeSignalScore(trustedNoTopics)
      expect(hasStructuralSignal).toBe(true)
      expect(signals).toContain('high-trust-owner')
      expect(shouldIngest(trustedNoTopics)).toBe(true)
    })

    it('matches HIGH_TRUST_OWNERS case-insensitively', () => {
      const skill = makeSkill({
        author: 'ANTHROPICS', // uppercase
        topics: [],
      })
      const { hasStructuralSignal } = computeSignalScore(skill)
      expect(hasStructuralSignal).toBe(true)
    })
  })
})
