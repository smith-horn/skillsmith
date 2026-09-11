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
 * SUPPORTED SHAPE: AT MOST ONE opacity-bearing ancestor, and no opacity on the
 * sampled text element itself. Zero is fine and is the current state of the
 * page; one ancestor is what it had before this fix (`.device-card`), and a
 * single accumulated alpha describes that exactly.
 *
 * NOT supported: two or more nested opacity ancestors, OR opacity on the sampled
 * element itself. Each creates its own offscreen composite, and multiplying the
 * alphas to composite once is not equivalent when a background sits between the
 * boundaries.
 *
 * The element's own opacity needs calling out separately because it is the
 * subtler half: `ancestorOpacity()` walks from the element itself, so an
 * element-level opacity lands in the accumulated alpha, while `chain` starts at
 * the parent and never counts it. Counting only chain entries would let an
 * element-plus-ancestor pair through the nesting guard as if it were a single
 * boundary — the exact shape the guard exists to reject. So the collector
 * reports the element's own opacity separately and it is checked on its own.
 *
 * Rather than silently reporting a wrong ratio, `evaluateSamples` detects both
 * shapes and throws — a probe that quietly mis-measures the exact case it guards is worse
 * than one that refuses. Implementing boundary-by-boundary compositing is the
 * fix if the page ever grows a second boundary.
 *
 * Both of those guards are written as `< 1`, which fails OPEN on a malformed
 * value: `undefined < 1` and `NaN < 1` are both false. Since `COLLECT_IN_PAGE`
 * is a string that TypeScript never checks against `RawSample`, a dropped or
 * renamed field would disable the guards silently. So every opacity is
 * contract-checked by `assertOpacity` before either guard runs — see the note
 * on that function.
 */

/** sRGB colour with alpha, 0-255 channels. */
export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/**
 * Parse a computed colour, strictly — legacy sRGB `rgb()` / `rgba()` only.
 *
 * Round-6 gate finding: the previous implementation pulled every digit run out
 * of the string with `/[\d.]+/g` and took the first three as R, G and B. That
 * accepts far more than it can actually interpret. `oklch(0.7 0.1 250)`,
 * `lab(54% 81 70)` and `color(display-p3 1 0.5 0)` all yield three numbers, so
 * they would have been read as sRGB 0-255 and produced a plausible, wrong
 * contrast ratio rather than a refusal. The regex also dropped minus signs, so
 * a negative component silently changed value.
 *
 * None of the site's stylesheets use a modern colour syntax today, so nothing
 * currently hits that path — but Tailwind v4 emits `oklch()` by default, and a
 * probe that quietly mis-measures the moment a stylesheet modernises is the
 * exact failure this module exists to prevent. Refusing is the safe default:
 * an unsupported colour space needs real conversion, not reinterpretation.
 *
 * Accepts both serialisations a browser may emit for sRGB: the legacy
 * comma form (`rgb(17, 17, 20)`, `rgba(17, 17, 20, 0.5)`) and the CSS Color 4
 * space-separated form (`rgb(17 17 20)`, `rgb(17 17 20 / 0.5)`), with
 * percentages allowed on any component. Everything else throws.
 */
