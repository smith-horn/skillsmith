/**
 * WCAG contrast probe for the /account/skills device cards (SMI-6503).
 *
 * Split out from the spec so the maths is unit-testable against fixtures with
 * known ratios. A contrast checker that is only ever exercised by the page it
 * checks has no way to distinguish "the page passes" from "the checker is
 * broken and reports nothing" — which is the failure mode this whole regression
 * is about.
 *
 * The compositing rule is the load-bearing part. `opacity` on an element
 * creates a stacking context: the subtree renders into an offscreen buffer,
 * then the whole buffer is composited at alpha over what sits behind it. So
 * BOTH the text and its own background are blended:
 *
 *   fg_final = a*fg_raw + (1-a)*behind
 *   bg_final = a*bg_raw + (1-a)*behind
 *   ratio    = contrast(fg_final, bg_final)
 *
 * Both blend onto the SAME `behind` — the canvas outside the group. Compositing
 * the text onto the already-blended background instead double-applies the
 * blend and reports a foreground darker than what renders. Scaling only the
 * foreground is wrong in the same direction. Ignoring opacity altogether is
 * wrong in the other, and is exactly how the original bug stayed invisible:
 * every declared colour looked compliant.
 *
 * SUPPORTED SHAPE: exactly ONE opacity-bearing ancestor. That is what this page
 * has ever had (`.device-card`), and a single accumulated alpha describes it
 * exactly.
 *
 * NOT supported: two or more nested opacity ancestors. Each creates its own
 * offscreen composite, and multiplying the alphas to composite once is not
 * equivalent when a background sits between the boundaries. Rather than
 * silently reporting a wrong ratio, `evaluateSamples` detects that shape and
 * throws — a probe that quietly mis-measures the exact case it guards is worse
 * than one that refuses. Implementing boundary-by-boundary compositing is the
 * fix if the page ever grows a second boundary.
 */

/** sRGB colour with alpha, 0-255 channels. */
export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/** Parse `rgb(r, g, b)` / `rgba(r, g, b, a)` as produced by getComputedStyle. */
export function parseRgb(input: string): Rgba {
  const m = input.match(/[\d.]+/g)
  if (!m || m.length < 3) throw new Error(`[SMI-6503] unparseable colour: ${input}`)
  return {
    r: Number(m[0]),
    g: Number(m[1]),
    b: Number(m[2]),
    a: m.length > 3 ? Number(m[3]) : 1,
  }
}

/** Source-over composite of `fg` onto opaque `bg`. */
export function composite(fg: Rgba, bg: Rgba): Rgba {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  }
}

/** WCAG 2.1 relative luminance. */
export function luminance(c: Rgba): number {
  const chan = (v: number): number => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * chan(c.r) + 0.7152 * chan(c.g) + 0.0722 * chan(c.b)
}

/** WCAG 2.1 contrast ratio between two opaque colours. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * AA threshold for the given type size. Large text is >=24px, or >=18.66px when
 * bold (WCAG 2.1 SC 1.4.3).
 */
export function aaThreshold(fontSizePx: number, fontWeight: number): number {
  const isLarge = fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700)
  return isLarge ? 3 : 4.5
}

/** One measured text node. */
export interface ProbeSample {
  selector: string
  text: string
  fg: string
  bg: string
  fontSizePx: number
  fontWeight: number
  ratio: number
  threshold: number
  passes: boolean
}

export interface ProbeResult {
  samples: ProbeSample[]
  scannedTextNodes: number
  staleCards: number
  deviceCards: number
  harnessHeadings: string[]
  worstRatio: number | null
  failures: ProbeSample[]
}

/**
 * The browser-side scan, as a string for `page.evaluate`.
 *
 * Wrapped as a self-invoking expression, NOT a bare arrow function. Playwright
 * evaluates a string argument as an EXPRESSION: `() => {...}` evaluates to the
 * function object, which is not serialisable, so `page.evaluate` resolves
 * undefined and the caller crashes on the first property read rather than
 * anywhere near the actual mistake.
 *
 * Returns raw computed values only — every ratio is computed in Node by
 * `evaluateSamples` below, against the same functions the unit tests exercise.
 * Doing the arithmetic in the page would mean the tested implementation and the
 * running implementation were two different copies.
 */
export const COLLECT_IN_PAGE = `(() => {
  function ancestorOpacity(el) {
    let o = 1, e = el
    while (e) { o *= parseFloat(getComputedStyle(e).opacity); e = e.parentElement }
    return o
  }
  function backgroundChain(el) {
    const layers = []
    let e = el
    while (e) {
      const cs = getComputedStyle(e)
      layers.push({ color: cs.backgroundColor, opacity: parseFloat(cs.opacity) })
      e = e.parentElement
    }
    return layers
  }
  const out = []
  let scanned = 0
  document.querySelectorAll('[data-testid="device-card"] *').forEach((el) => {
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join(' ')
      .trim()
    if (!own) return
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') return
    scanned++
    out.push({
      selector: el.className ? '.' + String(el.className).split(' ')[0] : el.tagName,
      text: own.slice(0, 40),
      color: cs.color,
      fontSizePx: parseFloat(cs.fontSize),
      fontWeight: parseInt(cs.fontWeight, 10) || 400,
      opacity: ancestorOpacity(el),
      chain: backgroundChain(el.parentElement || document.body),
    })
  })
  return {
    raw: out,
    scannedTextNodes: scanned,
    deviceCards: document.querySelectorAll('[data-testid="device-card"]').length,
    staleCards: document.querySelectorAll('.device-card--stale').length,
    harnessHeadings: Array.from(document.querySelectorAll('.harness-heading')).map((h) =>
      h.textContent.trim()
    ),
  }
})()`

