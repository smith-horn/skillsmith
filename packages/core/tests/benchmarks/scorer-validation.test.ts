import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { exactMatchScorer } from '../../src/benchmarks/evoskill/scorers.js'

interface FixtureSample {
  question: string
  predicted: string
  groundTruth: string
  pythonScore: number
  scorer: string
}

function loadFixtures(filename: string): FixtureSample[] {
  const filePath = join(__dirname, 'fixtures', filename)
  return JSON.parse(readFileSync(filePath, 'utf-8'))
}

/**
 * Known divergences between TypeScript exactMatchScorer and Python scorers.
 * These are documented and accepted differences in scoring behavior.
 *
 * - Python reward.py supports substring matching ("Paris" in "The answer is Paris")
 *   TypeScript requires exact match after normalization.
 * - Python reward.py strips parentheticals for text comparison
 *   TypeScript does not.
 * - Python dabstep_scorer uses SequenceMatcher (>0.95 similarity)
 *   TypeScript does not do fuzzy string matching.
 * - Python dabstep_scorer supports list reordering (semicolon/comma separated)
 *   TypeScript does not.
 */

describe('Cross-validate OfficeQA scorer against Python (reward.py)', () => {
  const fixtures = loadFixtures('evoskill-scorer-samples-officeqa.json')

  it('has 100 fixture samples', () => {
    expect(fixtures).toHaveLength(100)
  })

  it('has a mix of correct and incorrect samples', () => {
    const correct = fixtures.filter((f) => f.pythonScore === 1.0).length
    const incorrect = fixtures.filter((f) => f.pythonScore === 0.0).length
    expect(correct).toBeGreaterThan(20)
    expect(incorrect).toBeGreaterThan(5)
  })

  // Known divergences where Python matches but TypeScript doesn't (or vice versa)
  const KNOWN_DIVERGENCES = new Set([
    // Python reward.py supports substring matching; TypeScript does not
    'The answer is Paris|Paris',
    "I think it's Shakespeare|Shakespeare",
    'The answer is 0|0',
    'The values are 10 and 20|10 and 20',
    // Python strips parentheticals; TypeScript does not
    'Federal Old-Age and Survivors Insurance (OASI) Trust Fund|Federal Old-Age and Survivors Insurance Trust Fund',
  ])

  it('diverges ≤5% from Python scorer (excluding known divergences)', () => {
    let disagreements = 0
    const diverged: string[] = []

    for (const sample of fixtures) {
      const key = `${sample.predicted}|${sample.groundTruth}`
      if (KNOWN_DIVERGENCES.has(key)) continue

      const tsScore = exactMatchScorer(sample.question, sample.predicted, sample.groundTruth)
      const pyScore = sample.pythonScore

      if ((tsScore >= 0.5 ? 1 : 0) !== (pyScore >= 0.5 ? 1 : 0)) {
        disagreements++
        diverged.push(
          `predicted=${JSON.stringify(sample.predicted)} gt=${JSON.stringify(sample.groundTruth)} ts=${tsScore} py=${pyScore}`
        )
      }
    }

    const effectiveTotal = fixtures.length - KNOWN_DIVERGENCES.size
    const divergenceRate = disagreements / effectiveTotal

    if (diverged.length > 0) {
      console.log(`Divergences (${diverged.length}):`)
      for (const d of diverged) console.log(`  ${d}`)
    }

    expect(divergenceRate).toBeLessThanOrEqual(0.05)
  })

  it('agrees on exact-match cases', () => {
    const exactCases = fixtures.filter(
      (f) => f.predicted.trim().toLowerCase() === f.groundTruth.trim().toLowerCase()
    )
    expect(exactCases.length).toBeGreaterThan(10)

    for (const sample of exactCases) {
      const tsScore = exactMatchScorer(sample.question, sample.predicted, sample.groundTruth)
      expect(tsScore).toBe(1.0)
    }
  })

  it('agrees on clearly wrong answers', () => {
    const wrongCases = fixtures.filter((f) => f.predicted === 'wrong answer')
    expect(wrongCases.length).toBeGreaterThan(5)

    for (const sample of wrongCases) {
      const tsScore = exactMatchScorer(sample.question, sample.predicted, sample.groundTruth)
      expect(tsScore).toBe(0.0)
    }
  })
})

describe('Cross-validate DABStep scorer against Python (dabstep_scorer)', () => {
  const fixtures = loadFixtures('evoskill-scorer-samples-dabstep.json')

  it('has 100 fixture samples', () => {
    expect(fixtures).toHaveLength(100)
  })

  // DABStep-specific divergences
  const KNOWN_DIVERGENCES = new Set([
    // Python dabstep_scorer supports list reordering; TypeScript does not
    'C; B; A|A; B; C',
    'C, B, A|A, B, C',
    // Python dabstep_scorer uses SequenceMatcher (>0.95); TypeScript does not
    'Shakespear|Shakespeare',
    // TypeScript splits ground truth by ', ' as alternatives; DABStep treats as list
    'A, B, C|A, B, C',
    // Python dabstep_scorer uses math.isclose(rel_tol=1e-4); TypeScript uses absolute ±0.01
    '99.99|100',
  ])

  it('diverges ≤5% from Python scorer (excluding known divergences)', () => {
    let disagreements = 0
    const diverged: string[] = []

    for (const sample of fixtures) {
      const key = `${sample.predicted}|${sample.groundTruth}`
      if (KNOWN_DIVERGENCES.has(key)) continue

      const tsScore = exactMatchScorer(sample.question, sample.predicted, sample.groundTruth)
      const pyScore = sample.pythonScore

      if ((tsScore >= 0.5 ? 1 : 0) !== (pyScore >= 0.5 ? 1 : 0)) {
        disagreements++
        diverged.push(
          `predicted=${JSON.stringify(sample.predicted)} gt=${JSON.stringify(sample.groundTruth)} ts=${tsScore} py=${pyScore}`
        )
      }
    }

    const effectiveTotal = fixtures.length - KNOWN_DIVERGENCES.size
    const divergenceRate = disagreements / effectiveTotal

    if (diverged.length > 0) {
      console.log(`Divergences (${diverged.length}):`)
      for (const d of diverged) console.log(`  ${d}`)
    }

    expect(divergenceRate).toBeLessThanOrEqual(0.05)
  })

  it('agrees on exact-match cases', () => {
    // Skip list-pattern cases (contain commas or semicolons) where TS splits as alternatives
    const exactCases = fixtures.filter(
      (f) =>
        f.predicted.trim().toLowerCase() === f.groundTruth.trim().toLowerCase() &&
        !f.groundTruth.includes(', ') &&
        !f.groundTruth.includes('; ')
    )
    expect(exactCases.length).toBeGreaterThan(10)

    for (const sample of exactCases) {
      const tsScore = exactMatchScorer(sample.question, sample.predicted, sample.groundTruth)
      expect(tsScore).toBe(1.0)
    }
  })

  it('agrees on clearly wrong answers', () => {
    const wrongCases = fixtures.filter((f) => f.predicted === 'completely_wrong_answer_xyz')

    for (const sample of wrongCases) {
      const tsScore = exactMatchScorer(sample.question, sample.predicted, sample.groundTruth)
      expect(tsScore).toBe(0.0)
    }
  })
})
