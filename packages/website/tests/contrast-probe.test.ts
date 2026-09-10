/**
 * Validates the contrast probe itself (SMI-6503).
 *
 * A checker exercised only by the page it checks cannot distinguish "the page
 * passes" from "the checker silently measures nothing." These fixtures pin it
 * to ratios computed independently, including the group-opacity case that the
 * original bug turned on.
 *
 * Lives at tests/ rather than tests/e2e/ deliberately: the website vitest
 * config EXCLUDES tests/e2e/**, so a unit test placed beside the probe would be
 * silently collected by nothing and never run — the same "invisible success"
 * shape this probe exists to prevent. The probe module itself stays under
 * tests/e2e/ with its Playwright consumer.
 */

import { describe, it, expect } from 'vitest'
import {
  parseRgb,
  composite,
  contrastRatio,
  aaThreshold,
  evaluateSamples,
} from './e2e/cross-harness-inventory.contrast-probe'

const OPAQUE = (c: string) => ({ color: c, opacity: 1 })

function sample(over: Partial<Record<string, unknown>> = {}) {
  return {
    selector: '.probe',
    text: 'x',
    color: 'rgb(255, 255, 255)',
    fontSizePx: 13,
    fontWeight: 400,
    opacity: 1,
    chain: [OPAQUE('rgb(0, 0, 0)')],
    ...over,
  } as never
}

describe('parseRgb', () => {
  it('reads rgb() as fully opaque', () => {
    expect(parseRgb('rgb(17, 17, 20)')).toEqual({ r: 17, g: 17, b: 20, a: 1 })
  })

  it('reads the alpha channel from rgba()', () => {
    expect(parseRgb('rgba(34, 197, 94, 0.1)')).toEqual({ r: 34, g: 197, b: 94, a: 0.1 })
  })

  it('refuses an unparseable value rather than defaulting to black', () => {
    // Silently treating a bad value as black would invent a passing ratio.
    expect(() => parseRgb('transparent')).toThrow(/unparseable/)
  })
})

describe('contrastRatio — known values', () => {
  it('is 21:1 for black on white', () => {
    const w = parseRgb('rgb(255, 255, 255)')
    const b = parseRgb('rgb(0, 0, 0)')
    expect(contrastRatio(w, b)).toBeCloseTo(21, 5)
  })

  it('is 1:1 for a colour against itself', () => {
    const c = parseRgb('rgb(123, 45, 67)')
    expect(contrastRatio(c, c)).toBeCloseTo(1, 10)
  })

  it('is symmetric', () => {
    const a = parseRgb('rgb(161, 161, 170)')
    const b = parseRgb('rgb(24, 24, 27)')
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10)
  })

  it('matches the measured tier values this page ships', () => {
    // --sk-text-muted #a1a1aa on the skill-row background #18181b.
    expect(contrastRatio(parseRgb('rgb(161, 161, 170)'), parseRgb('rgb(24, 24, 27)'))).toBeCloseTo(
      6.91,
      1
    )
    // --sk-accent-stale #f4a261 on the device-card background #111114.
    expect(contrastRatio(parseRgb('rgb(244, 162, 97)'), parseRgb('rgb(17, 17, 20)'))).toBeCloseTo(
      9.14,
      1
    )
  })
})

describe('aaThreshold', () => {
  it('requires 4.5:1 for body text', () => {
    expect(aaThreshold(13, 400)).toBe(4.5)
    expect(aaThreshold(18, 700)).toBe(4.5)
  })

  it('relaxes to 3:1 only for genuinely large text', () => {
    expect(aaThreshold(24, 400)).toBe(3)
    expect(aaThreshold(18.66, 700)).toBe(3)
  })

  it('does not relax for large-but-not-bold under 24px', () => {
    expect(aaThreshold(20, 400)).toBe(4.5)
  })
})