export function parseRgb(input: string): Rgba {
  const raw = typeof input === 'string' ? input.trim() : ''
  const fn = /^rgba?\(([^()]*)\)$/i.exec(raw)
  if (!fn) {
    throw new Error(
      `[SMI-6503] unparseable colour: ${JSON.stringify(input)}. Only legacy sRGB ` +
        'rgb()/rgba() serialisation is supported. A modern colour space such as ' +
        'oklch(), lab() or color() needs real conversion — reinterpreting its ' +
        'components as sRGB would report a ratio that is not what renders.'
    )
  }

  // Pick the grammar from the separators actually present. CSS does not allow
  // mixing comma and whitespace forms, so a tokenizer that treats them
  // interchangeably accepts `rgb(1,, 2, 3)`, `rgba(1 2 3 0.5)` and
  // `rgb(1, 2, 3 / 0.5)` — malformed input yielding a plausible ratio, which is
  // the fail-open shape this module exists to reject (round-7 gate finding).
  const body = fn[1]!
  const bad = (why: string): Error =>
    new Error(`[SMI-6503] unparseable colour: ${JSON.stringify(input)} — ${why}.`)

  let channels: string[]
  let alphaToken: string | undefined
  if (body.includes(',')) {
    // Legacy: commas only, 3 or 4 non-empty single-token fields, no slash.
    if (body.includes('/')) throw bad('mixes comma syntax with a "/" alpha')
    const parts = body.split(',').map((p) => p.trim())
    if (parts.length < 3 || parts.length > 4) {
      throw bad(`expected 3 or 4 comma-separated fields, got ${parts.length}`)
    }
    if (parts.some((p) => p === '' || /\s/.test(p))) {
      throw bad('has an empty or whitespace-split comma field')
    }
    channels = parts.slice(0, 3)
    alphaToken = parts[3]
  } else {
    // CSS Color 4: whitespace-separated, with an optional `/ alpha`.
    const slash = body.split('/')
    if (slash.length > 2) throw bad('has multiple "/" separators')
    const head = slash[0]!.trim().split(/\s+/).filter(Boolean)
    if (head.length !== 3) throw bad(`expected 3 colour components, got ${head.length}`)
    channels = head
    if (slash.length === 2) {
      const tail = slash[1]!.trim().split(/\s+/).filter(Boolean)
      if (tail.length !== 1) throw bad('needs exactly one alpha value after "/"')
      alphaToken = tail[0]
    }
  }

  /** One component, as a number in [0, max]. Rejects `none`, signs out of range, junk. */
  const channel = (token: string, max: number, label: string): number => {
    const pct = token.endsWith('%')
    const body = pct ? token.slice(0, -1) : token
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(body)) {
      throw new Error(
        `[SMI-6503] unparseable colour: ${JSON.stringify(input)} — ${label} is ` +
          `${JSON.stringify(token)}, not a number. The CSS Color 4 "none" keyword and ` +
          'other non-numeric components are refused rather than assumed to be zero.'
      )
    }
    const value = pct ? (Number(body) / 100) * max : Number(body)
    if (!Number.isFinite(value) || value < 0 || value > max) {
      throw new Error(
        `[SMI-6503] unparseable colour: ${JSON.stringify(input)} — ${label} resolves to ` +
          `${value}, outside [0, ${max}].`
      )
    }
    return value
  }

  return {
    r: channel(channels[0]!, 255, 'red'),
    g: channel(channels[1]!, 255, 'green'),
    b: channel(channels[2]!, 255, 'blue'),
    a: alphaToken === undefined ? 1 : channel(alphaToken, 1, 'alpha'),
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
      ownOpacity: parseFloat(cs.opacity),
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
  /** Accumulated opacity of the element AND all its ancestors. */
  opacity: number
  /** The element's own opacity alone — not covered by `chain`. */
  ownOpacity: number
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
/**
 * Every opacity the evaluator reads must be a real number in [0, 1].
 *
 * This is a CONTRACT check against the collector, and it is load-bearing
 * because `COLLECT_IN_PAGE` is a STRING evaluated in the page — TypeScript
 * never type-checks it against `RawSample`, so a field it stops emitting is
 * invisible until runtime. Both refusal guards below are written as `< 1`, and
 * JavaScript makes `undefined < 1` and `NaN < 1` BOTH false: a missing or
 * malformed opacity would sail past the guard that exists to catch it and the
 * probe would report a plausible, wrong ratio. That is precisely the
 * silent-mis-measurement failure this whole module exists to prevent, so the
 * contract fails CLOSED rather than open.
 *
 * `typeof` is checked explicitly rather than relying on comparison, because
 * numeric strings coerce: `"0.5" < 1` is true, and a string that reached here
 * means the collector changed shape and should be fixed, not tolerated.
 */
function assertOpacity(value: unknown, label: string, selector: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      `[SMI-6503] contrast probe got ${label}=${JSON.stringify(value)} on "${selector}". ` +
        'Expected a finite number in [0, 1]. COLLECT_IN_PAGE is evaluated as a string and ' +
        'is not type-checked against RawSample, so a renamed or dropped field surfaces ' +
        'only here. Refusing rather than measuring: the opacity guards below compare with ' +
        '"< 1", and undefined < 1 and NaN < 1 are both false, so a malformed value would ' +
        'silently disable them and the reported ratio would not be what renders.'
    )
  }
  return value
}

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
    // Validate the collector contract BEFORE any loop or colour parsing, so a
    // malformed sample can never reach a guard that would silently accept it.
    assertOpacity(s.ownOpacity, 'ownOpacity', s.selector)
    assertOpacity(s.opacity, 'opacity', s.selector)
    if (!Array.isArray(s.chain)) {
      throw new Error(
        `[SMI-6503] contrast probe got a non-array background chain on "${s.selector}". ` +
          'Expected { color, opacity } layers from backgroundChain().'
      )
    }
    // Indexed, NOT forEach: forEach skips holes in a sparse array, so a sparse
    // chain would slip past this contract and die later on an incidental
    // `undefined.opacity` TypeError instead of the diagnostic below.
    for (let i = 0; i < s.chain.length; i++) {
      assertOpacity(s.chain[i]?.opacity, `chain[${i}].opacity`, s.selector)
    }

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
    // The element's own opacity is NOT in `chain` — see the module comment. It
    // must be checked separately or an element-plus-ancestor pair slips through
    // the nesting guard below counting as one boundary.
    if (s.ownOpacity < 1) {
      throw new Error(
        `[SMI-6503] contrast probe found opacity ${s.ownOpacity} on the sampled element ` +
          `"${s.selector}" itself. Only ancestor opacity is supported: the element's own ` +
          'opacity opens a further compositing boundary that this model does not ' +
          'represent, so the ratio would not be what renders. Implement ' +
          'boundary-by-boundary compositing before measuring this page.'
      )
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
