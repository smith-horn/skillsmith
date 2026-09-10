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
  COLLECT_IN_PAGE,
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
    ownOpacity: 1,
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

  it('blends onto the real backdrop outside the group, not a white canvas', () => {
    // The page's true stack: near-black body behind a near-black card. Assuming
    // a white canvas would lighten both colours and misreport the ratio.
    const r = evaluateSamples({
      raw: [
        sample({
          color: 'rgb(161, 161, 170)', // --sk-text-muted
          // `opacity` is the element's ACCUMULATED ancestor opacity and must
          // agree with the chain, which carries each layer's own — a fixture
          // where they disagree describes a DOM that cannot exist.
          opacity: 0.5,
          chain: [
            { color: 'rgb(17, 17, 20)', opacity: 0.5 }, // card, dimmed
            { color: 'rgb(13, 13, 15)', opacity: 1 }, // body
          ],
        }),
      ],
      scannedTextNodes: 1,
      deviceCards: 1,
      staleCards: 1,
      harnessHeadings: [],
    })
    const s = r.samples[0]!
    // Per channel, blended at 50% onto the body rgb(13,13,15):
    //   fg = (.5*161+.5*13, .5*161+.5*13, .5*170+.5*15) = (87, 87, 92.5 -> 93)
    //   bg = (.5*17 +.5*13, .5*17 +.5*13, .5*20 +.5*15) = (15, 15, 17.5 -> 18)
    // Against a white canvas both would be far lighter and the ratio wrong.
    expect(s.fg).toBe('rgb(87, 87, 93)')
    expect(s.bg).toBe('rgb(15, 15, 18)')
  })

  it('flags a pairing that passes undimmed and fails only once dimmed', () => {
    // The regression's exact shape: a colour comfortably above AA at full
    // opacity that drops below it once the card is composited at 72%. A probe
    // that ignored group opacity would report this as passing. (It does not
    // distinguish a wrong backdrop — this pairing fails on white too; the
    // preceding fixture covers backdrop correctness via exact colours.)
    const chain = [
      { color: 'rgb(17, 17, 20)', opacity: 1 },
      { color: 'rgb(13, 13, 15)', opacity: 1 },
    ]
    const undimmed = evaluateSamples({
      raw: [sample({ color: 'rgb(125, 125, 130)', chain })],
      scannedTextNodes: 1,
      deviceCards: 1,
      staleCards: 0,
      harnessHeadings: [],
    })
    expect(undimmed.failures, 'should pass at full opacity').toHaveLength(0)
    expect(undimmed.samples[0]!.ratio).toBeGreaterThan(4.5)

    const dimmed = evaluateSamples({
      raw: [
        sample({
          color: 'rgb(125, 125, 130)',
          opacity: 0.72,
          chain: [{ ...chain[0]!, opacity: 0.72 }, chain[1]!],
        }),
      ],
      scannedTextNodes: 1,
      deviceCards: 1,
      staleCards: 1,
      harnessHeadings: [],
    })
    expect(dimmed.failures, 'the same pairing must fail once the card is dimmed').toHaveLength(1)
    expect(dimmed.samples[0]!.ratio).toBeLessThan(4.5)
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

  it('refuses opacity on the sampled element itself', () => {
    // The subtle half: ancestorOpacity() walks from the element, so element
    // opacity lands in the accumulated alpha, while `chain` starts at the parent
    // and never counts it. Checked on its own or it is invisible to the nesting
    // guard below.
    expect(() =>
      evaluateSamples({
        raw: [sample({ opacity: 0.5, ownOpacity: 0.5 })],
        scannedTextNodes: 1,
        deviceCards: 1,
        staleCards: 0,
        harnessHeadings: [],
      })
    ).toThrow(/on the sampled element/)
  })

  it('refuses element opacity combined with one ancestor opacity', () => {
    // This is the pair that would otherwise slip through: chain carries ONE
    // opacity entry, so the nesting guard sees a single supported boundary,
    // while the accumulated alpha silently contains two.
    expect(() =>
      evaluateSamples({
        raw: [
          sample({
            opacity: 0.36, // 0.72 ancestor * 0.5 element
            ownOpacity: 0.5,
            chain: [
              { color: 'rgb(17, 17, 20)', opacity: 0.72 },
              { color: 'rgb(13, 13, 15)', opacity: 1 },
            ],
          }),
        ],
        scannedTextNodes: 1,
        deviceCards: 1,
        staleCards: 1,
        harnessHeadings: [],
      })
    ).toThrow(/on the sampled element/)
  })

  it('refuses nested opacity rather than silently mis-measuring it', () => {
    // Two boundaries each composite through their own buffer. Collapsing them
    // to one alpha is wrong whenever a background sits between them, and the
    // error would be invisible in the reported ratio — so the probe throws.
    expect(() =>
      evaluateSamples({
        raw: [
          sample({
            opacity: 0.36, // 0.72 * 0.5, the collapsed value
            chain: [
              { color: 'rgb(24, 24, 27)', opacity: 0.5 }, // inner group
              { color: 'rgb(17, 17, 20)', opacity: 0.72 }, // outer group
              { color: 'rgb(13, 13, 15)', opacity: 1 }, // body
            ],
          }),
        ],
        scannedTextNodes: 1,
        deviceCards: 1,
        staleCards: 1,
        harnessHeadings: [],
      })
    ).toThrow(/2 nested opacity ancestors/)
  })

  it('still accepts a single opacity boundary', () => {
    // The supported shape must keep working — a guard that rejects the valid
    // case too would be worse than the bug it prevents.
    const r = evaluateSamples({
      raw: [
        sample({
          opacity: 0.72,
          chain: [
            { color: 'rgb(17, 17, 20)', opacity: 0.72 },
            { color: 'rgb(13, 13, 15)', opacity: 1 },
          ],
        }),
      ],
      scannedTextNodes: 1,
      deviceCards: 1,
      staleCards: 1,
      harnessHeadings: [],
    })
    expect(r.samples).toHaveLength(1)
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

describe('evaluateSamples — collector contract', () => {
  // Round-5 gate (GPT-5.6-Sol via NEEDLE): both opacity guards are written as
  // `< 1`, and `undefined < 1` / `NaN < 1` are BOTH false. A collector that
  // stopped emitting a field would therefore disable the guard silently and
  // the probe would report a plausible, wrong ratio — the exact failure this
  // module exists to prevent, one level up. These pin the fail-CLOSED contract.
  const BAD: [string, unknown][] = [
    ['absent', undefined],
    ['null', null],
    ['NaN', NaN],
    ['a numeric string', '0.5'],
    ['above 1', 1.5],
    ['below 0', -0.1],
  ]

  for (const [label, value] of BAD) {
    it(`refuses ${label} ownOpacity rather than measuring past the guard`, () => {
      expect(() =>
        evaluateSamples({
          raw: [sample({ ownOpacity: value })],
          scannedTextNodes: 1,
          deviceCards: 1,
          staleCards: 0,
          harnessHeadings: [],
        })
      ).toThrow(/ownOpacity/)
    })

    it(`refuses ${label} accumulated opacity`, () => {
      expect(() =>
        evaluateSamples({
          raw: [sample({ opacity: value })],
          scannedTextNodes: 1,
          deviceCards: 1,
          staleCards: 0,
          harnessHeadings: [],
        })
      ).toThrow(/opacity=/)
    })

    it(`refuses ${label} chain-layer opacity`, () => {
      expect(() =>
        evaluateSamples({
          raw: [sample({ chain: [{ color: 'rgb(0, 0, 0)', opacity: value }] })],
          scannedTextNodes: 1,
          deviceCards: 1,
          staleCards: 0,
          harnessHeadings: [],
        })
      ).toThrow(/chain\[0\]\.opacity/)
    })
  }

  it('refuses a non-array background chain', () => {
    expect(() =>
      evaluateSamples({
        raw: [sample({ chain: undefined })],
        scannedTextNodes: 1,
        deviceCards: 1,
        staleCards: 0,
        harnessHeadings: [],
      })
    ).toThrow(/background chain/)
  })

  it('still measures a fully valid sample', () => {
    const r = evaluateSamples({
      raw: [sample()],
      scannedTextNodes: 1,
      deviceCards: 1,
      staleCards: 0,
      harnessHeadings: [],
    })
    expect(r.samples).toHaveLength(1)
    expect(r.samples[0]!.ratio).toBeCloseTo(21, 5)
  })
})

/**
 * Round-5 gate finding: every fixture above builds its sample through the local
 * `sample()` helper, which hard-codes `ownOpacity`. Deleting or misspelling
 * that field inside `COLLECT_IN_PAGE` would leave all of them green while
 * reopening the round-4 bug on the real page.
 *
 * `COLLECT_IN_PAGE` is a string evaluated in the browser, so nothing
 * type-checks it. These tests execute the SHIPPED string against a hand-rolled
 * DOM and feed its real output to `evaluateSamples` — the two halves that
 * production actually connects.
 */
interface FakeNode {
  nodeType: number
  textContent: string
}
interface FakeEl {
  tagName: string
  className: string
  childNodes: FakeNode[]
  parentElement: FakeEl | null
  style: Record<string, string>
}

function makeCollectorDom(
  opts: { elementOpacity?: number; cardOpacity?: number; cardBackground?: string } = {}
) {
  const style = (over: Record<string, string> = {}): Record<string, string> => ({
    opacity: '1',
    backgroundColor: 'rgba(0, 0, 0, 0)',
    color: 'rgb(255, 255, 255)',
    fontSize: '13px',
    fontWeight: '400',
    display: 'block',
    visibility: 'visible',
    ...over,
  })

  const body: FakeEl = {
    tagName: 'BODY',
    className: '',
    childNodes: [],
    parentElement: null,
    style: style({ backgroundColor: 'rgb(13, 13, 15)' }),
  }
  const card: FakeEl = {
    tagName: 'DIV',
    className: 'device-card',
    childNodes: [],
    parentElement: body,
    style: style({
      backgroundColor: opts.cardBackground ?? 'rgb(17, 17, 20)',
      opacity: String(opts.cardOpacity ?? 1),
    }),
  }
  const label: FakeEl = {
    tagName: 'SPAN',
    className: 'device-label',
    childNodes: [{ nodeType: 3, textContent: 'Claude Code' }],
    parentElement: card,
    style: style({ opacity: String(opts.elementOpacity ?? 1) }),
  }

  const document = {
    body,
    querySelectorAll(sel: string): FakeEl[] {
      switch (sel) {
        case '[data-testid="device-card"] *':
          return [label]
        case '[data-testid="device-card"]':
          return [card]
        case '.device-card--stale':
          return []
        case '.harness-heading':
          return []
        default:
          // Fail loudly. A fake DOM that answered [] for an unrecognised
          // selector would let a collector selector change pass as green —
          // the same invisible-success shape this probe exists to prevent.
          throw new Error(`[test] fake DOM got an unexpected selector: ${sel}`)
      }
    },
  }
  return { document, getComputedStyle: (el: FakeEl) => el.style }
}

type Collected = Parameters<typeof evaluateSamples>[0]

function runCollector(
  opts: { elementOpacity?: number; cardOpacity?: number; cardBackground?: string } = {}
): Collected {
  const dom = makeCollectorDom(opts)
  // Executing the shipped string is the whole point: a copy would test the
  // copy. `COLLECT_IN_PAGE` is a self-invoking expression, so it is returned.
  const fn = new Function('document', 'getComputedStyle', `return ${COLLECT_IN_PAGE}`) as (
    d: unknown,
    g: unknown
  ) => Collected
  return fn(dom.document, dom.getComputedStyle)
}

describe('COLLECT_IN_PAGE — the shipped collector, executed', () => {
  it('emits every field evaluateSamples depends on', () => {
    const c = runCollector()
    expect(c.raw).toHaveLength(1)
    const s = c.raw[0]!
    // Named one by one so a dropped field fails HERE, by name, rather than
    // surfacing as a wrong ratio on the real page.
    expect(s).toHaveProperty('ownOpacity', 1)
    expect(s).toHaveProperty('opacity', 1)
    expect(s.selector).toBe('.device-label')
    expect(s.color).toBe('rgb(255, 255, 255)')
    expect(s.fontSizePx).toBe(13)
    expect(s.fontWeight).toBe(400)
    expect(s.chain.map((l) => l.color)).toEqual(['rgb(17, 17, 20)', 'rgb(13, 13, 15)'])
    expect(c.deviceCards).toBe(1)
    expect(c.scannedTextNodes).toBe(1)
  })

  it('feeds evaluateSamples a measurable sample end to end', () => {
    const r = evaluateSamples(runCollector())
    expect(r.samples).toHaveLength(1)
    expect(r.worstRatio).toBeGreaterThan(4.5)
    expect(r.failures).toHaveLength(0)
  })

  it('reports element opacity separately from the accumulated alpha', () => {
    const c = runCollector({ elementOpacity: 0.5 })
    const s = c.raw[0]!
    expect(s.ownOpacity).toBe(0.5)
    expect(s.opacity).toBe(0.5)
    // `chain` starts at the PARENT, so it never sees the element's own opacity.
    expect(s.chain.every((l) => l.opacity === 1)).toBe(true)
    expect(() => evaluateSamples(c)).toThrow(/on the sampled element/)
  })

  it('refuses the element-plus-ancestor pair that round 4 found', () => {
    const c = runCollector({ elementOpacity: 0.5, cardOpacity: 0.72 })
    const s = c.raw[0]!
    // One chain entry carries opacity, so the nesting guard alone would see a
    // single supported boundary while the accumulated alpha holds two.
    expect(s.chain.filter((l) => l.opacity < 1)).toHaveLength(1)
    expect(s.opacity).toBeCloseTo(0.36, 10)
    expect(() => evaluateSamples(c)).toThrow(/on the sampled element/)
  })

  it('still refuses two nested ancestors with no element opacity', () => {
    const c = runCollector({ cardOpacity: 0.72 })
    // Hand-add a second opacity-bearing ancestor to the collected chain.
    c.raw[0]!.chain[1]!.opacity = 0.8
    c.raw[0]!.opacity = 0.72 * 0.8
    expect(() => evaluateSamples(c)).toThrow(/nested opacity ancestors/)
  })
})

describe('parseRgb — strict colour syntax', () => {
  // Round-6 gate finding: the old parser pulled digit runs out of ANY string,
  // so a modern colour space would have been reinterpreted as sRGB 0-255 and
  // produced a plausible wrong ratio. These pin the refusal.
  const MODERN = [
    'oklch(0.7 0.1 250)',
    'oklch(70% 0.1 250 / 0.5)',
    'lab(54% 81 70)',
    'lch(54% 107 41)',
    'color(display-p3 1 0.5 0)',
    'color(srgb 0.1 0.2 0.3)',
    'hsl(210 40% 20%)',
  ]
  for (const c of MODERN) {
    it(`refuses ${c} rather than reading its components as sRGB`, () => {
      expect(() => parseRgb(c)).toThrow(/unparseable/)
    })
  }

  const JUNK = ['transparent', 'red', '#111114', '', 'rgb(1, 2)', 'rgb(1, 2, 3, 4, 5)']
  for (const c of JUNK) {
    it(`refuses ${JSON.stringify(c)}`, () => {
      expect(() => parseRgb(c)).toThrow(/unparseable/)
    })
  }

  it('refuses a negative component instead of dropping the sign', () => {
    // The old digit-run regex silently turned -20 into 20.
    expect(() => parseRgb('rgb(17, 17, -20)')).toThrow(/outside \[0, 255\]/)
  })

  it('refuses an out-of-range component', () => {
    expect(() => parseRgb('rgb(17, 17, 300)')).toThrow(/outside \[0, 255\]/)
  })

  it('refuses the CSS Color 4 "none" keyword rather than assuming zero', () => {
    expect(() => parseRgb('rgb(17 17 none)')).toThrow(/not a number/)
  })

  it('reads the CSS Color 4 space-separated form', () => {
    expect(parseRgb('rgb(17 17 20)')).toEqual({ r: 17, g: 17, b: 20, a: 1 })
  })

  it('reads slash alpha', () => {
    expect(parseRgb('rgb(17 17 20 / 0.5)')).toEqual({ r: 17, g: 17, b: 20, a: 0.5 })
  })

  it('reads percentage components', () => {
    expect(parseRgb('rgb(100%, 0%, 0%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
    expect(parseRgb('rgb(17 17 20 / 50%)')).toEqual({ r: 17, g: 17, b: 20, a: 0.5 })
  })

  it('still reads the legacy forms the page actually produces', () => {
    expect(parseRgb('rgb(17, 17, 20)')).toEqual({ r: 17, g: 17, b: 20, a: 1 })
    expect(parseRgb('rgba(0, 0, 0, 0)')).toEqual({ r: 0, g: 0, b: 0, a: 0 })
  })
})

describe('evaluateSamples — sparse chain', () => {
  it('reports a hole as a contract violation, not an incidental TypeError', () => {
    // Round-6 gate finding: `forEach` skips holes, so a sparse chain used to
    // reach the boundary loop and die on `undefined.opacity`.
    const sparse: { color: string; opacity: number }[] = []
    sparse[2] = { color: 'rgb(0, 0, 0)', opacity: 1 }
    expect(() =>
      evaluateSamples({
        raw: [sample({ chain: sparse })],
        scannedTextNodes: 1,
        deviceCards: 1,
        staleCards: 0,
        harnessHeadings: [],
      })
    ).toThrow(/chain\[0\]\.opacity/)
  })
})

describe('COLLECT_IN_PAGE — modern colour syntax end to end', () => {
  it('refuses a modern colour space rather than mis-measuring it', () => {
    // Round-6 gate finding: the fake DOM hard-coded rgb(), so it encoded the
    // same assumption as the parser and could not have exposed this. Driving a
    // modern colour through the real collector proves the pipeline refuses.
    const c = runCollector({ cardBackground: 'oklch(0.21 0.006 285.9)' })
    expect(c.raw[0]!.chain[0]!.color).toBe('oklch(0.21 0.006 285.9)')
    expect(() => evaluateSamples(c)).toThrow(/unparseable colour/)
  })
})

describe('parseRgb — separator grammar', () => {
  // Round-7 gate finding: the tokenizer split on /[\s,]+/, treating commas and
  // whitespace as interchangeable. CSS does not allow mixing them, so these
  // malformed strings were accepted and would have yielded a plausible ratio.
  const MALFORMED = [
    ['empty comma field', 'rgb(1,, 2, 3)'],
    ['whitespace form with a 4th component', 'rgba(1 2 3 0.5)'],
    ['comma form with a slash alpha', 'rgb(1, 2, 3 / 0.5)'],
    ['slash alpha with a stray comma', 'rgb(1 2 3 / ,0.5)'],
    ['mixed separators', 'rgb(1 2, 3)'],
    ['trailing comma', 'rgb(1, 2, 3,)'],
    ['too few comma fields', 'rgb(1, 2)'],
    ['too many comma fields', 'rgb(1, 2, 3, 4, 5)'],
    ['slash with no alpha', 'rgb(1 2 3 / )'],
    ['two slashes', 'rgb(1 2 3 / 0.5 / 0.5)'],
  ] as const

  for (const [label, value] of MALFORMED) {
    it(`refuses ${label}: ${value}`, () => {
      expect(() => parseRgb(value)).toThrow(/unparseable colour/)
    })
  }

  it('still accepts both well-formed grammars unchanged', () => {
    expect(parseRgb('rgb(17, 17, 20)')).toEqual({ r: 17, g: 17, b: 20, a: 1 })
    expect(parseRgb('rgba(34, 197, 94, 0.1)')).toEqual({ r: 34, g: 197, b: 94, a: 0.1 })
    expect(parseRgb('rgb(17 17 20)')).toEqual({ r: 17, g: 17, b: 20, a: 1 })
    expect(parseRgb('rgb(17 17 20 / 0.5)')).toEqual({ r: 17, g: 17, b: 20, a: 0.5 })
    expect(parseRgb('rgb(100%, 0%, 0%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
  })
})