describe('composite', () => {
  it('leaves an opaque colour unchanged', () => {
    const fg = parseRgb('rgb(10, 20, 30)')
    expect(composite(fg, parseRgb('rgb(255, 255, 255)'))).toEqual({ r: 10, g: 20, b: 30, a: 1 })
  })

  it('blends 50% white over black to mid grey', () => {
    const out = composite({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0, a: 1 })
    expect(out.r).toBeCloseTo(127.5, 5)
  })
})

describe('evaluateSamples — group opacity', () => {
  it('reports a passing ratio when nothing is dimmed', () => {
    const r = evaluateSamples({
      raw: [sample()],
      scannedTextNodes: 1,
      deviceCards: 1,
      staleCards: 0,
      harnessHeadings: [],
    })
    expect(r.failures).toHaveLength(0)
    expect(r.worstRatio).toBeCloseTo(21, 5)
  })

  it('composites BOTH foreground and background through ancestor opacity', () => {
    // White on black inside an ancestor at 50% opacity, over a white canvas.
    // The chain entry carries that ancestor's own opacity and `opacity` carries
    // the accumulated product, which is how the in-page collector reports a
    // real DOM: both must describe the same ancestor or the fixture is
    // impossible. Both layers blend toward white, so the pair converges rather
    // than the text alone fading — the distinction the original bug hinged on.
    const r = evaluateSamples({
      raw: [sample({ opacity: 0.5, chain: [{ color: 'rgb(0, 0, 0)', opacity: 0.5 }] })],
      scannedTextNodes: 1,
      deviceCards: 1,
      staleCards: 1,
      harnessHeadings: [],
    })
    const s = r.samples[0]!
    expect(s.bg).toBe('rgb(128, 128, 128)')
    expect(s.fg).toBe('rgb(255, 255, 255)')
    // Independently derived: white (L=1.0) against 127.5 grey (L=0.2139) gives
    // (1.0+0.05)/(0.2139+0.05) = 3.98. Pinning the number rather than
    // round-tripping through s.fg/s.bg, which are rounded for display and would
    // make this assertion merely self-consistent.
    expect(s.ratio).toBeCloseTo(3.98, 1)
    // Undimmed this pair is 21:1; the drop is the whole point of the check.
    expect(s.ratio).toBeLessThan(21)
  })

  it('catches a below-AA sample that looks compliant before compositing', () => {
    // #71717a on #111114 is 3.90:1 declared — already failing — and the old
    // opacity:.72 dragged it to ~2.6:1. Either way the probe must flag it.
    const r = evaluateSamples({
      raw: [
        sample({
          color: 'rgb(113, 113, 122)',
          chain: [{ color: 'rgb(17, 17, 20)', opacity: 0.72 }],
          opacity: 0.72,
        }),
      ],
      scannedTextNodes: 1,
      deviceCards: 1,
      staleCards: 1,
      harnessHeadings: [],
    })
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]!.ratio).toBeLessThan(4.5)
  })

  it('names the cause when the page returned nothing usable', () => {
    // The CI failure this guards against surfaced as an opaque
    // "Cannot read properties of undefined (reading 'raw')" pointing at the
    // fold, not at the page.evaluate call that actually went wrong.
    expect(() => evaluateSamples(undefined as never)).toThrow(/collected nothing usable/)
    expect(() => evaluateSamples({ notRaw: true } as never)).toThrow(/self-invoking expression/)
  })

  it('reports worstRatio null and no failures when it measured nothing', () => {
    // The spec must treat this as a hard failure rather than a pass — an empty
    // scan produces an empty failures list, which is indistinguishable from
    // success if only `failures` is asserted on.
    const r = evaluateSamples({
      raw: [],
      scannedTextNodes: 0,
      deviceCards: 0,
      staleCards: 0,
      harnessHeadings: [],
    })
    expect(r.failures).toHaveLength(0)
    expect(r.worstRatio).toBeNull()
    expect(r.scannedTextNodes).toBe(0)
  })
})
