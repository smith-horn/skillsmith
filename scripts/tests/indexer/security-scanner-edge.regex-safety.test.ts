/**
 * SMI-5879 (design §7): regex safety battery for the edge scanner's newly
 * ported 'content'/'both'-scope multiline patterns — the ones that run
 * against the FULL pass-1 content and are therefore the ReDoS-relevant
 * subset (design §7.1: every added pattern uses bounded quantifiers only;
 * §7.2/§7.3: a table-driven adversarial timing battery, not an aggregate-only
 * promise).
 *
 * Timing protocol (§7.3): 3 discarded warm-up iterations, then the MEDIAN of
 * 5 timed runs (median, not mean, so a single GC pause cannot fail a case).
 * Budgets: 250ms for a pass-1 full-content case up to MAX_CONTENT_SCAN_LENGTH
 * (1,000,000 chars); 2000ms for a whole-scan (scanSkillContent) on a 1MB
 * adversarial bundle covering every pattern under test at once.
 *
 * These patterns are VERBATIM copies of already-reviewed core source
 * (packages/core/src/security/scanner/patterns.jailbreak.ts) — same composed
 * fragments, same bounded quantifiers — so this battery is confirmation on
 * the edge scan path (new MAX_CONTENT_SCAN_LENGTH=1,000,000 cap, new
 * multiline engine) rather than a first-time ReDoS discovery exercise.
 */

import { describe, it, expect } from 'vitest'
import {
  JAILBREAK_PATTERNS,
  PROMPT_INJECTION_PATTERNS,
} from '../../indexer/_shared/security-scanner-edge.patterns.ts'
import { scanSkillContent } from '../../indexer/_shared/security-scanner-edge.ts'

const MAX_CONTENT_SCAN_LENGTH = 1_000_000

/** Median of 5 timed runs after 3 discarded warm-up iterations. */
function medianTiming(fn: () => void): number {
  for (let i = 0; i < 3; i++) fn()
  const samples: number[] = []
  for (let i = 0; i < 5; i++) {
    const start = performance.now()
    fn()
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  return samples[2]
}

/** Adversarial near-miss shapes designed to force maximum backtracking before failing. */
function adversarialShapes(sizeChars: number): Record<string, string> {
  return {
    'whitespace-run': ' '.repeat(sizeChars),
    'repeated-prefix': 'developer mode '.repeat(Math.ceil(sizeChars / 15)).slice(0, sizeChars),
    'near-miss-no-terminator': ('a'.repeat(79) + '\n')
      .repeat(Math.ceil(sizeChars / 80))
      .slice(0, sizeChars),
    'nested-quantifier-probe': '<!--'.repeat(Math.ceil(sizeChars / 4000)).slice(0, sizeChars),
  }
}

const CONTENT_SCOPE_CASES: Array<{ name: string; pattern: RegExp }> = [
  { name: 'JB_JS3A_DEV_MODE_THEN_CAPABILITY', pattern: JAILBREAK_PATTERNS[15] },
  { name: 'JB_JS3B_CAPABILITY_THEN_DEV_MODE', pattern: JAILBREAK_PATTERNS[16] },
  { name: 'AD_HTML_COMMENT_VERB', pattern: PROMPT_INJECTION_PATTERNS[2] },
  { name: 'AD_HTML_COMMENT_NOUN', pattern: PROMPT_INJECTION_PATTERNS[3] },
  { name: 'AD_DELIMITER_BARE', pattern: PROMPT_INJECTION_PATTERNS[5] },
  { name: 'AD_AN2_ROLE_BODY_NEXT_LINE', pattern: PROMPT_INJECTION_PATTERNS[8] },
]

const SIZES = [1_000, 10_000, 100_000, 1_000_000]

describe('SMI-5879 §7 — regex safety battery: bounded quantifiers only', () => {
  it('every content/both-scope pattern under test uses no unbounded catch-all span', () => {
    // A bounded quantifier never appears as a literal `.*` or `[\s\S]*` (no
    // upper bound) — every composed fragment in these patterns uses `{0,N}`
    // or a character class excluding the newline it must not cross.
    for (const { name, pattern } of CONTENT_SCOPE_CASES) {
      expect(pattern.source, `${name} contains an unbounded .*`).not.toMatch(/\.\*(?!\?)/)
      expect(pattern.source, `${name} contains an unbounded [\\s\\S]*`).not.toMatch(
        /\[\\s\\S\]\*(?!\?)/
      )
    }
  })
})

describe('SMI-5879 §7.3 — per-case latency budget: pass-1 full-content (250ms @ 1MB)', () => {
  for (const { name, pattern } of CONTENT_SCOPE_CASES) {
    for (const size of SIZES) {
      const shapes = adversarialShapes(size)
      for (const [shapeName, content] of Object.entries(shapes)) {
        it(`${name} / ${shapeName} / ${size} chars completes within budget`, () => {
          const scanned =
            content.length > MAX_CONTENT_SCAN_LENGTH
              ? content.slice(0, MAX_CONTENT_SCAN_LENGTH)
              : content
          const ms = medianTiming(() => {
            pattern.exec(scanned)
          })
          const budget = size >= 1_000_000 ? 250 : 50
          // SMI-5879 §7.3: every case's timing is written to the report
          // regardless of pass/fail.
          console.log(
            `[regex-safety] ${name}/${shapeName}/${size}: ${ms.toFixed(2)}ms (budget ${budget}ms)`
          )
          expect(ms, `${name}/${shapeName}/${size} exceeded its ${budget}ms budget`).toBeLessThan(
            budget
          )
        })
      }
    }
  }
})

describe('SMI-5879 §7.3 — whole-scan latency budget: 1MB adversarial bundle (2000ms)', () => {
  it('scanSkillContent completes within 2000ms on a 1MB bundle covering every content/both-scope pattern', async () => {
    const perPatternChunk = Math.floor(1_000_000 / CONTENT_SCOPE_CASES.length)
    const bundle = CONTENT_SCOPE_CASES.map((_, i) => {
      const shapes = adversarialShapes(perPatternChunk)
      const shapeNames = Object.keys(shapes)
      return shapes[shapeNames[i % shapeNames.length]]
    }).join('\n')

    // Warm up once (JIT), then time a single real invocation — a whole-scan
    // case is expensive enough that 3+5 repetitions would dominate CI time
    // for no additional signal beyond the aggregate already covered by the
    // per-pattern cases above.
    await scanSkillContent(bundle.slice(0, 10_000))
    const start = performance.now()
    await scanSkillContent(bundle)
    const ms = performance.now() - start

    console.log(
      `[regex-safety] scanSkillContent whole-scan 1MB bundle: ${ms.toFixed(2)}ms (budget 2000ms)`
    )
    expect(ms).toBeLessThan(2000)
  })
})