interface RawSample {
  selector: string
  text: string
  color: string
  fontSizePx: number
  fontWeight: number
  opacity: number
  chain: { color: string; opacity: number }[]
}

interface RawCollect {
  raw: RawSample[]
  scannedTextNodes: number
  deviceCards: number
  staleCards: number
  harnessHeadings: string[]
}

/** Opaque white page canvas — what the outermost layer composites onto. */
const CANVAS: Rgba = { r: 255, g: 255, b: 255, a: 1 }

/**
 * Fold a raw collection into ratios. Pure — this is what the unit tests drive
 * with synthetic input of known ratio.
 */
export function evaluateSamples(collected: RawCollect): ProbeResult {
  // Name the failure rather than crashing on a property read. The realistic
  // cause is page.evaluate resolving undefined because COLLECT_IN_PAGE stopped
  // being a self-invoking expression — a mistake whose natural symptom is a
  // TypeError pointing at this line instead of at the invocation.
  if (!collected || !Array.isArray(collected.raw)) {
    throw new Error(
      '[SMI-6503] contrast probe collected nothing usable from the page. ' +
        'Expected { raw: [...] }, got: ' +
        JSON.stringify(collected) +
        '. Check that COLLECT_IN_PAGE is a self-invoking expression — ' +
        'page.evaluate treats a string as an expression, so a bare arrow ' +
        'function evaluates to the function itself and serialises to undefined.'
    )
  }
  const samples: ProbeSample[] = collected.raw.map((s) => {
    // `chain` is innermost-first. Find the OUTERMOST ancestor carrying opacity:
    // that element is the stacking-context boundary, and everything outside it
    // is the real backdrop the group composites onto.
    let boundary = -1
    let opacityLayers = 0
    for (let i = s.chain.length - 1; i >= 0; i--) {
      if (s.chain[i]!.opacity < 1) {
        opacityLayers++
        if (boundary === -1) boundary = i
      }
    }
    // Refuse rather than mis-measure. Nested boundaries each composite through
    // their own buffer; collapsing them to one alpha is wrong whenever a
    // background sits between them, and the error is invisible in the output.
    if (opacityLayers > 1) {
      throw new Error(
        `[SMI-6503] contrast probe found ${opacityLayers} nested opacity ancestors on ` +
          `"${s.selector}". Only one is supported: each boundary composites through its ` +
          'own offscreen buffer, so a single accumulated alpha would report a ratio that ' +
          'is not what renders. Implement boundary-by-boundary compositing before ' +
          'measuring this page.'
      )
    }

    // Backdrop: fold the layers OUTSIDE the group, honouring their own
    // opacities. Assuming white here instead would lighten both colours and
    // misreport the ratio — on this page the real backdrop is a near-black
    // body, which is nothing like the canvas.
    let backdrop = CANVAS
    for (let i = s.chain.length - 1; i > boundary; i--) {
      const layer = parseRgb(s.chain[i]!.color)
      backdrop = composite({ ...layer, a: layer.a * s.chain[i]!.opacity }, backdrop)
    }

    // Inside the group, fold the remaining layers WITHOUT their opacities —
    // this is what renders into the offscreen buffer — starting from the
    // backdrop so a translucent inner background still resolves correctly.
    let bgRaw = backdrop
    for (let i = boundary; i >= 0; i--) {
      bgRaw = composite(parseRgb(s.chain[i]!.color), bgRaw)
    }
    const fgRaw = parseRgb(s.color)

    // Composite text and background through the SAME accumulated opacity onto
    // that shared backdrop. Blending the text onto the already-blended
    // background instead double-applies it.
    const op = s.opacity
    const fg = composite({ ...fgRaw, a: fgRaw.a * op }, backdrop)
    const bg = composite({ ...bgRaw, a: op }, backdrop)
    const ratio = contrastRatio(fg, bg)
    const threshold = aaThreshold(s.fontSizePx, s.fontWeight)
    return {
      selector: s.selector,
      text: s.text,
      fg: `rgb(${Math.round(fg.r)}, ${Math.round(fg.g)}, ${Math.round(fg.b)})`,
      bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
      fontSizePx: s.fontSizePx,
      fontWeight: s.fontWeight,
      ratio,
      threshold,
      passes: ratio >= threshold,
    }
  })
  return {
    samples,
    scannedTextNodes: collected.scannedTextNodes,
    staleCards: collected.staleCards,
    deviceCards: collected.deviceCards,
    harnessHeadings: collected.harnessHeadings,
    worstRatio: samples.length ? Math.min(...samples.map((s) => s.ratio)) : null,
    failures: samples.filter((s) => !s.passes),
  }
}

/** Human-readable one-line-per-sample report, for pass and fail alike. */
export function formatReport(r: ProbeResult): string {
  const rows = [...r.samples]
    .sort((a, b) => a.ratio - b.ratio)
    .map(
      (s) =>
        `  ${s.passes ? 'PASS' : 'FAIL'}  ${s.ratio.toFixed(2)} (need ${s.threshold})  ` +
        `${s.selector} ${s.fg} on ${s.bg} ${s.fontSizePx}px  "${s.text}"`
    )
  return [
    `[SMI-6503] scanned=${r.scannedTextNodes} deviceCards=${r.deviceCards} ` +
      `staleCards=${r.staleCards} worst=${r.worstRatio?.toFixed(2) ?? 'n/a'}`,
    `[SMI-6503] harness headings: ${r.harnessHeadings.join(' | ') || '(none)'}`,
    ...rows,
  ].join('\n')
}
